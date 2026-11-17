/**
 * NoTableCreation (D23): the app must NEVER create, alter or drop BigQuery datasets/tables/views
 * or Google Sheet tabs/columns. A developer always does this. Any code that tries FAILS here.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadApp, seed, incident, SRC } = require('./harness');

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return sourceFiles(p);
    return /\.(gs|js|html|json)$/.test(d.name) ? [p] : [];
  });
}

/**
 * Logical source files. In the single-file build (dist/Code.gs) each original file sits under a
 * banner like  /* ═══ BigQuery.gs ═══ *\/ , so it is split back into its sections here.
 */
function sourceUnits(dir) {
  return sourceFiles(dir).flatMap((f) => {
    const text = fs.readFileSync(f, 'utf8');
    const re = /^\/\* ═+ ([\w.]+\.gs) ═+ \*\/$/gm;
    const marks = [...text.matchAll(re)];
    if (!marks.length) return [{ name: path.basename(f), text }];
    return marks.map((m, i) => ({ name: m[1], text: text.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : text.length) }));
  });
}

const FORBIDDEN = [
  [/\bCREATE\s+(OR\s+REPLACE\s+)?(TEMP(ORARY)?\s+)?(TABLE|SCHEMA|VIEW|MATERIALIZED\s+VIEW|EXTERNAL\s+TABLE|SNAPSHOT\s+TABLE|FUNCTION|DATASET)\b/i, 'CREATE … TABLE/SCHEMA/VIEW'],
  [/\bCREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\b/i, 'CREATE TABLE IF NOT EXISTS'],
  [/\bALTER\s+(TABLE|SCHEMA|VIEW|MATERIALIZED)\b/i, 'ALTER TABLE/SCHEMA/VIEW'],
  [/\bDROP\s+(TABLE|SCHEMA|VIEW|DATASET|MATERIALIZED|EXTERNAL|FUNCTION|SNAPSHOT)\b/i, 'DROP …'],
  [/\bTRUNCATE\s+TABLE\b/i, 'TRUNCATE TABLE'],
  [/\bTables\s*\.\s*(insert|patch|update|delete)\b/, 'BigQuery Tables write method'],
  [/\bDatasets\s*\.\s*(insert|patch|update|delete)\b/, 'BigQuery Datasets write method'],
  [/\binsertAll\b/, 'tabledata.insertAll (can auto-create tables)'],
  [/\btemplateSuffix\b/, 'templateSuffix (auto-creates tables)'],
  [/\bCREATE_IF_NEEDED\b/, 'createDisposition CREATE_IF_NEEDED'],
  [/\bcreateDisposition\b/, 'createDisposition'],
  [/\bdestinationTable\b/, 'destinationTable'],
  [/\bWRITE_TRUNCATE\b/, 'WRITE_TRUNCATE'],
  [/\binsertSheet\b/, 'insertSheet'],
  [/\bSpreadsheetApp\s*\.\s*create\b/, 'SpreadsheetApp.create'],
  [/\bdeleteSheet\b/, 'deleteSheet'],
  [/\binsertColumn/, 'insertColumn…'],
  [/\bdeleteColumn/, 'deleteColumn…'],
  [/\bduplicateActiveSheet\b/, 'duplicateActiveSheet'],
  [/\.setName\s*\(/, 'renaming a tab (setName)'],
  [/\.copyTo\s*\(/, 'copyTo (creates a sheet)'],
];

test('source scan: no file contains table-creation code', () => {
  const files = sourceFiles(SRC);
  assert.ok(sourceUnits(SRC).length > 10, 'source files (or sections of the single-file build) found');
  const hits = [];
  files.forEach((f) => {
    const text = fs.readFileSync(f, 'utf8');
    FORBIDDEN.forEach(([re, label]) => { if (re.test(text)) hits.push(path.relative(SRC, f) + ': ' + label); });
  });
  assert.deepEqual(hits, [], 'Forbidden table-creation code found:\n' + hits.join('\n'));
});

test('source scan: the scanner catches planted violations (self-test)', () => {
  const planted = [
    'BQ.query("CREATE TABLE `p.d.t` (a STRING)")', 'const s = `create or replace table x as select 1`;',
    'BigQuery.Tables.insert(t, p, d)', 'BigQuery.Datasets.insert(ds, p)', 'ss.insertSheet("Schedule")',
    'SpreadsheetApp.create("x")', "q.createDisposition = 'CREATE_IF_NEEDED'", 'req.destinationTable = ref',
    'BigQuery.Tabledata.insertAll(rows, p, d, t)', 'sheet.insertColumnAfter(3)', 'ALTER TABLE t ADD COLUMN c INT64',
    'DROP TABLE t', 'TRUNCATE TABLE t', 'CREATE TEMP TABLE x AS SELECT 1', 'CREATE SCHEMA d',
  ];
  planted.forEach((code) => assert.ok(FORBIDDEN.some(([re]) => re.test(code)), 'scanner missed: ' + code));
});

test('source scan: no setup script that creates tables exists', () => {
  assert.equal(fs.existsSync(path.join(SRC, 'Setup.gs')), false);
});

test('source scan: only BigQuery.gs uses the BigQuery service, and only read/query methods', () => {
  const allowed = new Set(['BigQuery.Jobs.query', 'BigQuery.Jobs.getQueryResults', 'BigQuery.Tables.get']);
  const units = sourceUnits(SRC);
  assert.ok(units.some((u) => u.name === 'BigQuery.gs'), 'BigQuery.gs section found');
  units.forEach(({ name, text }) => {
    // Service members are capitalised (BigQuery.Jobs…, BigQuery.Tables…); "BigQuery.gs" in comments is a file name.
    const uses = text.match(/\bBigQuery\.[A-Z][A-Za-z]*(\.[A-Za-z]+)?/g) || [];
    if (name !== 'BigQuery.gs') assert.deepEqual(uses, [], name + ' must not call the BigQuery service directly');
    else uses.forEach((u) => assert.ok(allowed.has(u), 'BigQuery.gs uses a non-allowed method: ' + u));
    assert.doesNotMatch(text, /=\s*BigQuery\s*[;,)]/, name + ' must not alias the BigQuery service');
  });
});

test('source scan: only Store.gs uses SpreadsheetApp', () => {
  const units = sourceUnits(SRC);
  assert.ok(units.some((u) => u.name === 'Store.gs'), 'Store.gs section found');
  units.forEach(({ name, text }) => {
    if (name === 'Store.gs') return;
    assert.doesNotMatch(text, /\bSpreadsheetApp\b/, name + ' must not use SpreadsheetApp');
  });
});

test('guard: every SQL statement the app uses passes the guard', () => {
  const app = loadApp();
  const SQL = app.g('SQL'), BQ = app.g('BQ');
  const cols = { ticketId: 'ticket_id', subject: 'subject', owner: 'employee_id', mailbox: 'mailbox_id', recordedAt: 'assigned_at', extraFilter: 'dry_run = FALSE' };
  Object.keys(SQL).forEach((k) => {
    const sql = SQL[k]('`p.d.t`', cols);
    assert.doesNotThrow(() => BQ.assertSafeSql(sql), 'SQL.' + k + ' should pass the guard');
    assert.match(sql, /^-- op:/, 'SQL.' + k + ' should start with an op label');
  });
});

test('guard: DDL and scripting statements are rejected before reaching BigQuery', () => {
  const app = loadApp();
  const BQ = app.g('BQ');
  const bad = [
    'CREATE TABLE `p.d.t` (a STRING)',
    'create table p.d.t as select 1 as a',
    'CREATE OR REPLACE TABLE `p.d.t` AS SELECT 1',
    'CREATE TEMP TABLE x AS SELECT 1',
    'CREATE TEMPORARY TABLE x (a INT64)',
    'CREATE SCHEMA d',
    'CREATE VIEW `p.d.v` AS SELECT 1',
    'CREATE MATERIALIZED VIEW `p.d.v` AS SELECT 1',
    'CREATE EXTERNAL TABLE `p.d.t` OPTIONS()',
    'ALTER TABLE `p.d.t` ADD COLUMN b STRING',
    'DROP TABLE `p.d.t`',
    'TRUNCATE TABLE `p.d.t`',
    'SELECT 1; CREATE TABLE `p.d.t` (a STRING)',
    'SELECT 1; DROP TABLE x',
    'SELECT 1 /* harmless */ ; /* sneaky */ CREATE TABLE t (a INT64)',
    'WITH x AS (SELECT 1) SELECT * FROM x; ALTER TABLE t RENAME TO u',
    'DECLARE x INT64; SET x = 1',
    'BEGIN CREATE TABLE t (a INT64); END',
    'EXECUTE IMMEDIATE "CREATE TABLE t (a INT64)"',
    'CALL proc()',
    'EXPORT DATA OPTIONS(uri="gs://x/*") AS SELECT 1',
    'LOAD DATA INTO t FROM FILES(uris=["gs://x"])',
    'UPDATE t SET a = 1 WHERE TRUE',
    'DELETE FROM t WHERE TRUE',
    '  -- comment\n  CrEaTe   TaBlE t (a INT64)',
    'INSERT INTO t SELECT 1; CREATE TABLE u (a INT64)',
    '',
  ];
  bad.forEach((sql) => {
    assert.throws(() => BQ.assertSafeSql(sql), (e) => e.name === 'TableCreationForbiddenError', 'should reject: ' + JSON.stringify(sql));
    assert.throws(() => BQ.query(sql, []), (e) => e.name === 'TableCreationForbiddenError');
  });
  assert.equal(app.mocks.state.bqRequests.length, 0, 'no forbidden statement may reach BigQuery');
  assert.deepEqual(app.mocks.state.creationCalls, []);
});

test('guard: keywords inside strings, comments and identifiers are not false positives', () => {
  const BQ = loadApp().g('BQ');
  ['SELECT "create table" AS note', "SELECT 'DROP TABLE x' AS s", 'SELECT 1 -- create table later\n',
    'SELECT * FROM `p.d.create_table`', "SELECT r'^(re|fw):' AS pattern", 'SELECT """multi\nCREATE TABLE""" AS s']
    .forEach((sql) => assert.doesNotThrow(() => BQ.assertSafeSql(sql), sql));
});

test('guard: requests can only contain allow-listed fields (no destination table)', () => {
  const BQ = loadApp().g('BQ');
  assert.throws(() => BQ.assertSafeRequest_({ query: 'SELECT 1', destinationTable: {} }), (e) => e.name === 'TableCreationForbiddenError');
  assert.throws(() => BQ.assertSafeRequest_({ query: 'SELECT 1', configuration: {} }), (e) => e.name === 'TableCreationForbiddenError');
});

test('whole app: a full day of use makes zero creation calls', () => {
  const app = loadApp();
  const today = app.g('Config').today();
  const ids = seed(app, today);
  const st = app.mocks.state;
  for (let i = 0; i < 25; i++) st.ivantiIncidents.push(incident(4000 + i, i % 5 ? 'Billing' : 'Hardware', 'Question about invoice ' + (700 + i) + ' late fee'));
  const run = (c) => app.run(c);
  // Schema check, dry run, live run, a second run, UI actions through the web-app API.
  app.g('SchemaCheck').checkAll();
  app.g('Pipeline').run({ teamId: 'billing', trigger: 'manual', triggeredBy: 'admin@example.com', dryRun: true });
  app.g('Pipeline').run({ teamId: 'billing', trigger: 'scheduled', triggeredBy: 'system' });
  app.g('Pipeline').run({ teamId: 'payments', trigger: 'scheduled', triggeredBy: 'system' });
  app.mocks.props.delete('last_run_finished_at:billing');
  app.g('Pipeline').run({ teamId: 'billing', trigger: 'manual', triggeredBy: 'admin@example.com' });
  const ok = (r) => { assert.equal(r.ok, true, JSON.stringify(r.error)); return r.data; };
  ok(run('apiBootstrap()'));
  ok(app.ctx.apiScheduleAdd({ requestId: 'r1', date: today, mailboxId: ids.general, employeeId: ids.ana }));
  ok(app.ctx.apiScheduleCopyWeek({ requestId: 'r2', fromStart: today, toStart: '2030-01-07' }));
  ok(app.ctx.apiSaveMailbox({ requestId: 'r3', name: 'New box', description: '' }));
  ok(app.ctx.apiAddListItem({ requestId: 'r4', list: 'StopWords', value: 'urgent' }));
  ok(app.ctx.apiSaveTeamSetting({ requestId: 'r5', key: 'RUN_TIMES', value: '07:00,14:00' }));
  ok(app.ctx.apiScheduleRange({ requestId: 'r6', employeeId: ids.ana, mailboxId: ids.general, from: '2030-02-04', to: '2030-02-15', days: ['MON', 'TUE', 'WED', 'THU', 'FRI'] }));
  ok(app.ctx.apiSaveEmployee({ requestId: 'r7', display_name: 'Gus', employee_email: 'gus@example.com' }));
  ok(app.ctx.apiTestSubject({ subject: 'Question about invoice 701 late fee' }));
  const q = ok(app.ctx.apiListQueue());
  assert.ok(q.shared.length > 0);
  ok(app.ctx.apiResolveQueue({ ticketId: q.shared[0].ticket_id, mailboxId: ids.billing, employeeId: null, version: q.shared[0].version }));
  const row = app.mocks.bq.tables.assignments.find((a) => !a.dry_run && a.routing_method === 'rule');
  ok(app.ctx.apiReassign({ ticketId: row.ticket_id, employeeId: ids.ben === row.employee_id ? ids.cy : ids.ben, version: row.version }));
  ok(app.ctx.apiRunStatus());
  ok(app.ctx.apiCheckSetup());

  assert.deepEqual(st.creationCalls, [], 'creation calls: ' + st.creationCalls.join(', '));
  assert.ok(st.bqRequests.length > 10);
  st.bqRequests.forEach(({ request }) => {
    Object.keys(request).forEach((k) => assert.ok(['query', 'useLegacySql', 'parameterMode', 'queryParameters', 'timeoutMs', 'location'].includes(k), 'request field ' + k));
    assert.match(request.query, /^-- op:/);
  });
});

test('missing BigQuery table: run stops, names the table, and creates nothing', () => {
  const app = loadApp();
  seed(app, app.g('Config').today());
  app.mocks.bq.exists.runs = false;
  app.mocks.state.ivantiIncidents.push(incident(4100, 'Billing', 'Invoice 5 charged twice'));
  const r = app.g('Pipeline').run({ teamId: 'billing', trigger: 'manual', triggeredBy: 'admin@example.com' });
  assert.equal(r.status, 'stopped_check_failed');
  assert.ok(r.errors.some((e) => /runs/.test(e) && /does not exist/.test(e)), r.errors.join(' | '));
  assert.deepEqual(app.mocks.state.creationCalls, []);
  assert.equal(app.mocks.bq.tables.assignments.length, 0, 'nothing assigned when setup is incomplete');
  assert.equal(app.mocks.state.fetchCalls.length, 0, 'Ivanti not called when setup is incomplete');
  assert.equal(app.g('Lease').current(), null, 'lease released');
});

test('missing BigQuery column: reported, not added', () => {
  const app = loadApp();
  app.mocks.bq.schemas.assignments = app.mocks.bq.schemas.assignments.filter((c) => c.name !== 'counts_toward_balance');
  const problems = app.g('SchemaCheck').checkBigQuery();
  assert.ok(problems.some((p) => /counts_toward_balance/.test(p)));
  assert.deepEqual(app.mocks.state.creationCalls, []);
});

test('missing Sheet tab: app reports it and never adds it', () => {
  const app = loadApp();
  delete app.mocks.sheets.Schedule;
  const boot = app.run('apiBootstrap()');
  assert.equal(boot.ok, true);
  assert.ok(boot.data.setupProblems.some((p) => /Schedule/.test(p)));
  assert.throws(() => app.g('Store').read('Schedule'), (e) => e.name === 'SchemaMissingError');
  const w = app.ctx.apiScheduleAdd({ requestId: 'x', date: '2026-11-16', mailboxId: 'a', employeeId: 'b' });
  assert.equal(w.ok, false);
  assert.deepEqual(app.mocks.state.creationCalls, []);
});

test('missing Sheet column: reported, not added', () => {
  const app = loadApp();
  app.mocks.sheets.Employees.data[0] = app.mocks.sheets.Employees.data[0].filter((h) => h !== 'ivanti_owner_id');
  assert.ok(app.g('SchemaCheck').checkSheets().some((p) => /Employees/.test(p) && /ivanti_owner_id/.test(p)));
  assert.throws(() => app.g('Store').read('Employees'), (e) => e.name === 'SchemaMissingError');
  assert.deepEqual(app.mocks.state.creationCalls, []);
});
