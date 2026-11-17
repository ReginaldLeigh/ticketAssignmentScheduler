/**
 * Pipeline.gs — one assignment run for ONE team (change request §6), plus manual actions.
 *
 *   lease → checks (stop if anything is missing; NEVER create it) → link unlinked employees in Ivanti
 *   → snapshot → retry earlier Ivanti updates → fetch new Incidents → skip already-assigned
 *   → for each ticket:
 *       1. rules, team by team in TEAMS order (the team and mailbox)
 *       2. follow-up within that team (owner gets it, even if not scheduled; not counted)
 *       3. otherwise balance (±1) among the team's scheduled, Ivanti-linked people
 *       4. no rule matched → follow-up in any team's history → joins that team (A9)
 *       5. still nothing → Vertex among rule-less mailboxes (A3)
 *       6. otherwise → SHARED queue (team unknown) · team known but nobody available → TEAM queue
 *   → only tickets that land in the team being run are assigned; others wait for their team's run
 *   → save rows (MERGE) → set Owner in Ivanti → record result → release lease
 */
const PIPELINE_MAX_MS = 4.5 * 60 * 1000;
const PIPELINE_CHUNK = 50;
const CLAIM_TTL_S = 300;
const OPEN_QUEUE_STATUSES = ['pending', 'no_one_scheduled', 'no_linked_employee', 'failed', 'manual_review', 'classified'];

const ASSIGNMENT_ROW_FIELDS = [
  ['ticket_id', 'STRING'], ['team_id', 'STRING'], ['ivanti_rec_id', 'STRING'], ['subject', 'STRING'], ['mailbox_id', 'STRING'],
  ['employee_id', 'STRING'], ['routing_method', 'STRING'], ['counts_toward_balance', 'BOOL'],
  ['matched_ticket_id', 'STRING'], ['match_score', 'FLOAT64'], ['rule_id', 'STRING'], ['rule_version', 'INT64'],
  ['config_revision', 'STRING'], ['run_id', 'STRING'], ['dry_run', 'BOOL'], ['assigned_at', 'STRING'],
  ['assigned_by', 'STRING'], ['writeback_status', 'STRING'], ['writeback_attempts', 'INT64'],
  ['writeback_error', 'STRING'], ['ticket_snapshot_json', 'STRING'],
];
const RUN_ROW_FIELDS = [
  ['run_id', 'STRING'], ['team_id', 'STRING'], ['trigger_type', 'STRING'], ['triggered_by', 'STRING'], ['run_slot', 'STRING'],
  ['dry_run', 'BOOL'], ['started_at', 'STRING'], ['finished_at', 'STRING'], ['status', 'STRING'],
  ['config_revision', 'STRING'], ['fetched', 'INT64'], ['assigned', 'INT64'], ['follow_ups', 'INT64'],
  ['unrouted', 'INT64'], ['writeback_failures', 'INT64'], ['errors_json', 'STRING'],
];
const QUEUE_ROW_FIELDS = [['ticket_id', 'STRING'], ['team_id', 'STRING'], ['payload_json', 'STRING'], ['status', 'STRING'], ['reason', 'STRING']];
const QUEUE_STATUS_FIELDS = [['ticket_id', 'STRING'], ['status', 'STRING'], ['result_mailbox_id', 'STRING'], ['confidence', 'FLOAT64'],
  ['rationale', 'STRING'], ['expected_version', 'INT64']];
const WRITEBACK_FIELDS = [['ticket_id', 'STRING'], ['writeback_status', 'STRING'], ['writeback_error', 'STRING']];

const Pipeline = {
  tables_() {
    const bq = QUERY_CONFIG.bigQuery;
    return { a: BQ.ref(bq.assignmentsTable).sql, r: BQ.ref(bq.runsTable).sql, q: BQ.ref(bq.vertexQueueTable).sql };
  },

  newRunId_() {
    return 'run_' + Utilities.formatDate(new Date(), Store.tz_(), 'yyyyMMdd_HHmmss') + '_' + Utilities.getUuid().slice(0, 6);
  },

  /**
   * opts: { teamId, trigger: 'scheduled'|'manual'|'continuation', triggeredBy, dryRun, runSlot, continuationOf, rng }
   * Returns a summary. status: succeeded | failed | stopped_check_failed | continued | busy | cooldown
   */
  run(opts) {
    opts = opts || {};
    if (!opts.teamId || !Config.team(opts.teamId)) throw new ValidationError('Unknown team.');
    const started = Date.now();
    const runId = Pipeline.newRunId_();
    const summary = { runId: runId, teamId: opts.teamId, teamName: Config.teamName(opts.teamId), status: 'running',
      dryRun: !!opts.dryRun, fetched: 0, assigned: 0, followUps: 0, unrouted: 0, otherTeams: 0, writebackFailures: 0,
      unlinkedScheduled: [], errors: [], startedAt: new Date(started).toISOString() };

    if (opts.trigger === 'manual') {
      const left = Lease.cooldownRemainingMin(DEVELOPER_SETTINGS.RUN_NOW_COOLDOWN_MIN, opts.teamId);
      if (left) return { status: 'cooldown', minutesLeft: left };
    }

    const got = Lease.acquire({ runId: runId, startedBy: opts.triggeredBy || 'system', trigger: opts.trigger,
      teamId: opts.teamId, takeOverRunId: opts.continuationOf || null });
    if (!got.acquired) return { status: 'busy', current: Pipeline.describeLease_(got.current) };

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
      Pipeline.relink_(opts.teamId);
      const snapshot = Config.snapshot();
      summary.configRevision = snapshot.revision;
      summary.unlinkedScheduled = Pipeline.unlinkedScheduled_(snapshot, opts.teamId);
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
      else Lease.release(runId, true, opts.teamId);
    }
    return summary;
  },

  describeLease_(l) {
    return l ? { startedBy: l.startedBy, startedAt: l.startedAt, trigger: l.trigger, teamId: l.teamId, teamName: Config.teamName(l.teamId) } : null;
  },

  /**
   * Look up Ivanti IDs for the team's active employees who aren't linked yet. Lookups happen
   * OUTSIDE the lock; only changed statuses are saved (no change-history noise every run).
   */
  relink_(teamId) {
    if (!(QUERY_CONFIG.ivanti.employeeLookup || {}).enabled) return 0;
    const pending = Store.read('Employees', { teamId: teamId }).filter((e) => e.active && !e.ivanti_owner_id);
    if (!pending.length) return 0;
    const results = pending.map((e) => ({ e: e, r: IvantiLookup.resolve(e.employee_email) }));
    const now = new Date().toISOString();
    let linked = 0;
    Store.mutate({ user: 'system', teamId: teamId }, (tx) => {
      results.forEach((x) => {
        const cur = tx.find('Employees', x.e.id);
        if (!cur || cur.employee_email !== x.e.employee_email || cur.ivanti_owner_id) return;
        if (x.r.status === 'found') linked++;
        if (x.r.status === cur.ivanti_lookup_status && x.r.status !== 'found') return;
        tx.update('Employees', cur.id, { ivanti_owner_id: x.r.id || '', ivanti_lookup_status: x.r.status, ivanti_checked_at: now }, null, 'ivanti_lookup');
      });
    });
    return linked;
  },

  /** Names of the team's people scheduled today who can't receive tickets (not linked to Ivanti). */
  unlinkedScheduled_(snapshot, teamId) {
    const seen = {};
    snapshot.scheduleToday.forEach((e) => {
      const emp = snapshot.employeeById[e.employee_id];
      if (emp && emp.active && emp.team_id === teamId && !emp.ivanti_owner_id) seen[emp.id] = emp.display_name;
    });
    return Object.keys(seen).map((k) => seen[k]).sort();
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
      ticket_id: ticket.ticketId, team_id: a.teamId, ivanti_rec_id: ticket.recId, subject: ticket.subject || '',
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

  processChunk_(chunk, snap, counts, batch, runId, opts, summary) {
    const t = Pipeline.tables_();
    const runTeam = opts.teamId;
    const minConf = snap.dev.VERTEX_MIN_CONFIDENCE;
    const routed = chunk.map((ticket) => ({ ticket: ticket, route: Rules.route(ticket, snap) }));

    // One history query per team: tickets routed to it, plus tickets no rule matched.
    const hist = {};
    snap.teams.forEach((team) => {
      const list = routed.filter((r) => !r.route || r.route.teamId === team.id).map((r) => r.ticket);
      hist[team.id] = list.length ? FollowUp.findInHistory(list, snap, team.id) : {};
    });
    const better = (a, b) => (!a ? b : !b ? a : (b.score >= a.score ? b : a));   // ties → this run's (more recent)
    const ownerOf = (m, teamId) => {
      if (!m || !m.employeeId) return null;
      const e = snap.employeeById[m.employeeId];
      return e && e.team_id === teamId && Balancer.isLinked(e) ? e : null;
    };

    const rows = [], queueRows = [], vertexResults = [];
    const remember = (ticket, teamId, employeeId, mailboxId) =>
      batch.push({ ticketId: ticket.ticketId, subject: ticket.subject, teamId: teamId, employeeId: employeeId, mailboxId: mailboxId });

    const followUp = (ticket, teamId, mailboxId, owner, match, route) => {
      rows.push(Pipeline.row_(ticket, { teamId: teamId, mailboxId: mailboxId, employeeId: owner.id, method: 'follow_up',
        counts: false, match: match, route: route }, runId, snap, opts));
      remember(ticket, teamId, owner.id, mailboxId);
      summary.followUps++;
    };
    const balanceOrQueue = (ticket, teamId, mailboxId, method, route) => {
      const info = Balancer.scheduledInfo(snap, mailboxId);
      const employeeId = Balancer.pick(mailboxId, info.linked, counts, opts.rng);
      if (!employeeId) {
        const reason = info.unlinked.length ? 'no_linked_employee' : 'no_one_scheduled';
        queueRows.push({ ticket_id: ticket.ticketId, team_id: teamId, payload_json: JSON.stringify(buildVertexPayload_(ticket, snap)),
          status: reason, reason: reason });
        summary.unrouted++;
        return;
      }
      Balancer.record(counts, mailboxId, employeeId);
      rows.push(Pipeline.row_(ticket, { teamId: teamId, mailboxId: mailboxId, employeeId: employeeId, method: method, counts: true,
        route: route }, runId, snap, opts));
      remember(ticket, teamId, employeeId, mailboxId);
    };

    routed.forEach((r) => {
      const ticket = r.ticket, route = r.route;
      if (route) {
        if (route.teamId !== runTeam) { summary.otherTeams++; return; }
        const match = better(hist[route.teamId][ticket.ticketId], FollowUp.findInBatch(ticket, batch, snap, route.teamId));
        const owner = ownerOf(match, route.teamId);
        if (owner) { followUp(ticket, route.teamId, route.mailboxId, owner, match, route); return; }
        balanceOrQueue(ticket, route.teamId, route.mailboxId, 'rule', route);
        return;
      }
      // No rule matched: a follow-up of any team's ticket joins that team (A9). Earlier teams win ties.
      let best = null;
      snap.teams.forEach((team) => {
        const m = better(hist[team.id][ticket.ticketId], FollowUp.findInBatch(ticket, batch, snap, team.id));
        if (m && ownerOf(m, team.id) && (!best || m.score > best.score)) best = m;
      });
      if (best) {
        if (best.teamId !== runTeam) { summary.otherTeams++; return; }
        const mb = snap.mailboxById[best.mailboxId];
        const mailboxId = mb && mb.active && mb.team_id === best.teamId ? mb.id : null;
        followUp(ticket, best.teamId, mailboxId, ownerOf(best, best.teamId), best, null);
        return;
      }
      // Vertex chooses among rule-less mailboxes (A3); not called if there are none.
      const payload = buildVertexPayload_(ticket, snap);
      const v = payload.candidate_mailboxes.length ? Vertex.classify(payload) : null;
      if (v && !v.error && v.confidence >= minConf) {
        const mb = snap.mailboxById[v.mailboxId];
        if (mb.team_id !== runTeam) { summary.otherTeams++; return; }
        vertexResults.push({ ticket_id: ticket.ticketId, status: 'classified', result_mailbox_id: v.mailboxId,
          confidence: v.confidence, rationale: v.rationale, expected_version: null });
        balanceOrQueue(ticket, mb.team_id, mb.id, 'vertex', null);
        return;
      }
      // Nobody can place it → SHARED queue (team_id empty), visible to every team.
      queueRows.push({ ticket_id: ticket.ticketId, team_id: null, payload_json: JSON.stringify(payload),
        status: !v ? 'pending' : (v.error ? 'failed' : 'manual_review'), reason: 'no_rule_match' });
      if (v && !v.error) {
        vertexResults.push({ ticket_id: ticket.ticketId, status: 'manual_review', result_mailbox_id: v.mailboxId,
          confidence: v.confidence, rationale: v.rationale, expected_version: null });
      }
      summary.unrouted++;
    });

    // Save rows first (status 'pending'), then update Ivanti, then record the result.
    if (rows.length) {
      BQ.query(SQL.assignmentsMerge(t.a), [BQ.p.structArray('rows', ASSIGNMENT_ROW_FIELDS, rows)]);
      summary.assigned += rows.length;
    }
    if (opts.dryRun) return;
    if (queueRows.length) BQ.query(SQL.queueUpsert(t.q), [BQ.p.structArray('rows', QUEUE_ROW_FIELDS, queueRows)]);
    if (vertexResults.length) Pipeline.setQueueStatus_(vertexResults);
    if (rows.length) {
      const wb = Writeback.send(rows, snap, false);
      const updates = rows.map((x) => ({ ticket_id: x.ticket_id, writeback_status: wb[x.ticket_id].status, writeback_error: wb[x.ticket_id].error }));
      summary.writebackFailures += updates.filter((u) => u.writeback_status !== 'success').length;
      BQ.query(SQL.assignmentsWritebackUpdate(t.a), [BQ.p.structArray('rows', WRITEBACK_FIELDS, updates)]);
      Pipeline.setQueueStatus_(rows.map((x) => ({ ticket_id: x.ticket_id, status: 'routed', result_mailbox_id: x.mailbox_id,
        confidence: null, rationale: null, expected_version: null })));
    }
  },

  setQueueStatus_(rows) {
    if (!rows.length) return 0;
    const t = Pipeline.tables_();
    return BQ.query(SQL.queueSetStatus(t.q), [BQ.p.structArray('rows', QUEUE_STATUS_FIELDS, rows)]).numDmlAffectedRows;
  },

  retryWritebacks_(runId, snapshot, summary) {
    const t = Pipeline.tables_();
    const pending = BQ.query(SQL.assignmentsPendingWritebacks(t.a), [
      BQ.p.int64('max_attempts', snapshot.dev.WRITEBACK_MAX_ATTEMPTS), BQ.p.string('current_run_id', runId)]).rows;
    if (!pending.length) return;
    const wb = Writeback.send(pending, snapshot, false);
    const updates = pending.map((r) => ({ ticket_id: r.ticket_id, writeback_status: wb[r.ticket_id].status, writeback_error: wb[r.ticket_id].error }));
    summary.writebackFailures += updates.filter((u) => u.writeback_status !== 'success').length;
    BQ.query(SQL.assignmentsWritebackUpdate(t.a), [BQ.p.structArray('rows', WRITEBACK_FIELDS, updates)]);
  },

  runRow_(runId, opts, summary, started, isStart) {
    return {
      run_id: runId, team_id: opts.teamId, trigger_type: opts.trigger || 'manual', triggered_by: opts.triggeredBy || 'system',
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
    PropertiesService.getScriptProperties().setProperty('last_run_summary:' + opts.teamId, JSON.stringify(summary).slice(0, 8000));
  },

  /* ─────────────────────────────── Status for the Runs page ─────────────────────────────── */

  status(teamId) {
    const out = { lease: Pipeline.describeLease_(Lease.current()), lastFinishedAt: Lease.lastFinishedAt(teamId),
      lastCheck: SchemaCheck.last(), recentRuns: [], runsError: null };
    try { out.lastSummary = JSON.parse(PropertiesService.getScriptProperties().getProperty('last_run_summary:' + teamId) || 'null'); } catch (e) { out.lastSummary = null; }
    try {
      const t = Pipeline.tables_();
      out.recentRuns = BQ.query(SQL.runsRecent(t.r), [BQ.p.string('team_id', teamId), BQ.p.int64('limit', 25)]).rows;
    } catch (e) { out.runsError = e.message; }
    return out;
  },

  /* ─────────────────────────────── Manual actions (managers and admins) ─────────────────────────────── */

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

  getAssignment_(ticketId, teamId) {
    const t = Pipeline.tables_();
    const rows = BQ.query(SQL.assignmentsGet(t.a), [BQ.p.string('ticket_id', ticketId), BQ.p.string('team_id', teamId)]).rows;
    return rows[0] || null;
  },

  teamEmployee_(snapshot, employeeId, teamId) {
    const emp = snapshot.employeeById[employeeId];
    if (!emp || !emp.active || emp.team_id !== teamId) throw new ValidationError('Choose an active member of your team.');
    if (!emp.ivanti_owner_id) throw new ValidationError(emp.display_name + " isn't linked to Ivanti yet, so they can't receive tickets.");
    return emp;
  },

  writebackOne_(row, snapshot) {
    const t = Pipeline.tables_();
    const wb = Writeback.send([row], snapshot, false)[row.ticket_id];
    BQ.query(SQL.assignmentsWritebackUpdate(t.a), [BQ.p.structArray('rows', WRITEBACK_FIELDS,
      [{ ticket_id: row.ticket_id, writeback_status: wb.status, writeback_error: wb.error }])]);
    return wb;
  },

  reassign(ctx, ticketId, employeeId, expectedVersion) {
    return Pipeline.withClaim_(ticketId, ctx.user, () => {
      const snapshot = Config.snapshot();
      Pipeline.teamEmployee_(snapshot, employeeId, ctx.teamId);
      const cur = Pipeline.getAssignment_(ticketId, ctx.teamId);
      if (!cur) throw new NotFoundError('Ticket ' + ticketId + ' has no assignment in your team.');
      if (Number(cur.version) !== Number(expectedVersion)) throw new ConflictError('This ticket was changed by someone else.', { current: cur });
      const t = Pipeline.tables_();
      const res = BQ.query(SQL.assignmentsReassign(t.a), [BQ.p.string('ticket_id', ticketId), BQ.p.string('team_id', ctx.teamId),
        BQ.p.int64('expected_version', expectedVersion), BQ.p.string('employee_id', employeeId), BQ.p.string('assigned_by', ctx.user)]);
      if (res.numDmlAffectedRows !== 1) throw new ConflictError('This ticket was changed by someone else.', { current: Pipeline.getAssignment_(ticketId, ctx.teamId) });
      const wb = Pipeline.writebackOne_({ ticket_id: ticketId, ivanti_rec_id: cur.ivanti_rec_id, employee_id: employeeId, mailbox_id: cur.mailbox_id }, snapshot);
      return { ticketId: ticketId, employeeId: employeeId, writeback: wb };
    });
  },

  retryWriteback(ctx, ticketId) {
    return Pipeline.withClaim_(ticketId, ctx.user, () => {
      const snapshot = Config.snapshot();
      const cur = Pipeline.getAssignment_(ticketId, ctx.teamId);
      if (!cur) throw new NotFoundError('Ticket ' + ticketId + ' has no assignment in your team.');
      return Pipeline.writebackOne_(cur, snapshot);
    });
  },

  /** { team: [team queue items], shared: [shared queue items] } for one team (raw rows; WebApp trims fields). */
  listQueues(teamId) {
    const t = Pipeline.tables_();
    const rows = BQ.query(SQL.queueList(t.q), [BQ.p.stringArray('statuses', OPEN_QUEUE_STATUSES), BQ.p.string('team_id', teamId),
      BQ.p.bool('include_shared', true), BQ.p.bool('all_teams', false)]).rows;
    return { team: rows.filter((r) => r.team_id === teamId), shared: rows.filter((r) => !r.team_id) };
  },

  /**
   * Take a ticket from the team queue or the shared queue into one of the caller's mailboxes.
   * The first team to claim a shared ticket wins; later attempts are told who took it.
   */
  resolveQueue(ctx, ticketId, mailboxId, employeeId, expectedVersion) {
    return Pipeline.withClaim_(ticketId, ctx.user, () => {
      const snapshot = Config.snapshot();
      const mb = snapshot.mailboxById[mailboxId];
      if (!mb || !mb.active || mb.team_id !== ctx.teamId) throw new ValidationError("Choose one of your team's active mailboxes.");
      const t = Pipeline.tables_();
      const item = BQ.query(SQL.queueList(t.q), [BQ.p.stringArray('statuses', OPEN_QUEUE_STATUSES.concat(['resolved_manually', 'routed'])),
        BQ.p.string('team_id', ctx.teamId), BQ.p.bool('include_shared', true), BQ.p.bool('all_teams', true)]).rows
        .find((q) => q.ticket_id === ticketId);
      if (!item || (item.team_id && item.team_id !== ctx.teamId && !item.claimed_by_team)) throw new NotFoundError('This ticket is no longer in your queues.');
      const takenBy = (row) => row && row.claimed_by_team && row.claimed_by_team !== ctx.teamId
        ? new ConflictError(Config.teamName(row.claimed_by_team) + ' already took this ticket.', { claimedBy: Config.teamName(row.claimed_by_team) }) : null;
      if (takenBy(item)) throw takenBy(item);
      if (OPEN_QUEUE_STATUSES.indexOf(item.status) === -1 || Number(item.version) !== Number(expectedVersion)) {
        throw new ConflictError('This ticket was already handled by someone else.');
      }
      let empId = employeeId;
      if (empId) Pipeline.teamEmployee_(snapshot, empId, ctx.teamId);
      else {
        empId = Balancer.pick(mailboxId, Balancer.scheduledEmployees(snapshot, mailboxId), Balancer.loadTodayCounts(snapshot.today));
        if (!empId) throw new ValidationError('No one linked to Ivanti is scheduled on ' + mb.name + ' today. Choose a person.');
      }
      const res = BQ.query(SQL.queueClaim(t.q), [BQ.p.string('ticket_id', ticketId), BQ.p.int64('expected_version', expectedVersion),
        BQ.p.string('team_id', ctx.teamId), BQ.p.string('mailbox_id', mailboxId)]);
      if (res.numDmlAffectedRows !== 1) {
        const now = BQ.query(SQL.queueGet(t.q), [BQ.p.string('ticket_id', ticketId)]).rows[0];
        throw takenBy(now) || new ConflictError('This ticket was already handled by someone else.');
      }
      let payload = {};
      try { payload = JSON.parse(item.payload_json || '{}'); } catch (e) { payload = {}; }
      const ticket = { ticketId: ticketId, recId: payload.ivanti_rec_id, subject: payload.subject || '', fields: payload.fields || {} };
      const row = Pipeline.row_(ticket, { teamId: ctx.teamId, mailboxId: mailboxId, employeeId: empId, method: 'manual', counts: true },
        null, snapshot, { dryRun: false }, ctx.user);
      BQ.query(SQL.assignmentsMerge(t.a), [BQ.p.structArray('rows', ASSIGNMENT_ROW_FIELDS, [row])]);
      const wb = Pipeline.writebackOne_(row, snapshot);
      return { ticketId: ticketId, mailboxId: mailboxId, employeeId: empId, writeback: wb, fromShared: !item.team_id };
    });
  },

  /** Re-try pending SHARED-queue rows with Vertex (after classifyTicket_ is implemented). */
  processQueue(opts) {
    const runId = Pipeline.newRunId_();
    const got = Lease.acquire({ runId: runId, startedBy: (opts && opts.triggeredBy) || 'system', trigger: 'vertex_queue' });
    if (!got.acquired) return { status: 'busy', current: Pipeline.describeLease_(got.current) };
    const result = { classified: 0, assigned: 0, stillPending: 0 };
    try {
      const snapshot = Config.snapshot();
      const counts = Balancer.loadTodayCounts(snapshot.today);
      const t = Pipeline.tables_();
      const items = BQ.query(SQL.queueList(t.q), [BQ.p.stringArray('statuses', ['pending']), BQ.p.string('team_id', ''),
        BQ.p.bool('include_shared', true), BQ.p.bool('all_teams', false)]).rows;
      const rows = [], statuses = [];
      items.forEach((item) => {
        let payload;
        try { payload = JSON.parse(item.payload_json); } catch (e) { return; }
        payload.candidate_mailboxes = buildVertexPayload_({ ticketId: item.ticket_id }, snapshot).candidate_mailboxes;
        const v = payload.candidate_mailboxes.length ? Vertex.classify(payload) : null;
        if (!v) { result.stillPending++; return; }
        if (v.error || v.confidence < snapshot.dev.VERTEX_MIN_CONFIDENCE) {
          statuses.push({ ticket_id: item.ticket_id, status: v.error ? 'failed' : 'manual_review', result_mailbox_id: v.mailboxId || null,
            confidence: v.confidence || null, rationale: v.rationale || v.error || null, expected_version: Number(item.version) });
          return;
        }
        result.classified++;
        const mb = snapshot.mailboxById[v.mailboxId];
        const empId = Balancer.pick(v.mailboxId, Balancer.scheduledEmployees(snapshot, v.mailboxId), counts);
        if (!empId) {
          statuses.push({ ticket_id: item.ticket_id, status: 'no_one_scheduled', result_mailbox_id: v.mailboxId, confidence: v.confidence,
            rationale: v.rationale, expected_version: Number(item.version) });
          return;
        }
        Balancer.record(counts, v.mailboxId, empId);
        const ticket = { ticketId: item.ticket_id, recId: payload.ivanti_rec_id, subject: payload.subject || '', fields: payload.fields || {} };
        rows.push(Pipeline.row_(ticket, { teamId: mb.team_id, mailboxId: v.mailboxId, employeeId: empId, method: 'vertex', counts: true },
          runId, snapshot, { dryRun: false }));
        statuses.push({ ticket_id: item.ticket_id, status: 'routed', result_mailbox_id: v.mailboxId, confidence: v.confidence,
          rationale: v.rationale, expected_version: Number(item.version) });
      });
      if (rows.length) {
        BQ.query(SQL.assignmentsMerge(t.a), [BQ.p.structArray('rows', ASSIGNMENT_ROW_FIELDS, rows)]);
        const wb = Writeback.send(rows, snapshot, false);
        BQ.query(SQL.assignmentsWritebackUpdate(t.a), [BQ.p.structArray('rows', WRITEBACK_FIELDS,
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
