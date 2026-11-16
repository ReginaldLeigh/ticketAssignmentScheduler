/**
 * Balancer.gs — spreads NEW tickets evenly (D14): every employee scheduled on a mailbox today
 * stays within ±1 of the others. Counts come from today's assignments where
 * counts_toward_balance = TRUE (follow-ups are left out, D7). The lowest count wins; ties are
 * broken at random. Because counts are read from the log, the balance holds across runs, and an
 * employee added part-way through the day receives tickets until they have caught up.
 */
const Balancer = {
  /** Active, Ivanti-mapped employees scheduled today on the mailbox. */
  scheduledEmployees(snapshot, mailboxId) {
    const ids = {};
    snapshot.scheduleToday.forEach((e) => { if (e.mailbox_id === mailboxId) ids[e.employee_id] = true; });
    return Object.keys(ids).filter((id) => {
      const emp = snapshot.employeeById[id];
      return emp && emp.active && emp.ivanti_owner_id;
    }).sort();
  },

  countKey(mailboxId, employeeId) { return mailboxId + '|' + employeeId; },

  /** counts: { 'mailbox|employee': n }. rng: () => [0,1). Returns an employee id or null. */
  pick(mailboxId, employeeIds, counts, rng) {
    if (!employeeIds.length) return null;
    let min = Infinity;
    employeeIds.forEach((id) => { min = Math.min(min, counts[Balancer.countKey(mailboxId, id)] || 0); });
    const lowest = employeeIds.filter((id) => (counts[Balancer.countKey(mailboxId, id)] || 0) === min);
    const r = (rng || Math.random)();
    return lowest[Math.min(lowest.length - 1, Math.floor(r * lowest.length))];
  },

  record(counts, mailboxId, employeeId) {
    const k = Balancer.countKey(mailboxId, employeeId);
    counts[k] = (counts[k] || 0) + 1;
  },

  /** Today's balanced counts from BigQuery. */
  loadTodayCounts(today) {
    const t = BQ.ref(QUERY_CONFIG.bigQuery.assignmentsTable).sql;
    const res = BQ.query(SQL.assignmentsTodayCounts(t), [BQ.p.string('tz', Store.tz_()), BQ.p.date('today', today)]);
    const counts = {};
    res.rows.forEach((r) => { counts[Balancer.countKey(r.mailbox_id, r.employee_id)] = Number(r.n); });
    return counts;
  },
};
