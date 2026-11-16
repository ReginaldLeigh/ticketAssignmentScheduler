/**
 * Writeback.gs — sets the ticket Owner in Ivanti (D1, D6).
 *
 * Only the Owner is sent today. To send more fields (Owner Team, Status, …) a developer edits
 * buildOwnerPatch_() below — it is the single place that decides what is sent to Ivanti.
 */

/**
 * Builds the body sent to Ivanti when a ticket is assigned.
 * @param {{ticketId:string, recId:string, mailbox:Object, employee:Object}} assignment
 *        employee includes ivanti_owner_id; mailbox is the Mailboxes row (may be null).
 * @return {Object} fields to update on the Ivanti Incident
 */
function buildOwnerPatch_(assignment) {
  return {
    Owner: assignment.employee.ivanti_owner_id,
    // TODO(Ivanti-fields): add OwnerTeam / Status / other required fields here.
    // If a value depends on the mailbox, add a column to the Mailboxes tab (developer) and read
    // it from assignment.mailbox. See docs/IVANTI_INTEGRATION.md.
  };
}

const Writeback = {
  /**
   * rows: assignment rows (objects with ticket_id, ivanti_rec_id, employee_id, mailbox_id).
   * Returns { ticket_id: { status: 'success'|'failed', error } }. Dry runs send nothing.
   */
  send(rows, snapshot, dryRun) {
    const out = {};
    if (!rows.length) return out;
    if (dryRun) { rows.forEach((r) => { out[r.ticket_id] = { status: 'skipped_dry_run', error: null }; }); return out; }
    const items = [], keys = [];
    rows.forEach((r) => {
      const employee = snapshot.employeeById[r.employee_id];
      if (!employee || !employee.ivanti_owner_id) {
        out[r.ticket_id] = { status: 'failed', error: 'Employee has no Ivanti owner ID in the Roster.' };
        return;
      }
      const body = buildOwnerPatch_({ ticketId: r.ticket_id, recId: r.ivanti_rec_id,
        mailbox: snapshot.mailboxById[r.mailbox_id] || null, employee: employee });
      items.push({ recId: r.ivanti_rec_id, body: body });
      keys.push(r.ticket_id);
    });
    const results = items.length ? Ivanti.updateRecords(items) : [];
    results.forEach((res, i) => { out[keys[i]] = { status: res.ok ? 'success' : 'failed', error: res.error }; });
    return out;
  },
};
