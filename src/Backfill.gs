/**
 * Backfill.gs — DEVELOPER-RUN, once, before go-live (plan §13 Q3, option c).
 *
 * The ticket history (assignments table) starts empty, so no follow-ups can be found until the
 * app has processed tickets. This loads past Ivanti Incidents (subject + owner) as history rows.
 *
 *   • It only ADDS ROWS (MERGE) to the existing, developer-created assignments table. It never
 *     creates or alters a table (D23) and goes through BigQuery.gs like everything else.
 *   • Owners are matched to the Roster by Employees.ivanti_owner_id; unmatched tickets are skipped.
 *   • Rows are marked routing_method='backfill', counts_toward_balance=FALSE,
 *     writeback_status='not_applicable', so they never affect the ±1 balance or Ivanti.
 *   • Existing rows for the same ticket are never overwritten (MERGE only updates dry-run rows).
 *
 * Usage (Apps Script editor): backfillHistoryFromIvanti('2026-01-01')
 */
function backfillHistoryFromIvanti(fromDate, maxPages) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fromDate || ''))) throw new ValidationError('Pass a start date like "2026-01-01".');
  const runId = 'backfill_' + Utilities.getUuid().slice(0, 8);
  const got = Lease.acquire({ runId: runId, startedBy: 'backfill', trigger: 'backfill' });
  if (!got.acquired) throw new BusyError('An assignment run is in progress. Try again later.');
  try {
    const check = SchemaCheck.checkAll();
    if (!check.ok) throw new SchemaMissingError('Setup is incomplete: ' + check.config.concat(check.sheets, check.bigQuery).join(' | '));
    const snapshot = Config.snapshot();
    const cfg = QUERY_CONFIG.ivanti;
    const filter = cfg.backfillFilter.replace('{fromIso}', fromDate + 'T00:00:00Z');
    const raw = Ivanti.fetchIncidents_(filter, maxPages || 200);
    const byOwner = {};
    snapshot.employees.forEach((e) => { if (e.ivanti_owner_id) byOwner[String(e.ivanti_owner_id)] = e; });
    const rows = [];
    let skipped = 0;
    raw.forEach((rec) => {
      const ticket = Ivanti.toTicket(rec);
      const emp = byOwner[String(rec[cfg.ownerField] || '')];
      if (!emp || !ticket.subject) { skipped++; return; }
      const row = Pipeline.row_(ticket, { mailboxId: (Rules.route(ticket, snapshot) || {}).mailboxId || null,
        employeeId: emp.id, method: 'backfill', counts: false }, null, snapshot, { dryRun: false }, 'backfill');
      row.writeback_status = 'not_applicable';
      row.assigned_at = ticket.createdAt ? new Date(ticket.createdAt).toISOString() : row.assigned_at;
      rows.push(row);
    });
    const t = BQ.ref(QUERY_CONFIG.bigQuery.assignmentsTable).sql;
    for (let i = 0; i < rows.length; i += 500) {
      BQ.query(SQL.assignmentsMerge(t), [BQ.p.structArray('rows', ASSIGNMENT_ROW_FIELDS, rows.slice(i, i + 500))]);
    }
    const result = { fetched: raw.length, loaded: rows.length, skippedNoOwnerMatch: skipped };
    console.log('Backfill complete: ' + JSON.stringify(result));
    return result;
  } finally {
    Lease.release(runId, false);
  }
}
