/**
 * FollowUp.gs — finds follow-ups (D2, D3, D9, D24).
 * A new ticket is a follow-up when its cleaned subject scores at or above the threshold against
 * an earlier ticket in the ticket history (BigQuery, default = the assignments table). The best
 * score wins; a tie goes to the most recent earlier ticket. Tickets in the same run are also
 * compared with each other (in JavaScript, using the same scoring).
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

  /** Map an owner value from the history table to an Employees.id. */
  ownerToEmployeeId_(owner, ownerColumnType, snapshot) {
    if (!owner) return null;
    if (ownerColumnType === 'ivanti_owner_id') {
      const emp = snapshot.employees.find((e) => String(e.ivanti_owner_id) === String(owner));
      return emp ? emp.id : null;
    }
    return snapshot.employeeById[owner] ? owner : null;
  },

  /**
   * tickets: [{ ticketId, subject }]. Returns { ticketId: { matchedTicketId, employeeId, mailboxId, score } }
   * for tickets whose best history match is at or above the threshold.
   */
  findInHistory(tickets, snapshot, limitPerTicket) {
    const s = snapshot.settings;
    const eligible = tickets
      .filter((t) => Subject.isEligible(t.subject, snapshot.stopWords, s.SUBJECT_MIN_WORDS, snapshot.ignoreList))
      .map((t) => ({ ticket_id: String(t.ticketId), seq: Subject.seq(t.subject, snapshot.stopWords) }));
    if (!eligible.length) return {};
    const hc = FollowUp.historyConfig_();
    const res = BQ.query(SQL.historyMatch(hc.ref.sql, hc.columns), [
      BQ.p.structArray('new_tickets', [['ticket_id', 'STRING'], ['seq', 'STRING']], eligible),
      BQ.p.stringArray('stop_words', snapshot.stopWords),
      BQ.p.string('prefix_pattern', QUERY_CONFIG.subjectMatching.prefixPattern),
      BQ.p.float64('threshold', s.SUBJECT_MATCH_THRESHOLD),
      BQ.p.int64('min_words', s.SUBJECT_MIN_WORDS),
      BQ.p.int64('limit_per_ticket', limitPerTicket || 1),
    ]);
    const out = {};
    res.rows.forEach((r) => {
      const employeeId = FollowUp.ownerToEmployeeId_(r.owner, hc.ownerColumnType, snapshot);
      const m = { matchedTicketId: r.matched_ticket_id, employeeId: employeeId, rawOwner: r.owner,
        mailboxId: r.mailbox_id || null, score: Number(r.score), matchedAt: r.matched_at };
      if (limitPerTicket && limitPerTicket > 1) (out[r.ticket_id] = out[r.ticket_id] || []).push(m);
      else if (!out[r.ticket_id]) out[r.ticket_id] = m;
    });
    return out;
  },

  /** Compare a ticket with tickets already handled in this run (same scoring as SQL). */
  findInBatch(ticket, batch, snapshot) {
    const s = snapshot.settings;
    if (!Subject.isEligible(ticket.subject, snapshot.stopWords, s.SUBJECT_MIN_WORDS, snapshot.ignoreList)) return null;
    const seq = Subject.seq(ticket.subject, snapshot.stopWords);
    let best = null;
    batch.forEach((b) => {
      if (!b.employeeId || b.ticketId === ticket.ticketId) return;
      const score = Subject.score(seq, Subject.seq(b.subject, snapshot.stopWords), s.SUBJECT_MIN_WORDS);
      if (score >= s.SUBJECT_MATCH_THRESHOLD && (!best || score >= best.score)) {
        best = { matchedTicketId: b.ticketId, employeeId: b.employeeId, mailboxId: b.mailboxId, score: score };
      }
    });
    return best;
  },

  /** Settings page "Test a subject": top 5 history matches with scores. */
  testSubject(subject) {
    const snapshot = Config.snapshot();
    const s = snapshot.settings;
    const seq = Subject.seq(subject, snapshot.stopWords);
    const eligible = Subject.isEligible(subject, snapshot.stopWords, s.SUBJECT_MIN_WORDS, snapshot.ignoreList);
    const result = { cleaned: seq, eligible: eligible, threshold: s.SUBJECT_MATCH_THRESHOLD, matches: [] };
    if (!eligible) return result;
    const saved = s.SUBJECT_MATCH_THRESHOLD;
    snapshot.settings = Object.assign({}, s, { SUBJECT_MATCH_THRESHOLD: Math.min(saved, 0.3) });
    const found = FollowUp.findInHistory([{ ticketId: '__test__', subject: subject }], snapshot, 5);
    result.matches = (found.__test__ || []).map((m) => {
      const emp = m.employeeId ? snapshot.employeeById[m.employeeId] : null;
      return { ticketId: m.matchedTicketId, score: Math.round(m.score * 100) / 100, wouldMatch: m.score >= saved,
        owner: emp ? emp.display_name : (m.rawOwner || ''), matchedAt: m.matchedAt };
    });
    return result;
  },
};
