/**
 * FollowUp.gs — finds follow-ups (D2, D3, D9, D24), always within ONE team's history (A4).
 * A new ticket is a follow-up when its cleaned subject scores at or above the threshold against
 * an earlier ticket of that team. The best score wins; a tie goes to the most recent earlier
 * ticket. Tickets handled earlier in the same run are compared too (in JavaScript, same scoring).
 * Each team's own stop words and ignore list apply.
 */
const FollowUp = {
  historyConfig_() {
    const bq = QUERY_CONFIG.bigQuery;
    const h = bq.ticketHistory || {};
    const table = h.table || bq.assignmentsTable;
    return {
      ref: BQ.ref(table),
      columns: Object.assign({}, h.columns, { extraFilter: h.extraFilter }),
      ownerColumnType: h.ownerColumnType || 'employee_id',
    };
  },

  /** Map an owner value from the history table to an Employees.id of the given team. */
  ownerToEmployeeId_(owner, ownerColumnType, snapshot, teamId) {
    if (!owner) return null;
    let emp;
    if (ownerColumnType === 'ivanti_owner_id') emp = snapshot.employees.find((e) => String(e.ivanti_owner_id) === String(owner) && e.team_id === teamId);
    else emp = snapshot.employeeById[owner];
    return emp && emp.team_id === teamId ? emp.id : null;
  },

  teamCtx_(snapshot, teamId) {
    const t = snapshot.byTeam[teamId] || { stopWords: DEFAULT_STOP_WORDS, ignoreList: [] };
    return { stopWords: t.stopWords, ignoreList: t.ignoreList, threshold: snapshot.dev.SUBJECT_MATCH_THRESHOLD, minWords: snapshot.dev.SUBJECT_MIN_WORDS };
  },

  /**
   * tickets: [{ ticketId, subject }]. Compares them with ONE team's history.
   * Returns { ticketId: { matchedTicketId, employeeId, mailboxId, teamId, score } }.
   * opts.limitPerTicket > 1 returns arrays (used by "Test a subject"); opts.threshold overrides.
   */
  findInHistory(tickets, snapshot, teamId, opts) {
    opts = opts || {};
    const c = FollowUp.teamCtx_(snapshot, teamId);
    const eligible = tickets
      .filter((t) => Subject.isEligible(t.subject, c.stopWords, c.minWords, c.ignoreList))
      .map((t) => ({ ticket_id: String(t.ticketId), seq: Subject.seq(t.subject, c.stopWords) }));
    if (!eligible.length) return {};
    const hc = FollowUp.historyConfig_();
    const res = BQ.query(SQL.historyMatch(hc.ref.sql, hc.columns), [
      BQ.p.structArray('new_tickets', [['ticket_id', 'STRING'], ['seq', 'STRING']], eligible),
      BQ.p.string('team_id', teamId),
      BQ.p.stringArray('stop_words', c.stopWords),
      BQ.p.string('prefix_pattern', QUERY_CONFIG.subjectMatching.prefixPattern),
      BQ.p.float64('threshold', opts.threshold !== undefined ? opts.threshold : c.threshold),
      BQ.p.int64('min_words', c.minWords),
      BQ.p.int64('limit_per_ticket', opts.limitPerTicket || 1),
    ]);
    const out = {};
    res.rows.forEach((r) => {
      const employeeId = FollowUp.ownerToEmployeeId_(r.owner, hc.ownerColumnType, snapshot, teamId);
      const m = { matchedTicketId: r.matched_ticket_id, employeeId: employeeId, rawOwner: r.owner, teamId: teamId,
        mailboxId: r.mailbox_id || null, score: Number(r.score), matchedAt: r.matched_at };
      if (opts.limitPerTicket && opts.limitPerTicket > 1) (out[r.ticket_id] = out[r.ticket_id] || []).push(m);
      else if (!out[r.ticket_id]) out[r.ticket_id] = m;
    });
    return out;
  },

  /** Compare a ticket with tickets of `teamId` handled earlier in this run (same scoring as SQL). */
  findInBatch(ticket, batch, snapshot, teamId) {
    const c = FollowUp.teamCtx_(snapshot, teamId);
    if (!Subject.isEligible(ticket.subject, c.stopWords, c.minWords, c.ignoreList)) return null;
    const seq = Subject.seq(ticket.subject, c.stopWords);
    let best = null;
    batch.forEach((b) => {
      if (b.teamId !== teamId || !b.employeeId || b.ticketId === ticket.ticketId) return;
      const score = Subject.score(seq, Subject.seq(b.subject, c.stopWords), c.minWords);
      if (score >= c.threshold && (!best || score >= best.score)) {
        best = { matchedTicketId: b.ticketId, employeeId: b.employeeId, mailboxId: b.mailboxId, teamId: teamId, score: score };
      }
    });
    return best;
  },

  /** Team settings page "Test a subject": top 5 matches in the caller's team, with scores. */
  testSubject(subject, teamId) {
    const snapshot = Config.snapshot();
    const c = FollowUp.teamCtx_(snapshot, teamId);
    const seq = Subject.seq(subject, c.stopWords);
    const eligible = Subject.isEligible(subject, c.stopWords, c.minWords, c.ignoreList);
    const result = { cleaned: seq, eligible: eligible, threshold: c.threshold, matches: [] };
    if (!eligible) return result;
    const found = FollowUp.findInHistory([{ ticketId: '__test__', subject: subject }], snapshot, teamId,
      { limitPerTicket: 5, threshold: Math.min(c.threshold, 0.3) });
    result.matches = (found.__test__ || []).map((m) => {
      const emp = m.employeeId ? snapshot.employeeById[m.employeeId] : null;
      return { ticketId: m.matchedTicketId, score: Math.round(m.score * 100) / 100, wouldMatch: m.score >= c.threshold,
        owner: emp ? emp.display_name : '', matchedAt: m.matchedAt };
    });
    return result;
  },
};
