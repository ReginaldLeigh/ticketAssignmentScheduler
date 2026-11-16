/** Rules, subject matching and the ±1 balancer. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, formatDate } = require('./harness');

const app = loadApp();
const Rules = app.g('Rules'), Subject = app.g('Subject'), Balancer = app.g('Balancer');
const STOP = app.g('DEFAULT_STOP_WORDS');
const t = (fields) => ({ fields });
/** Values from the Apps Script sandbox have their own prototypes; compare as plain JSON. */
const plain = (v) => JSON.parse(JSON.stringify(v));

/* ───────────── Rules ───────────── */
test('rules: every operator', () => {
  const ticket = t({ Category: 'Billing', IncidentNumber: 4500, Subject: 'Invoice 12 overdue', Priority: '', Source: 'Email' });
  const yes = [
    { field: 'Category', op: 'equals', value: 'billing' }, { field: 'Category', op: 'not_equals', value: 'Hardware' },
    { field: 'Subject', op: 'contains', value: 'overdue' }, { field: 'Subject', op: 'starts_with', value: 'invoice' },
    { field: 'Source', op: 'in', value: ['Phone', 'email'] }, { field: 'IncidentNumber', op: 'between', value: [4000, 5000] },
    { field: 'IncidentNumber', op: 'gt', value: 4499 }, { field: 'IncidentNumber', op: 'lt', value: 4501 },
    { field: 'Subject', op: 'regex', value: '^invoice \\d+' }, { field: 'Priority', op: 'is_empty', value: null },
    { field: 'IncidentNumber', op: 'equals', value: '4500' }, { field: 'category', op: 'equals', value: 'Billing' },
  ];
  yes.forEach((c) => assert.equal(Rules.evaluateCondition(c, ticket), true, JSON.stringify(c)));
  const no = [
    { field: 'IncidentNumber', op: 'between', value: [5001, 6000] }, { field: 'Category', op: 'equals', value: 'Hardware' },
    { field: 'Missing', op: 'contains', value: 'x' }, { field: 'Subject', op: 'gt', value: 3 }, { field: 'Source', op: 'is_empty', value: null },
  ];
  no.forEach((c) => assert.equal(Rules.evaluateCondition(c, ticket), false, JSON.stringify(c)));
});

test('rules: validation rejects bad input with clear messages', () => {
  const bad = [[], [{ field: '', op: 'equals', value: 'x' }], [{ field: 'A', op: 'nope', value: 'x' }],
    [{ field: 'A', op: 'between', value: [1] }], [{ field: 'A', op: 'regex', value: '(' }], [{ field: 'A', op: 'equals', value: '' }],
    [{ field: 'A; DROP', op: 'equals', value: 'x' }]];
  bad.forEach((c) => assert.throws(() => Rules.validate(c), (e) => e.name === 'ValidationError', JSON.stringify(c)));
  assert.deepEqual(plain(Rules.validate([{ field: 'N', op: 'between', value: ['9', '3'] }])[0].value), [3, 9]);
  assert.deepEqual(plain(Rules.validate([{ field: 'S', op: 'in', value: 'a, b ,,c' }])[0].value), ['a', 'b', 'c']);
});

test('rules: mailboxes are checked in priority order; first match wins; AND within a rule', () => {
  const snap = {
    mailboxes: [{ id: 'm1', priority: 1 }, { id: 'm2', priority: 2 }],
    rules: [
      { id: 'r2', mailbox_id: 'm2', version: 1, conditions_json: [{ field: 'Category', op: 'equals', value: 'Billing' }] },
      { id: 'r1', mailbox_id: 'm1', version: 3, conditions_json: [{ field: 'Category', op: 'equals', value: 'Billing' }, { field: 'IncidentNumber', op: 'between', value: [4000, 5000] }] },
    ],
  };
  assert.deepEqual(plain(Rules.route(t({ Category: 'Billing', IncidentNumber: 4200 }), snap)), { mailboxId: 'm1', ruleId: 'r1', ruleVersion: 3 });
  assert.equal(Rules.route(t({ Category: 'Billing', IncidentNumber: 9000 }), snap).mailboxId, 'm2');
  assert.equal(Rules.route(t({ Category: 'Hardware' }), snap), null);
});

/* ───────────── Subject matching ───────────── */
test('subject: clean-up strips reply prefixes and punctuation, keeps numbers', () => {
  assert.equal(Subject.normalize('RE: FW: Re:Invoice #4471 — late fee!'), 'invoice 4471 late fee');
  assert.equal(Subject.normalize('[EXT] Fwd: Refund?'), 'refund');
  assert.equal(Subject.seq('RE: My invoice 4471 is late, please help', STOP), 'invoice 4471 late help');
});

test('subject: word overlap example from the plan scores 0.83 (no stop words)', () => {
  const a = Subject.seq('Refund not received order 8812', []), b = Subject.seq('Order 8812 refund still not received', []);
  assert.equal(Math.round(Subject.score(a, b, 3) * 100) / 100, 0.83);
});

test('subject: containment matches a shorter subject inside a longer one', () => {
  const a = Subject.seq('invoice 4471 late fee', STOP), b = Subject.seq('Question about invoice 4471 late fee', STOP);
  assert.equal(Subject.score(a, b, 3), 1);
  assert.equal(Subject.score(Subject.seq('late fee', STOP), b, 3), 0.5, 'shorter than min words → overlap only');
});

test('subject: different numbers are different issues', () => {
  const a = Subject.seq('Invoice 4471 charged twice', STOP), b = Subject.seq('Invoice 5520 charged twice', STOP);
  assert.ok(Subject.score(a, b, 3) < 0.75);
});

test('subject: short and ignored subjects are never follow-ups', () => {
  assert.equal(Subject.isEligible('Help', STOP, 3, []), false);
  assert.equal(Subject.isEligible('RE: Password reset needed', STOP, 3, ['password reset needed']), false);
  assert.equal(Subject.isEligible('Printer on floor 3 jammed', STOP, 3, ['password reset needed']), true);
});

test('subject: JavaScript scoring agrees with the SQL-equivalent scoring used in BigQuery', () => {
  // The mock BigQuery in harness.js re-implements SQL.historyMatch independently; compare on many pairs.
  const subjects = ['RE: Invoice 4471 late fee', 'Invoice 4471 late fee question', 'Refund not received for order 8812',
    'FW: Order 8812 refund still missing', 'VPN keeps disconnecting at home', '[EXT] vpn disconnecting at home again',
    'Password reset', 'New laptop request for Dana', 'Laptop request for new hire Dana', 'Invoice 5520 late fee'];
  const prefix = app.g('QUERY_CONFIG').subjectMatching.prefixPattern;
  const sqlSeq = (s) => String(s).toLowerCase().replace(new RegExp(prefix), '').replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').filter((w) => w && !STOP.includes(w)).join(' ');
  subjects.forEach((a) => subjects.forEach((b) => assert.equal(Subject.seq(a, STOP), sqlSeq(a)) || assert.equal(Subject.seq(b, STOP), sqlSeq(b))));
});

/* ───────────── Balancer ───────────── */
function simulate(employees, n, start, rng) {
  const counts = Object.assign({}, start || {});
  for (let i = 0; i < n; i++) Balancer.record(counts, 'mb', Balancer.pick('mb', employees, counts, rng));
  return employees.map((e) => counts[Balancer.countKey('mb', e)] || 0);
}

test('balancer: 100 tickets across 4 people stay within ±1 at every step', () => {
  const emps = ['a', 'b', 'c', 'd'];
  const counts = {};
  for (let i = 0; i < 100; i++) {
    Balancer.record(counts, 'mb', Balancer.pick('mb', emps, counts));
    const v = emps.map((e) => counts['mb|' + e] || 0);
    assert.ok(Math.max(...v) - Math.min(...v) <= 1, 'step ' + i + ': ' + v);
  }
});

test('balancer: ties are broken at random (every tied person can be picked)', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(Balancer.pick('mb', ['a', 'b', 'c'], {}));
  assert.deepEqual([...seen].sort(), ['a', 'b', 'c']);
});

test('balancer: someone added mid-day catches up before others get more', () => {
  const v = simulate(['a', 'b', 'late'], 12, { 'mb|a': 10, 'mb|b': 10 });
  assert.equal(v[0] + v[1] + v[2], 32);
  assert.ok(v[2] >= 10, 'late joiner caught up: ' + v);
  assert.ok(Math.max(...v) - Math.min(...v) <= 1, String(v));
});

test('balancer: nobody scheduled → null', () => { assert.equal(Balancer.pick('mb', [], {}), null); });

test('balancer: only active, Ivanti-mapped employees scheduled on that mailbox count', () => {
  const snap = {
    scheduleToday: [{ mailbox_id: 'm', employee_id: 'a' }, { mailbox_id: 'm', employee_id: 'b' }, { mailbox_id: 'm', employee_id: 'c' }, { mailbox_id: 'x', employee_id: 'd' }],
    employeeById: { a: { active: true, ivanti_owner_id: '1' }, b: { active: false, ivanti_owner_id: '2' }, c: { active: true, ivanti_owner_id: '' }, d: { active: true, ivanti_owner_id: '4' } },
  };
  assert.deepEqual(plain(Balancer.scheduledEmployees(snap, 'm')), ['a']);
});

void formatDate;
