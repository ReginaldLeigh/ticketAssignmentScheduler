/**
 * Simultaneous use (D22), run lease (§6.6) and the 6 AM / 1 PM weekday schedule (D15, D20).
 * Apps Script runs each request in its own execution; these tests interleave the operations two
 * users would perform and check the outcome is the one the plan promises.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, seed } = require('./harness');

const plain = (v) => JSON.parse(JSON.stringify(v));
function setup() {
  const app = loadApp();
  const today = app.g('Config').today();
  const ids = seed(app, today);
  return { app, today, ids, Store: app.g('Store') };
}
const as = (app, email) => { app.mocks.state.user = email; };

/* ───────────── Store: versions, ids, duplicates, request ids, locking ───────────── */
test('two admins edit the same rule from the same version: one wins, the other gets a conflict (no silent overwrite)', () => {
  const { app } = setup();
  as(app, 'admin@example.com');
  const rule = app.ctx.apiListRules().data.rules[0];
  const a = app.ctx.apiSaveRule({ requestId: 'a', id: rule.id, version: rule.version, mailboxId: rule.mailbox_id, conditions: [{ field: 'Category', op: 'equals', value: 'A' }] });
  const b = app.ctx.apiSaveRule({ requestId: 'b', id: rule.id, version: rule.version, mailboxId: rule.mailbox_id, conditions: [{ field: 'Category', op: 'equals', value: 'B' }] });
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  assert.equal(b.error.type, 'ConflictError');
  assert.equal(b.error.details.current.conditions_json[0].value, 'A', 'conflict shows the other person\'s version');
  assert.equal(b.error.details.updatedBy, 'admin@example.com');
  const saved = app.ctx.apiListRules().data.rules.find((r) => r.id === rule.id);
  assert.equal(saved.conditions_json[0].value, 'A');
  // "Re-apply my change" = save again on top of the new version.
  const c = app.ctx.apiSaveRule({ requestId: 'c', id: rule.id, version: saved.version, mailboxId: rule.mailbox_id, conditions: [{ field: 'Category', op: 'equals', value: 'B' }] });
  assert.equal(c.ok, true);
});

test('20 different schedule cells added "at once": all saved, none lost, no duplicates', () => {
  const { app, ids } = setup();
  const days = ['2030-03-04', '2030-03-05', '2030-03-06', '2030-03-07', '2030-03-08'];
  const emps = [ids.ana, ids.ben, ids.cy, ids.dee];
  let n = 0;
  days.forEach((d) => emps.forEach((e) => { assert.equal(app.ctx.apiScheduleAdd({ requestId: 'q' + (n++), date: d, mailboxId: ids.general, employeeId: e }).ok, true); }));
  const rows = app.g('Store').read('Schedule').filter((e) => e.date >= '2030-03-04');
  assert.equal(rows.length, 20);
  assert.equal(new Set(rows.map((r) => r.date + r.employee_id)).size, 20);
});

test('10 adds of the SAME cell: exactly one entry, the rest report "already scheduled"', () => {
  const { app, ids } = setup();
  const results = [];
  for (let i = 0; i < 10; i++) results.push(app.ctx.apiScheduleAdd({ requestId: 'same' + i, date: '2030-01-07', mailboxId: ids.billing, employeeId: ids.ana }).data.status);
  assert.equal(results.filter((s) => s === 'added').length, 1);
  assert.equal(results.filter((s) => s === 'already_scheduled').length, 9);
  assert.equal(app.g('Store').read('Schedule').filter((e) => e.date === '2030-01-07').length, 1);
});

test('the same requestId (double-click / automatic retry) is processed once', () => {
  const { app, ids } = setup();
  const r1 = app.ctx.apiSaveMailbox({ requestId: 'dbl', name: 'Escalations', description: '' });
  const r2 = app.ctx.apiSaveMailbox({ requestId: 'dbl', name: 'Escalations', description: '' });
  assert.equal(r1.ok, true); assert.equal(r2.ok, true);
  assert.equal(r1.data.id, r2.data.id, 'same answer returned');
  assert.equal(app.g('Store').read('Mailboxes').filter((m) => m.name === 'Escalations').length, 1);
  void ids;
});

test('a delete never shifts rows under another user\'s save (records found by id)', () => {
  const { app, ids, today } = setup();
  const entries = app.g('Store').read('Schedule').filter((e) => e.date === today);
  const first = entries[0], second = entries[1];
  assert.equal(app.ctx.apiScheduleRemove({ requestId: 'del', id: first.id, version: first.version }).ok, true);
  const mv = app.ctx.apiScheduleMove({ requestId: 'mv', id: second.id, version: second.version, date: '2030-02-01', mailboxId: ids.general });
  assert.equal(mv.ok, true, JSON.stringify(mv.error));
  const after = app.g('Store').read('Schedule', { includeDeleted: true });
  assert.ok(after.find((e) => e.id === first.id).deleted_at, 'first is soft-deleted');
  assert.equal(after.find((e) => e.id === second.id).date, '2030-02-01', 'the right record moved');
  assert.equal(after.length, entries.length, 'no rows physically removed');
});

test('removing an entry someone already removed is a no-op, moving it reports it is gone', () => {
  const { app, today, ids } = setup();
  const e = app.g('Store').read('Schedule').find((x) => x.date === today);
  app.ctx.apiScheduleRemove({ requestId: 'r1', id: e.id, version: e.version });
  assert.equal(app.ctx.apiScheduleRemove({ requestId: 'r2', id: e.id, version: e.version }).data.status, 'already_removed');
  assert.equal(app.ctx.apiScheduleMove({ requestId: 'r3', id: e.id, version: e.version, date: today, mailboxId: ids.general }).error.type, 'NotFoundError');
});

test('a stale move (entry changed since it was loaded) is rejected', () => {
  const { app, today, ids } = setup();
  const e = app.g('Store').read('Schedule').find((x) => x.date === today);
  assert.equal(app.ctx.apiScheduleMove({ requestId: 'm1', id: e.id, version: e.version, date: '2030-01-01', mailboxId: ids.general }).ok, true);
  const stale = app.ctx.apiScheduleMove({ requestId: 'm2', id: e.id, version: e.version, date: '2030-01-02', mailboxId: ids.general });
  assert.equal(stale.error.type, 'ConflictError');
});

test('Copy last week clicked by two admins: second copy adds nothing', () => {
  const { app, today } = setup();
  const r1 = app.ctx.apiScheduleCopyWeek({ requestId: 'c1', fromStart: today, toStart: '2031-06-02' }).data;
  const r2 = app.ctx.apiScheduleCopyWeek({ requestId: 'c2', fromStart: today, toStart: '2031-06-02' }).data;
  assert.ok(r1.added >= 4);
  assert.equal(r2.added, 0);
  assert.equal(r2.skipped, r1.added);
});

test('saving against data someone just deactivated is refused (checked inside the lock)', () => {
  const { app, ids } = setup();
  const mb = app.g('Store').read('Mailboxes').find((m) => m.id === ids.general);
  assert.equal(app.ctx.apiSaveMailbox({ requestId: 'd1', id: mb.id, version: mb.version, name: mb.name, description: '', active: false }).ok, true);
  const r = app.ctx.apiScheduleAdd({ requestId: 'd2', date: '2030-01-09', mailboxId: ids.general, employeeId: ids.ana });
  assert.equal(r.error.type, 'ValidationError');
  const rule = app.ctx.apiSaveRule({ requestId: 'd3', mailboxId: ids.general, conditions: [{ field: 'Category', op: 'equals', value: 'X' }] });
  assert.equal(rule.error.type, 'ValidationError');
});

test('an error part-way through a change set writes nothing (all-or-nothing)', () => {
  const { app, Store } = setup();
  const before = JSON.stringify(app.mocks.sheets.Mailboxes.data);
  const auditBefore = app.mocks.sheets.AuditLog.data.length;
  assert.throws(() => Store.mutate({ user: 'admin@example.com' }, (tx) => {
    tx.insert('Mailboxes', { name: 'One', priority: 9 });
    tx.insert('Mailboxes', { name: 'Two', priority: 10 });
    throw new Error('validation failed half-way');
  }));
  assert.equal(JSON.stringify(app.mocks.sheets.Mailboxes.data), before);
  assert.equal(app.mocks.sheets.AuditLog.data.length, auditBefore);
});

test('when the lock is busy the server answers BusyError (the browser retries)', () => {
  const { app, ids } = setup();
  app.mocks.state.lockBusy = true;
  const r = app.ctx.apiScheduleAdd({ requestId: 'busy', date: '2030-01-07', mailboxId: ids.billing, employeeId: ids.ana });
  assert.equal(r.error.type, 'BusyError');
  app.mocks.state.lockBusy = false;
  assert.equal(app.ctx.apiScheduleAdd({ requestId: 'busy', date: '2030-01-07', mailboxId: ids.billing, employeeId: ids.ana }).data.status, 'added');
});

test('every save writes an audit row and bumps the revision other pages poll', () => {
  const { app, ids } = setup();
  const revBefore = app.ctx.apiPoll().data.revisions.Schedule;
  const auditBefore = app.mocks.sheets.AuditLog.data.length;
  app.ctx.apiScheduleAdd({ requestId: 'au', date: '2030-01-08', mailboxId: ids.billing, employeeId: ids.ben });
  assert.equal(app.ctx.apiPoll().data.revisions.Schedule, revBefore + 1);
  assert.equal(app.mocks.sheets.AuditLog.data.length, auditBefore + 1);
  as(app, 'pat@example.com');   // the team's manager sees the admin's change
  const notes = app.ctx.apiGetChanges({ since: '' }).data.notes;
  assert.ok(notes.some((n) => /admin added Ben to Billing/.test(n)), notes.join(' | '));
});

test('user text that looks like a formula is stored as text', () => {
  const { app } = setup();
  app.ctx.apiSaveMailbox({ requestId: 'f1', name: '=IMPORTRANGE("x")', description: '+1' });
  const nameCol = app.mocks.sheets.Mailboxes.data[0].indexOf('name');
  const raw = app.mocks.sheets.Mailboxes.data.find((r) => String(r[nameCol]).indexOf('IMPORTRANGE') !== -1);
  assert.equal(raw[nameCol], '=IMPORTRANGE("x")', 'mock Sheets strips the protective apostrophe, as real Sheets does');
  assert.equal(app.g('Store').read('Mailboxes').find((m) => /IMPORTRANGE/.test(m.name)).name, '=IMPORTRANGE("x")');
});

/* ───────────── Roles ───────────── */
test('employees can view their team and use Run now, but cannot change anything', () => {
  const { app, ids } = setup();
  as(app, 'ana@example.com');
  const boot = app.ctx.apiBootstrap().data;
  assert.equal(boot.role, 'employee');
  assert.equal(boot.isAdmin, false);
  assert.equal(boot.team.name, 'Billing Support');
  assert.equal(app.ctx.apiGetWeek({ weekStart: '2030-01-07' }).ok, true);
  assert.equal(boot.employees[0].employee_email, undefined, 'employees see names only');
  ['apiScheduleAdd', 'apiScheduleRange', 'apiSaveMailbox', 'apiSaveRule', 'apiSaveEmployee', 'apiSaveTeamSetting', 'apiAddListItem', 'apiListQueue',
    'apiSearchAssignments', 'apiGetTeamSettings', 'apiGetAudit']
    .forEach((fn) => assert.equal(app.ctx[fn]({ requestId: 'v', date: '2030-01-07', from: '2030-01-07', to: '2030-01-08', days: ['MON'], mailboxId: ids.billing,
      employeeId: ids.ana, name: 'x', key: 'RUN_TIMES', value: '06:00', list: 'StopWords', display_name: 'x', employee_email: 'x@example.com' }).error.type, 'PermissionError', fn));
  assert.equal(app.ctx.apiRunNow({}).ok, true, 'every role can Run now');
  assert.equal(app.ctx.apiRunNow({ dryRun: true }).error.type, 'PermissionError', 'dry run is for managers and admins');
});

test('someone on no team is refused, with a clear message', () => {
  const { app } = setup();
  as(app, 'stranger@example.com');
  const r = app.ctx.apiBootstrap();
  assert.equal(r.error.type, 'PermissionError');
  assert.match(r.error.message, /not on a team/);
  as(app, '');
  assert.equal(app.ctx.apiBootstrap().error.type, 'PermissionError');
});

test('only managers can add or remove admins; admins can see the list', () => {
  const { app } = setup();
  as(app, 'admin@example.com');
  assert.equal(app.ctx.apiAddListItem({ requestId: 'a1', list: 'Admins', value: 'new@example.com' }).error.type, 'PermissionError');
  assert.ok(app.ctx.apiGetTeamSettings().data.Admins.some((a) => a.email === 'admin@example.com'));
  as(app, 'pat@example.com');
  const added = app.ctx.apiAddListItem({ requestId: 'a2', list: 'Admins', value: 'new@example.com' });
  assert.equal(added.ok, true);
  as(app, 'new@example.com');
  assert.equal(app.ctx.apiBootstrap().data.role, 'admin');
  as(app, 'pat@example.com');
  assert.equal(app.ctx.apiRemoveListItem({ requestId: 'a3', list: 'Admins', id: added.data.item.id, version: added.data.item.version }).ok, true);
  as(app, 'new@example.com');
  assert.equal(app.ctx.apiBootstrap().error.type, 'PermissionError', 'removed admin loses access');
});

/* ───────────── Run lease ───────────── */
test('lease: two Run now clicks at once → exactly one run starts', () => {
  const { app } = setup();
  const Lease = app.g('Lease');
  const a = Lease.acquire({ runId: 'r1', startedBy: 'a@example.com', trigger: 'manual' });
  const b = Lease.acquire({ runId: 'r2', startedBy: 'b@example.com', trigger: 'manual' });
  assert.equal(a.acquired, true);
  assert.equal(b.acquired, false);
  assert.equal(b.current.startedBy, 'a@example.com');
  const run = app.g('Pipeline').run({ teamId: 'payments', trigger: 'manual', triggeredBy: 'kim@example.com' });
  assert.equal(run.status, 'busy', 'one run at a time across the app, even for another team');
});

test('lease: an admin save during a run goes through immediately', () => {
  const { app, ids } = setup();
  app.g('Lease').acquire({ runId: 'r1', startedBy: 'system', trigger: 'scheduled' });
  assert.equal(app.ctx.apiScheduleAdd({ requestId: 'during', date: '2030-01-07', mailboxId: ids.billing, employeeId: ids.ana }).ok, true);
});

test('lease: a crashed run\'s lease expires after 10 minutes', () => {
  const { app } = setup();
  app.mocks.props.set('run_lease', JSON.stringify({ runId: 'dead', startedBy: 'system', expiresAt: new Date(Date.now() - 1000).toISOString() }));
  assert.equal(app.g('Lease').current(), null);
  assert.equal(app.g('Lease').acquire({ runId: 'new', startedBy: 'x', trigger: 'manual' }).acquired, true);
});

test('lease: a continuation can take over its own run\'s lease, nobody else can', () => {
  const { app } = setup();
  const Lease = app.g('Lease');
  Lease.acquire({ runId: 'r1', startedBy: 'system', trigger: 'scheduled' });
  assert.equal(Lease.acquire({ runId: 'r2', startedBy: 'system', trigger: 'continuation', takeOverRunId: 'r0' }).acquired, false);
  assert.equal(Lease.acquire({ runId: 'r2', startedBy: 'system', trigger: 'continuation', takeOverRunId: 'r1' }).acquired, true);
});

test('Run now cooldown: a second click right after a run waits', () => {
  const { app } = setup();
  assert.equal(app.ctx.apiRunNow({}).data.status, 'succeeded');
  const again = app.ctx.apiRunNow({}).data;
  assert.equal(again.status, 'cooldown');
  assert.ok(again.minutesLeft >= 1);
});

/* ───────────── Schedule of automatic runs ───────────── */
test('triggers: runs at 6:00 and 13:00 on weekdays only, once per slot', () => {
  const app = loadApp();
  const T = app.g('Triggers');
  const s = { RUN_TIMES: '06:00,13:00', RUN_DAYS: 'MON,TUE,WED,THU,FRI' };
  const at = (iso) => new Date(iso); // times below are New York local, written as UTC (-05:00 in November)
  const tz = 'America/New_York';
  assert.equal(T.dueSlot(at('2026-11-16T10:59:00Z'), s, null, tz), null, 'Mon 05:59 — not yet');
  assert.equal(T.dueSlot(at('2026-11-16T11:04:00Z'), s, null, tz), '2026-11-16 06:00', 'Mon 06:04 — due');
  assert.equal(T.dueSlot(at('2026-11-16T11:14:00Z'), s, '2026-11-16 06:00', tz), null, 'Mon 06:14 — already ran');
  assert.equal(T.dueSlot(at('2026-11-16T18:02:00Z'), s, '2026-11-16 06:00', tz), '2026-11-16 13:00', 'Mon 13:02 — due');
  assert.equal(T.dueSlot(at('2026-11-16T23:00:00Z'), s, '2026-11-16 13:00', tz), null, 'Mon 18:00 — done for the day');
  assert.equal(T.dueSlot(at('2026-11-21T11:05:00Z'), s, '2026-11-20 13:00', tz), null, 'Saturday — no run');
  assert.equal(T.dueSlot(at('2026-11-22T18:05:00Z'), s, '2026-11-20 13:00', tz), null, 'Sunday — no run');
  assert.equal(T.dueSlot(at('2026-11-23T11:05:00Z'), s, '2026-11-20 13:00', tz), '2026-11-23 06:00', 'Monday 06:05 picks up the weekend');
  assert.equal(T.dueSlot(at('2026-11-17T16:00:00Z'), s, '2026-11-16 13:00', tz), '2026-11-17 06:00', 'missed 06:00 runs late, once');
});

test('triggers: each team runs at its own times; a busy tick retries; a slot never runs twice', () => {
  const { app } = setup();
  const T = app.g('Triggers');
  as(app, 'admin@example.com');
  assert.equal(app.ctx.apiSaveTeamSetting({ requestId: 's1', key: 'RUN_DAYS', value: 'MON,TUE,WED,THU,FRI,SAT,SUN' }).ok, true);
  assert.equal(app.ctx.apiSaveTeamSetting({ requestId: 's2', key: 'RUN_TIMES', value: '00:00' }).ok, true);
  // payments keeps the default 06:00/13:00; 03:00 New York time means only billing is due
  const early = new Date(Date.UTC(2026, 10, 17, 8, 0, 0));   // Tue 03:00 in New York
  app.g('Lease').acquire({ runId: 'other', startedBy: 'someone', trigger: 'manual' });
  const busy = T.tick(early);
  assert.equal(busy.runs[0].status, 'busy');
  assert.equal(app.mocks.props.get('last_run_slot:billing'), undefined, 'slot not marked as done');
  app.g('Lease').release('other', false);
  const ok = T.tick(early);
  assert.equal(ok.runs.length, 1);
  assert.equal(ok.runs[0].teamId, 'billing');
  assert.equal(ok.runs[0].status, 'succeeded');
  assert.ok(app.mocks.props.get('last_run_slot:billing'));
  assert.equal(T.tick(early).status, 'idle', 'same slot never runs twice');
  assert.equal(app.mocks.props.get('last_run_slot:payments'), undefined, 'payments was not due');
});

test('triggers: install keeps exactly one ticker', () => {
  const app = loadApp();
  app.g('Triggers').install(); app.g('Triggers').install();
  assert.equal(app.mocks.triggers.filter((t) => t.getHandlerFunction() === 'tick').length, 1);
  void plain;
});
