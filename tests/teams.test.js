/**
 * Change request 2026-11-16: teams and roles, one team per person, developer-only settings,
 * Ivanti lookup (IDs never reach a browser), range scheduling, team routing, team + shared queues.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, seed, incident } = require('./harness');

function setup() {
  const app = loadApp();
  const today = app.g('Config').today();
  const ids = seed(app, today);
  return { app, today, ids, st: app.mocks.state, A: app.mocks.bq.tables.assignments, Q: app.mocks.bq.tables.vertex_queue, Store: app.g('Store') };
}
const as = (app, email) => { app.mocks.state.user = email; };
const run = (app, teamId, extra) => {
  [...app.mocks.props.keys()].filter((k) => k.indexOf('last_run_finished_at') === 0).forEach((k) => app.mocks.props.delete(k));
  return app.g('Pipeline').run(Object.assign({ teamId: teamId, trigger: 'manual', triggeredBy: 'system' }, extra));
};
const live = (A) => A.filter((a) => !a.dry_run);
/** Values from the Apps Script sandbox have their own prototypes; compare as plain JSON. */
const eq = (a, b, m) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b, m);

/* ───────────── Team isolation ───────────── */
test('a team sees only its own schedule, mailboxes, rules and employees', () => {
  const { app } = setup();
  as(app, 'kim@example.com');
  const week = app.ctx.apiGetWeek({ weekStart: '2026-01-05' }).data;
  eq(week.mailboxes.map((m) => m.name).sort(), ['Card payments', 'Payments triage']);
  eq(week.employees.map((e) => e.display_name).sort(), ['Eve', 'Finn']);
  assert.ok(app.ctx.apiListRules().data.rules.every((r) => r.team_id === 'payments'));
});

test('a team cannot change another team\'s data, even with its ids', () => {
  const { app, ids, Store } = setup();
  as(app, 'admin@example.com');   // billing admin
  assert.equal(app.ctx.apiScheduleAdd({ requestId: 'x1', date: '2030-01-07', mailboxId: ids.cards, employeeId: ids.ana }).error.type, 'ValidationError');
  assert.equal(app.ctx.apiScheduleAdd({ requestId: 'x2', date: '2030-01-07', mailboxId: ids.billing, employeeId: ids.eve }).error.type, 'ValidationError');
  assert.equal(app.ctx.apiSaveRule({ requestId: 'x3', mailboxId: ids.cards, conditions: [{ field: 'Category', op: 'equals', value: 'X' }] }).error.type, 'ValidationError');
  const pm = Store.read('Mailboxes', { teamId: 'payments' })[0];
  assert.equal(app.ctx.apiSaveMailbox({ requestId: 'x4', id: pm.id, version: pm.version, name: 'Hijacked', active: true }).error.type, 'NotFoundError');
  const pEntry = Store.read('Schedule', { teamId: 'payments' })[0];
  assert.equal(app.ctx.apiScheduleRemove({ requestId: 'x5', id: pEntry.id, version: pEntry.version }).data.status, 'already_removed');
  assert.ok(!Store.read('Schedule', { includeDeleted: true }).find((e) => e.id === pEntry.id).deleted_at, 'payments entry untouched');
  // Store-level guard, independent of the API checks
  assert.throws(() => Store.mutate({ user: 'admin@example.com', teamId: 'billing' }, (tx) => tx.update('Mailboxes', pm.id, { name: 'x' })), (e) => e.name === 'NotFoundError');
  assert.throws(() => Store.mutate({ user: 'admin@example.com', teamId: 'billing' }, (tx) => tx.insert('Mailboxes', { team_id: 'payments', name: 'x' })), (e) => e.name === 'PermissionError');
  assert.equal(Store.read('Mailboxes', { teamId: 'payments' }).find((m) => m.id === pm.id).name, 'Card payments');
});

test('assignment log, reassign and change history are per team', () => {
  const { app, ids, st, A } = setup();
  st.ivantiIncidents.push(incident(4100, 'Billing', 'Credit memo request for account 55'));
  run(app, 'billing');
  as(app, 'kim@example.com');
  assert.equal(app.ctx.apiSearchAssignments({}).data.rows.length, 0);
  assert.equal(app.ctx.apiReassign({ ticketId: '4100', employeeId: ids.eve, version: A[0].version }).error.type, 'NotFoundError', 'not their ticket');
  assert.equal(app.ctx.apiReassign({ ticketId: '4100', employeeId: ids.ana, version: A[0].version }).error.type, 'ValidationError', 'not their employee');
  const audit = app.ctx.apiGetAudit({}).data;
  assert.ok(audit.length > 0 && audit.every((e) => e.user === 'kim@example.com'), 'only payments changes (made by kim) are visible to payments');
  as(app, 'pat@example.com');
  assert.equal(app.ctx.apiSearchAssignments({}).data.rows.length, 1);
});

/* ───────────── One team per person ───────────── */
test('a person can be on one team only', () => {
  const { app, ids, Store } = setup();
  as(app, 'admin@example.com');
  const r = app.ctx.apiSaveEmployee({ requestId: 'o1', display_name: 'Eve', employee_email: 'eve@example.com' });
  assert.equal(r.error.type, 'ValidationError');
  assert.match(r.error.message, /already on the Payments team/);
  assert.match(app.ctx.apiSaveEmployee({ requestId: 'o2', display_name: 'Kim', employee_email: 'kim@example.com' }).error.message, /Payments/, 'managers count too');
  as(app, 'pat@example.com');
  assert.match(app.ctx.apiAddListItem({ requestId: 'o3', list: 'Admins', value: 'finn@example.com' }).error.message, /Payments/);
  // Once Payments deactivates Eve, Billing may add her.
  as(app, 'kim@example.com');
  const eve = Store.read('Employees', { teamId: 'payments' }).find((e) => e.id === ids.eve);
  assert.equal(app.ctx.apiSaveEmployee({ requestId: 'o4', id: eve.id, version: eve.version, display_name: 'Eve', employee_email: 'eve@example.com', active: false }).ok, true);
  as(app, 'admin@example.com');
  assert.equal(app.ctx.apiSaveEmployee({ requestId: 'o5', display_name: 'Eve', employee_email: 'eve@example.com' }).ok, true);
});

test('the setup check flags a manager listed under two teams and bad developer settings', () => {
  const { app } = setup();
  app.run("TEAMS.push({ id: 'dup', name: 'Dup', managers: ['pat@example.com'] }); DEVELOPER_SETTINGS.SUBJECT_MATCH_THRESHOLD = 2;");
  const problems = app.g('Config').check();
  assert.ok(problems.some((p) => /pat@example.com is a manager of two teams/.test(p)));
  assert.ok(problems.some((p) => /SUBJECT_MATCH_THRESHOLD/.test(p)));
});

/* ───────────── Developer-only settings ───────────── */
test('developer settings cannot be changed in the app; the manual-edit refresh is gone', () => {
  const { app } = setup();
  as(app, 'pat@example.com');
  ['SUBJECT_MATCH_THRESHOLD', 'SUBJECT_MIN_WORDS', 'RUN_NOW_COOLDOWN_MIN', 'WRITEBACK_MAX_ATTEMPTS', 'VERTEX_MIN_CONFIDENCE']
    .forEach((k) => assert.equal(app.ctx.apiSaveTeamSetting({ requestId: k, key: k, value: '0.5' }).error.type, 'ValidationError', k));
  assert.equal(typeof app.ctx.apiRefreshAfterManualEdit, 'undefined');
  assert.equal(typeof app.ctx.apiSaveSetting, 'undefined');
  assert.equal(app.ctx.apiSaveTeamSetting({ requestId: 'rt', key: 'RUN_TIMES', value: '13:00, 07:30' }).ok, true);
  assert.equal(app.g('Config').settings('billing').RUN_TIMES, '07:30,13:00');
  assert.equal(app.g('Config').settings('payments').RUN_TIMES, '06:00,13:00', 'other team unchanged');
});

test('ignore list and stop words are independent per team', () => {
  const { app } = setup();
  as(app, 'admin@example.com');
  app.ctx.apiAddListItem({ requestId: 's1', list: 'StopWords', value: 'urgent' });
  app.ctx.apiAddListItem({ requestId: 's2', list: 'SubjectIgnoreList', value: 'password reset' });
  const snap = app.g('Config').snapshot();
  eq(snap.byTeam.billing.stopWords, ['urgent']);
  assert.ok(snap.byTeam.payments.stopWords.length > 10, 'payments still uses the built-in list');
  eq(snap.byTeam.payments.ignoreList, []);
});

/* ───────────── Ivanti lookup; IDs never reach a browser ───────────── */
test('roster takes name and email; the Ivanti ID is looked up on the server', () => {
  const { app, st, Store } = setup();
  as(app, 'admin@example.com');
  st.ivantiPeople['gus@example.com'] = 'OWN-GUS';
  const ok = app.ctx.apiSaveEmployee({ requestId: 'l1', display_name: 'Gus', employee_email: 'Gus@Example.com', ivanti_owner_id: 'TYPED-BY-ADMIN' }).data;
  assert.equal(ok.employee.linked, true);
  assert.equal(ok.lookup.status, 'found');
  assert.equal(ok.lookup.message, null);
  assert.equal(Store.read('Employees').find((e) => e.employee_email === 'gus@example.com').ivanti_owner_id, 'OWN-GUS', 'typed IDs are ignored');
});

test('an email Ivanti does not know is saved, with a clear notice; "Check again" links them later', () => {
  const { app, st } = setup();
  as(app, 'admin@example.com');
  const r = app.ctx.apiSaveEmployee({ requestId: 'l2', display_name: 'Hana', employee_email: 'hana@example.com' }).data;
  assert.equal(r.employee.linked, false);
  assert.equal(r.employee.ivanti_lookup_status, 'not_found');
  assert.match(r.lookup.message, /Saved\. Ivanti has no employee with the email hana@example\.com\. Hana can be scheduled but won't receive tickets/);
  st.ivantiPeople['hana@example.com'] = 'OWN-HANA';
  const again = app.ctx.apiCheckEmployeeLink({ requestId: 'l3', id: r.employee.id }).data;
  assert.equal(again.employee.linked, true);
  assert.match(again.lookup.message, /now linked/);
});

test('Ivanti unreachable: saved with a "couldn\'t reach" notice, and the next run links them', () => {
  const { app, st, Store } = setup();
  as(app, 'admin@example.com');
  st.ivantiLookupDown = true;
  st.ivantiPeople['ivy@example.com'] = 'OWN-IVY';
  const r = app.ctx.apiSaveEmployee({ requestId: 'l4', display_name: 'Ivy', employee_email: 'ivy@example.com' }).data;
  assert.equal(r.employee.ivanti_lookup_status, 'error');
  assert.match(r.lookup.message, /couldn't be reached to link Ivy/);
  st.ivantiLookupDown = false;
  run(app, 'billing');
  assert.equal(Store.read('Employees').find((e) => e.employee_email === 'ivy@example.com').ivanti_owner_id, 'OWN-IVY');
});

test('if the lookup is not set up, the setup check says so and runs stop', () => {
  const { app } = setup();
  app.run('QUERY_CONFIG.ivanti.employeeLookup.enabled = false');
  assert.ok(app.g('Config').check().some((p) => /lookupIvantiEmployee_/.test(p)));
  assert.equal(run(app, 'billing').status, 'stopped_check_failed');
});

test('the change history never stores Ivanti IDs', () => {
  const { app } = setup();
  const sheet = app.mocks.sheets.AuditLog.data;
  assert.ok(sheet.length > 5);
  assert.doesNotMatch(JSON.stringify(sheet), /OWN-[A-Z]+/);
});

test('no response, for any role, ever contains an Ivanti ID', () => {
  const { app, st, ids } = setup();
  st.ivantiIncidents.push(incident(4100, 'Billing', 'Credit memo request for account 55'));
  run(app, 'billing');
  const calls = ['apiBootstrap', 'apiPoll', 'apiGetChanges', 'apiGetWeek', 'apiListRules', 'apiGetTeamSettings', 'apiSearchAssignments',
    'apiListQueue', 'apiRunStatus', 'apiGetAudit', 'apiTestSubject'];
  ['pat@example.com', 'admin@example.com', 'ana@example.com', 'kim@example.com'].forEach((who) => {
    as(app, who);
    calls.forEach((fn) => {
      const res = app.ctx[fn]({ weekStart: '2026-01-05', subject: 'Credit memo request for account 55', since: '' });
      const text = JSON.stringify(res);
      assert.doesNotMatch(text, /ivanti_owner_id/, who + ' ' + fn);
      assert.doesNotMatch(text, /OWN-[A-Z]+/, who + ' ' + fn + ' leaked an ID');
    });
    const saved = app.ctx.apiSaveEmployee({ requestId: 'e-' + who, display_name: 'Zed', employee_email: 'zed-' + who.split('@')[0] + '@example.com' });
    assert.doesNotMatch(JSON.stringify(saved), /OWN-|ivanti_owner_id/);
  });
  void ids;
});

/* ───────────── Range scheduling ───────────── */
test('range: preview, then add a person to a mailbox for two working weeks in one save', () => {
  const { app, ids, Store } = setup();
  as(app, 'admin@example.com');
  app.ctx.apiScheduleAdd({ requestId: 'pre', date: '2030-02-05', mailboxId: ids.general, employeeId: ids.ana });
  app.ctx.apiScheduleAdd({ requestId: 'pre2', date: '2030-02-06', mailboxId: ids.billing, employeeId: ids.ana });
  const args = { employeeId: ids.ana, mailboxId: ids.general, from: '2030-02-04', to: '2030-02-15', days: ['MON', 'TUE', 'WED', 'THU', 'FRI'] };
  const prev = app.ctx.apiScheduleRange(Object.assign({ preview: true }, args)).data;
  assert.equal(prev.dates, 10);
  assert.equal(prev.add, 9);
  assert.equal(prev.skip, 1);
  eq(prev.alsoOn.map((x) => [x.date, x.mailbox]), [['2030-02-06', 'Billing - Special Handling']]);
  const before = Store.read('Schedule').length;
  assert.equal(Store.read('Schedule').length, before, 'preview saves nothing');
  const saved = app.ctx.apiScheduleRange(Object.assign({ requestId: 'rng' }, args)).data;
  eq([saved.added, saved.skipped], [9, 1]);
  const again = app.ctx.apiScheduleRange(Object.assign({ requestId: 'rng2' }, args)).data;
  eq([again.added, again.skipped], [0, 10], 'running it twice adds nothing');
  const entries = Store.read('Schedule').filter((e) => e.employee_id === ids.ana && e.mailbox_id === ids.general && e.date >= '2030-02-04');
  assert.equal(entries.length, 10);
  assert.ok(entries.every((e) => !['SAT', 'SUN'].includes(['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][new Date(e.date + 'T12:00:00Z').getUTCDay()])));
});

test('range: remove clears a person from a mailbox over a range', () => {
  const { app, ids, Store } = setup();
  as(app, 'admin@example.com');
  const base = { employeeId: ids.ben, mailboxId: ids.general, from: '2030-03-04', to: '2030-03-08', days: ['MON', 'TUE', 'WED', 'THU', 'FRI'] };
  app.ctx.apiScheduleRange(Object.assign({ requestId: 'a' }, base));
  const r = app.ctx.apiScheduleRange(Object.assign({ requestId: 'b', action: 'remove', from: '2030-03-06' }, base, { from: '2030-03-06' })).data;
  assert.equal(r.removed, 3);
  assert.equal(Store.read('Schedule').filter((e) => e.employee_id === ids.ben && e.mailbox_id === ids.general && e.date >= '2030-03-04').length, 2);
});

test('range: limits and validation', () => {
  const { app, ids } = setup();
  as(app, 'admin@example.com');
  const base = { requestId: 'v', employeeId: ids.ana, mailboxId: ids.general, days: ['MON'] };
  assert.match(app.ctx.apiScheduleRange(Object.assign({}, base, { from: '2030-01-01', to: '2030-06-01' })).error.message, /at most 92 days/);
  assert.match(app.ctx.apiScheduleRange(Object.assign({}, base, { from: '2030-01-10', to: '2030-01-01' })).error.message, /on or after/);
  assert.match(app.ctx.apiScheduleRange(Object.assign({}, base, { from: '2030-01-01', to: '2030-01-05', days: [] })).error.message, /at least one day/);
  assert.equal(app.ctx.apiScheduleRange(Object.assign({}, base, { from: '2030-01-01', to: '2030-01-31', employeeId: ids.eve })).error.type, 'ValidationError', 'another team\'s employee');
});

/* ───────────── Routing with teams ───────────── */
test('when two teams\' rules match, the team listed first wins', () => {
  const { app, ids, st, A } = setup();
  as(app, 'kim@example.com');
  app.ctx.apiSaveRule({ requestId: 'k', mailboxId: ids.cards, conditions: [{ field: 'Category', op: 'equals', value: 'General' }] });
  st.ivantiIncidents.push(incident(300, 'General', 'Cannot open shared drive folder'));
  const pay = run(app, 'payments');
  assert.equal(pay.otherTeams, 1, 'payments run leaves it for billing');
  assert.equal(A.length, 0);
  run(app, 'billing');
  assert.equal(A[0].team_id, 'billing');
  assert.equal(A[0].mailbox_id, ids.general);
});

test('each team\'s run assigns only its own tickets; the rest wait in Ivanti for their team', () => {
  const { app, st, A } = setup();
  st.ivantiIncidents.push(incident(4100, 'Billing', 'Credit memo request for account 55'));
  st.ivantiIncidents.push(incident(8000, 'Payments', 'Card declined at checkout for order 77'));
  const b = run(app, 'billing');
  assert.equal(b.assigned, 1); assert.equal(b.otherTeams, 1);
  assert.ok(st.ivantiIncidents.find((x) => x.IncidentNumber === 8000).Owner === null, 'payments ticket still unassigned in Ivanti');
  const p = run(app, 'payments');
  assert.equal(p.assigned, 1);
  eq(live(A).map((a) => a.team_id).sort(), ['billing', 'payments']);
});

test('follow-ups stay within the team that routed the ticket', () => {
  const { app, ids, st, A } = setup();
  A.push({ ticket_id: '50', team_id: 'billing', ivanti_rec_id: 'R50', subject: 'Card declined at checkout for order 77', mailbox_id: ids.general,
    employee_id: ids.cy, routing_method: 'rule', counts_toward_balance: true, dry_run: false, assigned_at: '2026-10-01T12:00:00Z', version: 1, writeback_status: 'success', writeback_attempts: 1 });
  st.ivantiIncidents.push(incident(8001, 'Payments', 'RE: Card declined at checkout for order 77'));
  run(app, 'payments');
  const row = live(A).find((a) => a.ticket_id === '8001');
  assert.equal(row.team_id, 'payments');
  assert.equal(row.routing_method, 'rule', 'billing history is not used for a payments ticket');
  assert.equal(row.employee_id, ids.eve);
});

test('no rule matched but a follow-up of another team\'s ticket: it joins that team and goes to the earlier owner', () => {
  const { app, ids, st, A } = setup();
  A.push({ ticket_id: '60', team_id: 'payments', ivanti_rec_id: 'R60', subject: 'Chargeback form for merchant 4411 missing', mailbox_id: ids.cards,
    employee_id: ids.finn, routing_method: 'rule', counts_toward_balance: true, dry_run: false, assigned_at: '2026-10-01T12:00:00Z', version: 1, writeback_status: 'success', writeback_attempts: 1 });
  st.ivantiIncidents.push(incident(9100, 'Hardware', 'RE: Chargeback form for merchant 4411 missing'));
  const b = run(app, 'billing');
  assert.equal(b.otherTeams, 1);
  run(app, 'payments');
  const row = live(A).find((a) => a.ticket_id === '9100');
  eq([row.team_id, row.employee_id, row.routing_method, row.mailbox_id], ['payments', ids.finn, 'follow_up', ids.cards]);
});

test('Vertex is offered only rule-less mailboxes; with Vertex not built yet, the ticket goes to the shared queue', () => {
  const { app, st, Q } = setup();
  let seen = null;
  app.run('classifyTicket_ = function (p) { __seen(p); return null; }');
  app.ctx.__seen = (p) => { seen = p; };
  st.ivantiIncidents.push(incident(9200, 'Hardware', 'Docking station not charging laptop'));
  run(app, 'billing');
  eq(seen.candidate_mailboxes.map((m) => [m.name, m.team_name]), [['Payments triage', 'Payments']]);
  assert.equal(Q[0].team_id, null);
  assert.equal(Q[0].status, 'pending');
});

test('Vertex picking a rule-less mailbox assigns the ticket within that mailbox\'s team', () => {
  const { app, ids, st, A } = setup();
  app.run(`classifyTicket_ = function (p) { return { mailboxId: p.candidate_mailboxes[0].mailbox_id, confidence: 0.9, rationale: 'looks like payments' }; }`);
  st.ivantiIncidents.push(incident(9300, 'Hardware', 'Refund to card ending 4242 not showing'));
  run(app, 'payments');
  const row = live(A).find((a) => a.ticket_id === '9300');
  eq([row.team_id, row.mailbox_id, row.employee_id, row.routing_method], ['payments', ids.paytriage, ids.finn, 'vertex']);
});

test('team queue: matched mailbox with nobody scheduled, or only unlinked people, stays with that team', () => {
  const { app, ids, st, Q, Store } = setup();
  Store.mutate({ user: 'pat@example.com', teamId: 'billing' }, (tx) => {
    const dee = tx.find('Employees', ids.dee);
    tx.update('Employees', dee.id, { ivanti_owner_id: '', ivanti_lookup_status: 'not_found' });
  });
  delete st.ivantiPeople['dee@example.com'];
  st.ivantiIncidents.push(incident(301, 'General', 'Monitor arm is loose and wobbling'));
  const r = run(app, 'billing');
  eq(r.unlinkedScheduled, ['Dee'], 'run summary names who was skipped');
  assert.equal(Q[0].team_id, 'billing');
  assert.equal(Q[0].status, 'no_linked_employee');
  as(app, 'kim@example.com');
  assert.equal(app.ctx.apiListQueue().data.team.length, 0, 'payments does not see billing\'s team queue');
  as(app, 'admin@example.com');
  assert.equal(app.ctx.apiListQueue().data.team[0].ticket_id, '301');
});

/* ───────────── Shared queue ───────────── */
test('shared queue: every team sees it, with only the developer-chosen fields', () => {
  const { app, st } = setup();
  st.ivantiIncidents.push(incident(9400, 'Hardware', 'Badge reader at north entrance not working'));
  run(app, 'billing');
  ['admin@example.com', 'kim@example.com'].forEach((who) => {
    as(app, who);
    const q = app.ctx.apiListQueue().data;
    assert.equal(q.shared.length, 1, who);
    eq(Object.keys(q.shared[0].fields).sort(), ['createdAt', 'ticketId']);
    assert.doesNotMatch(JSON.stringify(q), /Badge reader/, 'subject not shown until the developer allows it');
  });
  app.run("QUERY_CONFIG.sharedQueue.visibleFields = ['ticketId', 'subject', 'Category']");
  const q = app.ctx.apiListQueue().data;
  assert.equal(q.shared[0].fields.subject, 'Badge reader at north entrance not working');
  assert.equal(q.shared[0].fields.Category, 'Hardware');
  eq(q.sharedFields.map((f) => f.label), ['Ticket', 'Subject', 'Category']);
});

test('shared queue: two teams pull the same ticket; the first wins and the second is told who took it', () => {
  const { app, ids, st, A } = setup();
  st.ivantiIncidents.push(incident(9500, 'Hardware', 'Laptop fan very loud after update'));
  run(app, 'billing');
  as(app, 'kim@example.com');
  const kimView = app.ctx.apiListQueue().data.shared[0];
  as(app, 'admin@example.com');
  const adminView = app.ctx.apiListQueue().data.shared[0];
  assert.equal(app.ctx.apiResolveQueue({ ticketId: adminView.ticket_id, mailboxId: ids.general, version: adminView.version }).ok, true);
  as(app, 'kim@example.com');
  const lost = app.ctx.apiResolveQueue({ ticketId: kimView.ticket_id, mailboxId: ids.cards, version: kimView.version });
  assert.equal(lost.error.type, 'ConflictError');
  assert.equal(lost.error.message, 'Billing Support already took this ticket.');
  assert.equal(live(A).filter((a) => a.ticket_id === '9500').length, 1);
  assert.equal(live(A).find((a) => a.ticket_id === '9500').team_id, 'billing');
  assert.equal(app.ctx.apiListQueue().data.shared.length, 0, 'gone from everyone\'s shared queue');
});

test('shared queue: a team can only pull tickets into its own mailboxes', () => {
  const { app, ids, st } = setup();
  st.ivantiIncidents.push(incident(9600, 'Hardware', 'Projector in room 4 has no signal'));
  run(app, 'billing');
  as(app, 'kim@example.com');
  const item = app.ctx.apiListQueue().data.shared[0];
  assert.equal(app.ctx.apiResolveQueue({ ticketId: item.ticket_id, mailboxId: ids.general, version: item.version }).error.type, 'ValidationError');
});
