/** End-to-end assignment runs against mock Ivanti + mock BigQuery. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, seed, incident } = require('./harness');

function setup() {
  const app = loadApp();
  const today = app.g('Config').today();
  const ids = seed(app, today);
  return { app, today, ids, st: app.mocks.state, A: app.mocks.bq.tables.assignments, Q: app.mocks.bq.tables.vertex_queue };
}
const run = (app, extra) => { app.mocks.props.delete('last_run_finished_at'); return app.g('Pipeline').run(Object.assign({ trigger: 'manual', triggeredBy: 'admin@example.com' }, extra)); };
const live = (A) => A.filter((a) => !a.dry_run);
function spread(A, mailboxId) {
  const c = {};
  live(A).filter((a) => a.mailbox_id === mailboxId && a.counts_toward_balance).forEach((a) => { c[a.employee_id] = (c[a.employee_id] || 0) + 1; });
  return c;
}

test('routes by rule, balances ±1, sets the Owner in Ivanti', () => {
  const { app, ids, st, A } = setup();
  for (let i = 0; i < 31; i++) st.ivantiIncidents.push(incident(4001 + i, 'Billing', 'Account ' + (100 + i) + ' needs a credit memo'));
  const r = run(app);
  assert.equal(r.status, 'succeeded', r.errors.join(' | '));
  assert.equal(r.assigned, 31);
  const counts = Object.values(spread(A, ids.billing));
  assert.equal(counts.length, 3, 'only the three scheduled Billing people');
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, 'spread ' + counts);
  assert.ok(live(A).every((a) => a.writeback_status === 'success' && a.writeback_attempts === 1));
  const patched = st.fetchAllCalls.flat();
  assert.equal(patched.length, 31);
  patched.forEach((p) => { assert.equal(p.method, 'patch'); assert.deepEqual(Object.keys(JSON.parse(p.payload)), ['Owner']); assert.equal(p.headers.Authorization, 'rest_api_key=test-key'); });
});

test('priority: a Billing ticket outside 4000–5000 falls through to the General mailbox', () => {
  const { app, ids, st, A } = setup();
  st.ivantiIncidents.push(incident(9100, 'Billing', 'Statement shows wrong address details'));
  run(app);
  assert.equal(live(A)[0].mailbox_id, ids.general);
  assert.equal(live(A)[0].employee_id, ids.dee);
});

test('follow-up goes to the earlier owner even when they are not scheduled today, and is not counted', () => {
  const { app, ids, st, A } = setup();
  // History: Cy (not scheduled on General) owned an earlier ticket.
  A.push({ ticket_id: '100', ivanti_rec_id: 'R100', subject: 'Cannot access shared drive Finance folder', mailbox_id: ids.general,
    employee_id: ids.cy, routing_method: 'rule', counts_toward_balance: true, dry_run: false, assigned_at: '2026-10-01T12:00:00Z',
    version: 1, writeback_status: 'success', writeback_attempts: 1 });
  st.ivantiIncidents.push(incident(301, 'General', 'RE: Cannot access shared drive Finance folder'));
  const r = run(app);
  assert.equal(r.followUps, 1);
  const row = live(A).find((a) => a.ticket_id === '301');
  assert.equal(row.employee_id, ids.cy);
  assert.equal(row.routing_method, 'follow_up');
  assert.equal(row.counts_toward_balance, false);
  assert.equal(row.matched_ticket_id, '100');
  assert.ok(row.match_score >= 0.75);
  assert.equal(row.mailbox_id, ids.general, 'mailbox still comes from the rules');
});

test('follow-up whose owner is inactive goes through the normal split', () => {
  const { app, ids, st, A } = setup();
  A.push({ ticket_id: '100', ivanti_rec_id: 'R100', subject: 'Cannot access shared drive Finance folder', mailbox_id: ids.general,
    employee_id: ids.cy, routing_method: 'rule', counts_toward_balance: true, dry_run: false, assigned_at: '2026-10-01T12:00:00Z', version: 1, writeback_status: 'success', writeback_attempts: 1 });
  const cy = app.g('Store').read('Employees').find((e) => e.id === ids.cy);
  app.ctx.apiSaveEmployee({ requestId: 'x', id: cy.id, version: cy.version, display_name: cy.display_name, employee_email: cy.employee_email, ivanti_owner_id: cy.ivanti_owner_id, active: false });
  st.ivantiIncidents.push(incident(302, 'General', 'Cannot access shared drive Finance folder'));
  run(app);
  const row = live(A).find((a) => a.ticket_id === '302');
  assert.equal(row.routing_method, 'rule');
  assert.equal(row.employee_id, ids.dee);
});

test('tickets in the same run are matched with each other', () => {
  const { app, st, A } = setup();
  st.ivantiIncidents.push(incident(4300, 'Billing', 'Refund not received for order 8812', '2026-11-16T08:00:00Z'));
  st.ivantiIncidents.push(incident(4301, 'Billing', 'FW: Refund not received for order 8812', '2026-11-16T09:00:00Z'));
  run(app);
  const first = live(A).find((a) => a.ticket_id === '4300'), second = live(A).find((a) => a.ticket_id === '4301');
  assert.equal(second.routing_method, 'follow_up');
  assert.equal(second.employee_id, first.employee_id);
});

test('generic subjects and different numbers are not follow-ups', () => {
  const { app, st, A } = setup();
  app.ctx.apiAddListItem({ requestId: 'ig', list: 'SubjectIgnoreList', value: 'password reset needed' });
  st.ivantiIncidents.push(incident(4400, 'Billing', 'Password reset needed', '2026-11-16T08:00:00Z'));
  st.ivantiIncidents.push(incident(4401, 'Billing', 'RE: Password reset needed', '2026-11-16T08:01:00Z'));
  st.ivantiIncidents.push(incident(4402, 'Billing', 'Invoice 4471 charged twice', '2026-11-16T08:02:00Z'));
  st.ivantiIncidents.push(incident(4403, 'Billing', 'Invoice 5520 charged twice', '2026-11-16T08:03:00Z'));
  run(app);
  assert.equal(live(A).filter((a) => a.routing_method === 'follow_up').length, 0);
});

test('no rule match → Unrouted queue with a Vertex payload; nothing is sent to Ivanti', () => {
  const { app, st, Q, A } = setup();
  st.ivantiIncidents.push(incident(7000, 'Hardware', 'Laptop screen flickering after update'));
  const r = run(app);
  assert.equal(r.unrouted, 1);
  assert.equal(A.length, 0);
  assert.equal(Q.length, 1);
  assert.equal(Q[0].status, 'pending');
  assert.equal(Q[0].reason, 'no_rule_match');
  const payload = JSON.parse(Q[0].payload_json);
  assert.equal(payload.subject, 'Laptop screen flickering after update');
  assert.equal(payload.candidate_mailboxes.length, 2);
  assert.equal(st.fetchAllCalls.length, 0);
});

test('nobody scheduled on the mailbox → queued as no_one_scheduled', () => {
  const { app, st, Q, today } = setup();
  const dee = app.g('Store').read('Schedule').find((e) => e.date === today && e.employee_id && app.g('Store').read('Employees').find((x) => x.id === e.employee_id).display_name === 'Dee');
  app.ctx.apiScheduleRemove({ requestId: 'rm', id: dee.id, version: dee.version });
  st.ivantiIncidents.push(incident(300, 'General', 'Monitor arm is loose and wobbling'));
  run(app);
  assert.equal(Q[0].status, 'no_one_scheduled');
});

test('second run does not re-assign tickets (dedupe), and a queued ticket is routed once a rule exists', () => {
  const { app, ids, st, A, Q } = setup();
  st.ivantiIncidents.push(incident(4100, 'Billing', 'Credit memo request for account 55'));
  st.ivantiIncidents.push(incident(7001, 'Hardware', 'Docking station not charging laptop'));
  run(app);
  // Simulate Ivanti still listing 4100 (e.g. filter lag): it must not be assigned twice.
  st.ivantiIncidents.find((x) => x.IncidentNumber === 4100).Owner = null;
  app.ctx.apiSaveRule({ requestId: 'hw', mailboxId: ids.general, conditions: [{ field: 'Category', op: 'equals', value: 'Hardware' }] });
  const r2 = run(app);
  assert.equal(live(A).filter((a) => a.ticket_id === '4100').length, 1);
  assert.equal(r2.assigned, 1);
  assert.equal(live(A).find((a) => a.ticket_id === '7001').employee_id, ids.dee);
  assert.equal(Q.find((q) => q.ticket_id === '7001').status, 'routed');
});

test('dry run: rows marked dry_run, nothing sent to Ivanti, a later live run assigns for real', () => {
  const { app, st, A } = setup();
  st.ivantiIncidents.push(incident(4100, 'Billing', 'Credit memo request for account 55'));
  const d = run(app, { dryRun: true });
  assert.equal(d.status, 'succeeded');
  assert.equal(A[0].dry_run, true);
  assert.equal(A[0].writeback_status, 'skipped_dry_run');
  assert.equal(st.fetchAllCalls.length, 0);
  const r = run(app);
  assert.equal(r.assigned, 1);
  assert.equal(A.length, 1, 'the dry-run row was replaced by the live one');
  assert.equal(A[0].dry_run, false);
  assert.equal(A[0].writeback_status, 'success');
});

test('failed Ivanti update is retried on the next run', () => {
  const { app, st, A } = setup();
  st.ivantiIncidents.push(incident(4100, 'Billing', 'Credit memo request for account 55'));
  st.ivantiFailRecIds.add('REC4100');
  const r1 = run(app);
  assert.equal(r1.writebackFailures, 1);
  assert.equal(A[0].writeback_status, 'failed');
  st.ivantiFailRecIds.clear();
  const r2 = run(app);
  assert.equal(r2.writebackFailures, 0);
  assert.equal(A[0].writeback_status, 'success');
  assert.equal(A[0].writeback_attempts, 2);
  assert.equal(live(A).length, 1);
});

test('balance holds across runs (counts read from today\'s assignments)', () => {
  const { app, ids, st, A } = setup();
  for (let i = 0; i < 7; i++) st.ivantiIncidents.push(incident(4001 + i, 'Billing', 'Account ' + (100 + i) + ' needs a credit memo'));
  run(app);
  for (let i = 0; i < 5; i++) st.ivantiIncidents.push(incident(4501 + i, 'Billing', 'Region ' + (200 + i) + ' tax exemption form'));
  run(app);
  const counts = Object.values(spread(A, ids.billing));
  assert.equal(counts.reduce((a, b) => a + b, 0), 12);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, String(counts));
});

test('a run records itself in the runs table and releases the lease', () => {
  const { app, st } = setup();
  st.ivantiIncidents.push(incident(4100, 'Billing', 'Credit memo request for account 55'));
  const r = run(app);
  const row = app.mocks.bq.tables.runs.find((x) => x.run_id === r.runId);
  assert.equal(row.status, 'succeeded');
  assert.equal(row.assigned, 1);
  assert.equal(row.triggered_by, 'admin@example.com');
  assert.equal(app.g('Lease').current(), null);
});

test('missing Ivanti key stops the run before anything happens', () => {
  const { app, A } = setup();
  app.mocks.props.delete('IVANTI_API_KEY');
  const r = run(app);
  assert.equal(r.status, 'stopped_check_failed');
  assert.ok(r.errors.some((e) => /IVANTI_API_KEY/.test(e)));
  assert.equal(A.length, 0);
});

/* ───────────── Manual actions ───────────── */
test('reassign: updates the owner (and Ivanti); a stale reassign is a conflict; refused during a run', () => {
  const { app, ids, st, A } = setup();
  st.ivantiIncidents.push(incident(4100, 'Billing', 'Credit memo request for account 55'));
  run(app);
  const row = A[0];
  const loadedVersion = row.version;   // what a second admin's screen would still show
  const target = row.employee_id === ids.ana ? ids.ben : ids.ana;
  const ok = app.ctx.apiReassign({ ticketId: '4100', employeeId: target, version: loadedVersion });
  assert.equal(ok.ok, true, JSON.stringify(ok.error));
  assert.equal(A[0].employee_id, target);
  assert.equal(A[0].writeback_status, 'success');
  assert.equal(app.ctx.apiReassign({ ticketId: '4100', employeeId: ids.cy, version: loadedVersion }).error.type, 'ConflictError');
  app.g('Lease').acquire({ runId: 'busy', startedBy: 'system', trigger: 'scheduled' });
  assert.equal(app.ctx.apiReassign({ ticketId: '4100', employeeId: ids.cy, version: A[0].version }).error.type, 'BusyError');
});

test('resolve queue: admin picks a mailbox; the balancer picks the person; a second resolve conflicts', () => {
  const { app, ids, st, A } = setup();
  st.ivantiIncidents.push(incident(7000, 'Hardware', 'Laptop screen flickering after update'));
  run(app);
  const q = app.ctx.apiListQueue().data[0];
  const r = app.ctx.apiResolveQueue({ ticketId: q.ticket_id, mailboxId: ids.billing, version: q.version });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.ok([ids.ana, ids.ben, ids.cy].includes(r.data.employeeId));
  assert.equal(A[0].routing_method, 'manual');
  assert.equal(A[0].assigned_by, 'admin@example.com');
  assert.equal(app.ctx.apiResolveQueue({ ticketId: q.ticket_id, mailboxId: ids.billing, version: q.version }).ok, false);
});

test('backfill loads past Ivanti tickets as history only (rows added, no tables created)', () => {
  const { app, ids, st, A } = setup();
  st.ivantiHistory = [Object.assign(incident(50, 'General', 'Printer on floor 3 keeps jamming'), { Owner: 'OWN-BEN' }),
    Object.assign(incident(51, 'General', 'Unknown owner ticket subject here'), { Owner: 'SOMEONE-ELSE' })];
  const res = app.run("backfillHistoryFromIvanti('2026-01-01')");
  assert.equal(res.loaded, 1);
  assert.equal(res.skippedNoOwnerMatch, 1);
  assert.equal(A[0].routing_method, 'backfill');
  assert.equal(A[0].counts_toward_balance, false);
  assert.equal(A[0].writeback_status, 'not_applicable');
  st.ivantiIncidents.push(incident(4100, 'Billing', 'RE: Printer on floor 3 keeps jamming'));
  run(app);
  assert.equal(live(A).find((a) => a.ticket_id === '4100').employee_id, ids.ben, 'history drives follow-ups');
  assert.deepEqual(st.creationCalls, []);
});

test('test-a-subject shows matches and whether they pass the threshold', () => {
  const { app, ids, A } = setup();
  A.push({ ticket_id: '100', ivanti_rec_id: 'R100', subject: 'VPN keeps disconnecting at home', mailbox_id: ids.general, employee_id: ids.cy,
    routing_method: 'rule', counts_toward_balance: true, dry_run: false, assigned_at: '2026-10-01T12:00:00Z', version: 1, writeback_status: 'success', writeback_attempts: 1 });
  const r = app.ctx.apiTestSubject({ subject: 'RE: VPN keeps disconnecting at home' }).data;
  assert.equal(r.eligible, true);
  assert.equal(r.matches[0].ticketId, '100');
  assert.equal(r.matches[0].wouldMatch, true);
  assert.equal(r.matches[0].owner, 'Cy');
});
