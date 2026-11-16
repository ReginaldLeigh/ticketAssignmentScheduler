/**
 * Pipeline.gs — one assignment run (plan §5), plus the manual actions that change assignments.
 *
 *   lease → checks (config + schema; stop if anything is missing, NEVER create it) → snapshot
 *   → retry earlier Ivanti updates → fetch new Incidents from Ivanti → skip already-assigned
 *   → for each ticket: follow-up? → else rule → else Vertex (stub) / Unrouted Queue
 *   → balance (±1, follow-ups not counted) → save rows (MERGE) → set Owner in Ivanti
 *   → record result → release lease
 */
const PIPELINE_MAX_MS = 4.5 * 60 * 1000;
const PIPELINE_CHUNK = 50;
const CLAIM_TTL_S = 300;

const ASSIGNMENT_ROW_FIELDS = [
  ['ticket_id', 'STRING'], ['ivanti_rec_id', 'STRING'], ['subject', 'STRING'], ['mailbox_id', 'STRING'],
  ['employee_id', 'STRING'], ['routing_method', 'STRING'], ['counts_toward_balance', 'BOOL'],
  ['matched_ticket_id', 'STRING'], ['match_score', 'FLOAT64'], ['rule_id', 'STRING'], ['rule_version', 'INT64'],
  ['config_revision', 'STRING'], ['run_id', 'STRING'], ['dry_run', 'BOOL'], ['assigned_at', 'STRING'],
  ['assigned_by', 'STRING'], ['writeback_status', 'STRING'], ['writeback_attempts', 'INT64'],
  ['writeback_error', 'STRING'], ['ticket_snapshot_json', 'STRING'],
];
const RUN_ROW_FIELDS = [
  ['run_id', 'STRING'], ['trigger_type', 'STRING'], ['triggered_by', 'STRING'], ['run_slot', 'STRING'],
  ['dry_run', 'BOOL'], ['started_at', 'STRING'], ['finished_at', 'STRING'], ['status', 'STRING'],
  ['config_revision', 'STRING'], ['fetched', 'INT64'], ['assigned', 'INT64'], ['follow_ups', 'INT64'],
  ['unrouted', 'INT64'], ['writeback_failures', 'INT64'], ['errors_json', 'STRING'],
];

const Pipeline = {
  tables_() {
    const bq = QUERY_CONFIG.bigQuery;
    return { a: BQ.ref(bq.assignmentsTable).sql, r: BQ.ref(bq.runsTable).sql, q: BQ.ref(bq.vertexQueueTable).sql };
  },

  newRunId_() {
    return 'run_' + Utilities.formatDate(new Date(), Store.tz_(), 'yyyyMMdd_HHmmss') + '_' + Utilities.getUuid().slice(0, 6);
  },

  /**
   * opts: { trigger: 'scheduled'|'manual'|'continuation', triggeredBy, dryRun, runSlot, continuationOf, rng }
   * Returns a summary. status: succeeded | failed | stopped_check_failed | continued | busy | cooldown
   */
  run(opts) {
    opts = opts || {};
    const started = Date.now();
    const runId = Pipeline.newRunId_();
    const summary = { runId: runId, status: 'running', dryRun: !!opts.dryRun, fetched: 0, assigned: 0,
      followUps: 0, unrouted: 0, writebackFailures: 0, errors: [], startedAt: new Date(started).toISOString() };

    if (opts.trigger === 'manual') {
      let cooldown = DEFAULT_SETTINGS.RUN_NOW_COOLDOWN_MIN.value;
      try { cooldown = Config.settings().RUN_NOW_COOLDOWN_MIN; } catch (e) { /* defaults */ }
      const left = Lease.cooldownRemainingMin(cooldown);
      if (left) return { status: 'cooldown', minutesLeft: left };
    }

    const got = Lease.acquire({ runId: runId, startedBy: opts.triggeredBy || 'system', trigger: opts.trigger,
      takeOverRunId: opts.continuationOf || null });
    if (!got.acquired) return { status: 'busy', current: got.current };

    let writeRunRow = false;
    try {
      const check = SchemaCheck.checkAll();
      if (!check.ok) {
        summary.status = 'stopped_check_failed';
        summary.errors = check.config.concat(check.sheets, check.bigQuery);
        writeRunRow = true;
        return summary;
      }
      writeRunRow = true;
      const snapshot = Config.snapshot();
      summary.configRevision = snapshot.revision;
      Pipeline.writeRun_(runId, opts, summary, started, true);

      if (!opts.dryRun) Pipeline.retryWritebacks_(runId, snapshot, summary);

      let tickets = Ivanti.fetchNewIncidents();
      summary.fetched = tickets.length;
      tickets = Pipeline.dedupe_(tickets);
      tickets.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

      const counts = Balancer.loadTodayCounts(snapshot.today);
      const batch = [];
      for (let i = 0; i < tickets.length; i += PIPELINE_CHUNK) {
        if (Date.now() - started > PIPELINE_MAX_MS) {
          Triggers.scheduleContinuation(runId, opts);
          summary.status = 'continued';
          break;
        }
        Lease.renew(runId);
        Pipeline.processChunk_(tickets.slice(i, i + PIPELINE_CHUNK), snapshot, counts, batch, runId, opts, summary);
      }
      if (summary.status === 'running') summary.status = 'succeeded';
    } catch (e) {
      summary.status = 'failed';
      summary.errors.push(String((e && e.message) || e));
      writeRunRow = true;
    } finally {
      summary.finishedAt = new Date().toISOString();
      if (writeRunRow) Pipeline.tryWriteRun_(runId, opts, summary, started, false);
      if (summary.status === 'continued') Lease.renew(runId);
      else Lease.release(runId, true);
    }
    return summary;
  },

  dedupe_(tickets) {
    if (!tickets.length) return tickets;
    const t = Pipeline.tables_();
    const ids = tickets.map((x) => x.ticketId);
    const existing = {};
    for (let i = 0; i < ids.length; i += 1000) {
      BQ.query(SQL.assignmentsExisting(t.a), [BQ.p.stringArray('ids', ids.slice(i, i + 1000))])
        .rows.forEach((r) => { existing[r.ticket_id] = true; });
    }
    const cache = CacheService.getScriptCache();
    const claims = cache.getAll(ids.map((id) => 'claim:' + id)) || {};
    return tickets.filter((x) => !existing[x.ticketId] && !claims['claim:' + x.ticketId]);
  },

  row_(ticket, a, runId, snapshot, opts, user) {
    return {
      ticket_id: ticket.ticketId, ivanti_rec_id: ticket.recId, subject: ticket.subject || '',
      mailbox_id: a.mailboxId || null, employee_id: a.employeeId, routing_method: a.method,
      counts_toward_balance: !!a.counts, matched_ticket_id: a.match ? a.match.matchedTicketId : null,
      match_score: a.match ? Math.round(a.match.score * 1000) / 1000 : null,
      rule_id: a.route && a.route.ruleId ? a.route.ruleId : null,
      rule_version: a.route && a.route.ruleVersion ? a.route.ruleVersion : null,
      config_revision: snapshot.revision, run_id: runId, dry_run: !!(opts && opts.dryRun),
      assigned_at: new Date().toISOString(), assigned_by: user || 'system',
      writeback_status: opts && opts.dryRun ? 'skipped_dry_run' : 'pending', writeback_attempts: 0,
      writeback_error: null, ticket_snapshot_json: JSON.stringify(ticket.fields || {}),
    };
  },

  processChunk_(chunk, snapshot, counts, batch, runId, opts, summary) {
    const t = Pipeline.tables_();
    const history = FollowUp.findInHistory(chunk, snapshot);
    const rows = [], queueRows = [], vertexResults = [];
    const minConf = snapshot.settings.VERTEX_MIN_CONFIDENCE;

    chunk.forEach((ticket) => {
      // 1. Follow-up? (history, then tickets already handled in this run)
      let match = history[ticket.ticketId] || null;
      const inBatch = FollowUp.findInBatch(ticket, batch, snapshot);
      if (inBatch && (!match || inBatch.score >= match.score)) match = inBatch;
      const route = Rules.route(ticket, snapshot);
      if (match && match.employeeId) {
        const owner = snapshot.employeeById[match.employeeId];
        if (owner && owner.active && owner.ivanti_owner_id) {
          const mailboxId = route ? route.mailboxId : (match.mailboxId || null);
          rows.push(Pipeline.row_(ticket, { mailboxId: mailboxId, employeeId: owner.id, method: 'follow_up',
            counts: false, match: match, route: route }, runId, snapshot, opts));
          batch.push({ ticketId: ticket.ticketId, subject: ticket.subject, employeeId: owner.id, mailboxId: mailboxId });
          summary.followUps++;
          return;
        }
        // owner inactive → normal routing (D10)
      }

      // 2. Rule, else Vertex (stub today)
      let mailboxId = route ? route.mailboxId : null;
      let method = 'rule';
      if (!mailboxId) {
        const payload = buildVertexPayload_(ticket, snapshot);
        const v = Vertex.classify(payload);
        if (v && !v.error && v.confidence >= minConf) {
          mailboxId = v.mailboxId; method = 'vertex';
          vertexResults.push({ ticket_id: ticket.ticketId, status: 'classified', result_mailbox_id: v.mailboxId,
            confidence: v.confidence, rationale: v.rationale, expected_version: null });
        } else {
          const status = !v ? 'pending' : (v.error ? 'failed' : 'manual_review');
          queueRows.push({ ticket_id: ticket.ticketId, payload_json: JSON.stringify(payload), status: status, reason: 'no_rule_match' });
          if (v && !v.error) {
            vertexResults.push({ ticket_id: ticket.ticketId, status: 'manual_review', result_mailbox_id: v.mailboxId,
              confidence: v.confidence, rationale: v.rationale, expected_version: null });
          }
          summary.unrouted++;
          return;
        }
      }

      // 3. Balance among today's scheduled employees
      const employeeId = Balancer.pick(mailboxId, Balancer.scheduledEmployees(snapshot, mailboxId), counts, opts.rng);
      if (!employeeId) {
        queueRows.push({ ticket_id: ticket.ticketId, payload_json: JSON.stringify(buildVertexPayload_(ticket, snapshot)),
          status: 'no_one_scheduled', reason: 'no_one_scheduled' });
        summary.unrouted++;
        return;
      }
      Balancer.record(counts, mailboxId, employeeId);
      rows.push(Pipeline.row_(ticket, { mailboxId: mailboxId, employeeId: employeeId, method: method, counts: true,
        route: route }, runId, snapshot, opts));
      batch.push({ ticketId: ticket.ticketId, subject: ticket.subject, employeeId: employeeId, mailboxId: mailboxId });
    });

    // Save rows first (status 'pending'), then update Ivanti, then record the result. If the run
    // stops in between, the next run retries the 'pending' rows.
    if (rows.length) {
      BQ.query(SQL.assignmentsMerge(t.a), [BQ.p.structArray('rows', ASSIGNMENT_ROW_FIELDS, rows)]);
      summary.assigned += rows.length;
      if (!opts.dryRun) {
        const wb = Writeback.send(rows, snapshot, false);
        const updates = rows.map((r) => ({ ticket_id: r.ticket_id, writeback_status: wb[r.ticket_id].status,
          writeback_error: wb[r.ticket_id].error }));
        summary.writebackFailures += updates.filter((u) => u.writeback_status !== 'success').length;
        BQ.query(SQL.assignmentsWritebackUpdate(t.a), [BQ.p.structArray('rows',
          [['ticket_id', 'STRING'], ['writeback_status', 'STRING'], ['writeback_error', 'STRING']], updates)]);
        // Tickets that had been waiting in the queue are now routed.
        Pipeline.setQueueStatus_(rows.map((r) => ({ ticket_id: r.ticket_id, status: 'routed', result_mailbox_id: r.mailbox_id,
          confidence: null, rationale: null, expected_version: null })));
      }
    }
    if (!opts.dryRun) {
      if (queueRows.length) {
        BQ.query(SQL.queueUpsert(t.q), [BQ.p.structArray('rows',
          [['ticket_id', 'STRING'], ['payload_json', 'STRING'], ['status', 'STRING'], ['reason', 'STRING']], queueRows)]);
      }
      if (vertexResults.length) Pipeline.setQueueStatus_(vertexResults);
    }
  },

  setQueueStatus_(rows) {
    if (!rows.length) return 0;
    const t = Pipeline.tables_();
    return BQ.query(SQL.queueSetStatus(t.q), [BQ.p.structArray('rows', [['ticket_id', 'STRING'], ['status', 'STRING'],
      ['result_mailbox_id', 'STRING'], ['confidence', 'FLOAT64'], ['rationale', 'STRING'], ['expected_version', 'INT64']], rows)])
      .numDmlAffectedRows;
  },

  retryWritebacks_(runId, snapshot, summary) {
    const t = Pipeline.tables_();
    const pending = BQ.query(SQL.assignmentsPendingWritebacks(t.a), [
      BQ.p.int64('max_attempts', snapshot.settings.WRITEBACK_MAX_ATTEMPTS), BQ.p.string('current_run_id', runId)]).rows;
    if (!pending.length) return;
    const wb = Writeback.send(pending, snapshot, false);
    const updates = pending.map((r) => ({ ticket_id: r.ticket_id, writeback_status: wb[r.ticket_id].status, writeback_error: wb[r.ticket_id].error }));
    summary.writebackFailures += updates.filter((u) => u.writeback_status !== 'success').length;
    BQ.query(SQL.assignmentsWritebackUpdate(t.a), [BQ.p.structArray('rows',
      [['ticket_id', 'STRING'], ['writeback_status', 'STRING'], ['writeback_error', 'STRING']], updates)]);
  },

  runRow_(runId, opts, summary, started, isStart) {
    return {
      run_id: runId, trigger_type: opts.trigger || 'manual', triggered_by: opts.triggeredBy || 'system',
      run_slot: opts.runSlot || null, dry_run: !!opts.dryRun, started_at: new Date(started).toISOString(),
      finished_at: isStart ? null : (summary.finishedAt || new Date().toISOString()),
      status: isStart ? 'running' : summary.status, config_revision: summary.configRevision || null,
      fetched: summary.fetched, assigned: summary.assigned, follow_ups: summary.followUps, unrouted: summary.unrouted,
      writeback_failures: summary.writebackFailures,
      errors_json: summary.errors.length ? JSON.stringify(summary.errors.slice(0, 50)) : null,
    };
  },

  writeRun_(runId, opts, summary, started, isStart) {
    const t = Pipeline.tables_();
    BQ.query(SQL.runsUpsert(t.r), [BQ.p.structArray('rows', RUN_ROW_FIELDS, [Pipeline.runRow_(runId, opts, summary, started, isStart)])]);
  },

  tryWriteRun_(runId, opts, summary, started, isStart) {
    try { Pipeline.writeRun_(runId, opts, summary, started, isStart); } catch (e) {
      console.warn('Could not record run ' + runId + ': ' + e.message);
    }
    PropertiesService.getScriptProperties().setProperty('last_run_summary', JSON.stringify(summary).slice(0, 8000));
  },

  /* ─────────────────────────────── Status for the Runs page ─────────────────────────────── */

  status() {
    const out = { lease: Lease.current(), lastFinishedAt: Lease.lastFinishedAt(), lastCheck: SchemaCheck.last(), recentRuns: [], runsError: null };
    try { out.lastSummary = JSON.parse(PropertiesService.getScriptProperties().getProperty('last_run_summary') || 'null'); } catch (e) { out.lastSummary = null; }
    try {
      const t = Pipeline.tables_();
      out.recentRuns = BQ.query(SQL.runsRecent(t.r), [BQ.p.int64('limit', 25)]).rows;
    } catch (e) { out.runsError = e.message; }
    return out;
  },

  /* ─────────────────────────────── Manual actions (admins) ─────────────────────────────── */

  /** Claim a ticket so a run skips it; refused while a run is in progress (§6.8). */
  withClaim_(ticketId, user, fn) {
    Store.withLock(() => {
      const cur = Lease.current();
      if (cur) throw new BusyError('An assignment run is in progress (started by ' + cur.startedBy + '). Try again in a minute.');
      const cache = CacheService.getScriptCache();
      if (cache.get('claim:' + ticketId)) throw new BusyError('Someone else is changing this ticket right now. Try again in a moment.');
      cache.put('claim:' + ticketId, user, CLAIM_TTL_S);
    });
    try { return fn(); } finally { CacheService.getScriptCache().remove('claim:' + ticketId); }
  },

  getAssignment_(ticketId) {
    const t = Pipeline.tables_();
    const rows = BQ.query(SQL.assignmentsGet(t.a), [BQ.p.string('ticket_id', ticketId)]).rows;
    return rows[0] || null;
  },

  reassign(ticketId, employeeId, expectedVersion, user) {
    return Pipeline.withClaim_(ticketId, user, () => {
      const snapshot = Config.snapshot();
      const emp = snapshot.employeeById[employeeId];
      if (!emp || !emp.active) throw new ValidationError('Choose an active employee.');
      if (!emp.ivanti_owner_id) throw new ValidationError(emp.display_name + ' has no Ivanti owner ID in the Roster.');
      const cur = Pipeline.getAssignment_(ticketId);
      if (!cur) throw new NotFoundError('Ticket ' + ticketId + ' has no assignment.');
      if (Number(cur.version) !== Number(expectedVersion)) {
        throw new ConflictError('This ticket was changed by someone else.', { current: cur });
      }
      const t = Pipeline.tables_();
      const res = BQ.query(SQL.assignmentsReassign(t.a), [BQ.p.string('ticket_id', ticketId), BQ.p.int64('expected_version', expectedVersion),
        BQ.p.string('employee_id', employeeId), BQ.p.string('assigned_by', user)]);
      if (res.numDmlAffectedRows !== 1) throw new ConflictError('This ticket was changed by someone else.', { current: Pipeline.getAssignment_(ticketId) });
      const row = { ticket_id: ticketId, ivanti_rec_id: cur.ivanti_rec_id, employee_id: employeeId, mailbox_id: cur.mailbox_id };
      const wb = Writeback.send([row], snapshot, false)[ticketId];
      BQ.query(SQL.assignmentsWritebackUpdate(t.a), [BQ.p.structArray('rows',
        [['ticket_id', 'STRING'], ['writeback_status', 'STRING'], ['writeback_error', 'STRING']],
        [{ ticket_id: ticketId, writeback_status: wb.status, writeback_error: wb.error }])]);
      return { ticketId: ticketId, employeeId: employeeId, writeback: wb };
    });
  },

  retryWriteback(ticketId, user) {
    return Pipeline.withClaim_(ticketId, user, () => {
      const snapshot = Config.snapshot();
      const cur = Pipeline.getAssignment_(ticketId);
      if (!cur) throw new NotFoundError('Ticket ' + ticketId + ' has no assignment.');
      const wb = Writeback.send([cur], snapshot, false)[ticketId];
      const t = Pipeline.tables_();
      BQ.query(SQL.assignmentsWritebackUpdate(t.a), [BQ.p.structArray('rows',
        [['ticket_id', 'STRING'], ['writeback_status', 'STRING'], ['writeback_error', 'STRING']],
        [{ ticket_id: ticketId, writeback_status: wb.status, writeback_error: wb.error }])]);
      return wb;
    });
  },

  listQueue(statuses) {
    const t = Pipeline.tables_();
    return BQ.query(SQL.queueList(t.q), [BQ.p.stringArray('statuses', statuses)]).rows;
  },

  /** Admin picks a mailbox (and optionally an employee) for an unrouted ticket. */
  resolveQueue(ticketId, mailboxId, employeeId, expectedVersion, user) {
    return Pipeline.withClaim_(ticketId, user, () => {
      const snapshot = Config.snapshot();
      const mb = snapshot.mailboxById[mailboxId];
      if (!mb || !mb.active) throw new ValidationError('Choose an active mailbox.');
      const item = Pipeline.listQueue(['pending', 'no_one_scheduled', 'failed', 'manual_review', 'classified'])
        .find((q) => q.ticket_id === ticketId);
      if (!item) throw new NotFoundError('This ticket is no longer in the queue.');
      if (Number(item.version) !== Number(expectedVersion)) throw new ConflictError('This ticket was changed by someone else.', { current: item });
      let empId = employeeId;
      let counts = true;
      if (empId) {
        const emp = snapshot.employeeById[empId];
        if (!emp || !emp.active || !emp.ivanti_owner_id) throw new ValidationError('Choose an active employee with an Ivanti owner ID.');
      } else {
        const todayCounts = Balancer.loadTodayCounts(snapshot.today);
        empId = Balancer.pick(mailboxId, Balancer.scheduledEmployees(snapshot, mailboxId), todayCounts);
        if (!empId) throw new ValidationError('No one is scheduled on ' + mb.name + ' today. Choose an employee.');
      }
      const affected = Pipeline.setQueueStatus_([{ ticket_id: ticketId, status: 'resolved_manually', result_mailbox_id: mailboxId,
        confidence: null, rationale: null, expected_version: Number(expectedVersion) }]);
      if (affected !== 1) throw new ConflictError('This ticket was changed by someone else.');
      let payload = {};
      try { payload = JSON.parse(item.payload_json || '{}'); } catch (e) { payload = {}; }
      const ticket = { ticketId: ticketId, recId: payload.ivanti_rec_id, subject: payload.subject || '', fields: payload.fields || {} };
      const row = Pipeline.row_(ticket, { mailboxId: mailboxId, employeeId: empId, method: 'manual', counts: counts },
        null, snapshot, { dryRun: false }, user);
      const t = Pipeline.tables_();
      BQ.query(SQL.assignmentsMerge(t.a), [BQ.p.structArray('rows', ASSIGNMENT_ROW_FIELDS, [row])]);
      const wb = Writeback.send([row], snapshot, false)[ticketId];
      BQ.query(SQL.assignmentsWritebackUpdate(t.a), [BQ.p.structArray('rows',
        [['ticket_id', 'STRING'], ['writeback_status', 'STRING'], ['writeback_error', 'STRING']],
        [{ ticket_id: ticketId, writeback_status: wb.status, writeback_error: wb.error }])]);
      return { ticketId: ticketId, mailboxId: mailboxId, employeeId: empId, writeback: wb };
    });
  },

  /** Re-try pending vertex_queue rows (after classifyTicket_ is implemented). */
  processQueue(opts) {
    const runId = Pipeline.newRunId_();
    const got = Lease.acquire({ runId: runId, startedBy: (opts && opts.triggeredBy) || 'system', trigger: 'vertex_queue' });
    if (!got.acquired) return { status: 'busy', current: got.current };
    const result = { classified: 0, assigned: 0, stillPending: 0 };
    try {
      const snapshot = Config.snapshot();
      const counts = Balancer.loadTodayCounts(snapshot.today);
      const rows = [], statuses = [];
      Pipeline.listQueue(['pending']).forEach((item) => {
        let payload;
        try { payload = JSON.parse(item.payload_json); } catch (e) { return; }
        payload.candidate_mailboxes = snapshot.mailboxes.map((m) => ({ mailbox_id: m.id, name: m.name, description: m.description || '' }));
        const v = Vertex.classify(payload);
        if (!v) { result.stillPending++; return; }
        if (v.error || v.confidence < snapshot.settings.VERTEX_MIN_CONFIDENCE) {
          statuses.push({ ticket_id: item.ticket_id, status: v.error ? 'failed' : 'manual_review', result_mailbox_id: v.mailboxId || null,
            confidence: v.confidence || null, rationale: v.rationale || v.error || null, expected_version: Number(item.version) });
          return;
        }
        result.classified++;
        const empId = Balancer.pick(v.mailboxId, Balancer.scheduledEmployees(snapshot, v.mailboxId), counts);
        if (!empId) {
          statuses.push({ ticket_id: item.ticket_id, status: 'no_one_scheduled', result_mailbox_id: v.mailboxId, confidence: v.confidence,
            rationale: v.rationale, expected_version: Number(item.version) });
          return;
        }
        Balancer.record(counts, v.mailboxId, empId);
        const ticket = { ticketId: item.ticket_id, recId: payload.ivanti_rec_id, subject: payload.subject || '', fields: payload.fields || {} };
        rows.push(Pipeline.row_(ticket, { mailboxId: v.mailboxId, employeeId: empId, method: 'vertex', counts: true }, runId, snapshot, { dryRun: false }));
        statuses.push({ ticket_id: item.ticket_id, status: 'routed', result_mailbox_id: v.mailboxId, confidence: v.confidence,
          rationale: v.rationale, expected_version: Number(item.version) });
      });
      const t = Pipeline.tables_();
      if (rows.length) {
        BQ.query(SQL.assignmentsMerge(t.a), [BQ.p.structArray('rows', ASSIGNMENT_ROW_FIELDS, rows)]);
        const wb = Writeback.send(rows, snapshot, false);
        BQ.query(SQL.assignmentsWritebackUpdate(t.a), [BQ.p.structArray('rows',
          [['ticket_id', 'STRING'], ['writeback_status', 'STRING'], ['writeback_error', 'STRING']],
          rows.map((r) => ({ ticket_id: r.ticket_id, writeback_status: wb[r.ticket_id].status, writeback_error: wb[r.ticket_id].error })))]);
        result.assigned = rows.length;
      }
      Pipeline.setQueueStatus_(statuses);
    } finally {
      Lease.release(runId, false);
    }
    return result;
  },
};
