/**
 * Test harness: loads every src/*.gs file into one V8 context (as Apps Script does) with
 * in-memory mocks of the Apps Script services. The mocks RECORD every call, so tests can prove
 * that nothing ever tries to create a table, dataset or Sheet tab (D23).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const SRC = path.join(__dirname, '..', 'src');
const TZ = 'America/New_York';

function gsFiles() { return fs.readdirSync(SRC).filter((f) => f.endsWith('.gs')).sort(); }

/* ───────────── Utilities.formatDate (subset of Java SimpleDateFormat) ───────────── */
function formatDate(date, tz, fmt) {
  const parts = {};
  new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(date).forEach((p) => { parts[p.type] = p.value; });
  const iso = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts.weekday];
  return fmt.replace(/yyyy|MM|dd|HH|mm|ss|EEE|u/g, (t) => ({ yyyy: parts.year, MM: parts.month, dd: parts.day, HH: parts.hour,
    mm: parts.minute, ss: parts.second, EEE: parts.weekday, u: String(iso) }[t]));
}

/* ─────────────────────────────── Mock factory ─────────────────────────────── */
function createMocks() {
  const state = {
    user: 'admin@example.com', owner: 'admin@example.com', lockBusy: false,
    creationCalls: [],          // ANY attempt to create/alter tables, datasets, sheets lands here
    bqRequests: [],             // every BigQuery jobs.query request
    bqTablesGetCalls: [],
    fetchCalls: [], fetchAllCalls: [],
    ivantiIncidents: [], ivantiFailRecIds: new Set(),
  };

  const mapStore = () => { const m = new Map(); return m; };
  const props = mapStore();
  const propsApi = {
    getProperty: (k) => (props.has(k) ? props.get(k) : null),
    setProperty: (k, v) => { props.set(k, String(v)); return propsApi; },
    deleteProperty: (k) => { props.delete(k); return propsApi; },
    getProperties: () => Object.fromEntries(props),
  };
  const cache = mapStore();
  const cacheApi = {
    get: (k) => (cache.has(k) ? cache.get(k) : null),
    put: (k, v) => { cache.set(k, String(v)); },
    remove: (k) => { cache.delete(k); },
    getAll: (keys) => { const o = {}; keys.forEach((k) => { if (cache.has(k)) o[k] = cache.get(k); }); return o; },
  };

  /* Sheets */
  const sheets = {};
  class MockSheet {
    constructor(name, headers) { this.name = name; this.data = [headers.slice()]; }
    width_() { return Math.max(...this.data.map((r) => r.length), 0); }
    getDataRange() { const w = this.width_(); return { getValues: () => this.data.map((r) => { const o = r.slice(); while (o.length < w) o.push(''); return o; }) }; }
    getLastRow() { return this.data.length; }
    getLastColumn() { return this.data[0] ? this.data[0].length : 0; }
    getRange(row, col, nr, nc) {
      const sheet = this;
      return {
        getValues() {
          const out = [];
          for (let r = 0; r < nr; r++) { const src = sheet.data[row - 1 + r] || []; const o = []; for (let c = 0; c < nc; c++) o.push(src[col - 1 + c] === undefined ? '' : src[col - 1 + c]); out.push(o); }
          return out;
        },
        setValues(vals) {
          for (let r = 0; r < nr; r++) {
            while (sheet.data.length < row + r) sheet.data.push([]);
            const target = sheet.data[row - 1 + r];
            for (let c = 0; c < nc; c++) {
              let v = vals[r][c];
              if (typeof v === 'string' && v.charAt(0) === "'") v = v.slice(1);              // Sheets hides the apostrophe
              else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) v = new Date(v + 'T12:00:00Z'); // Sheets auto-converts dates
              target[col - 1 + c] = v;
            }
          }
        },
      };
    }
    setName() { state.creationCalls.push('sheet.setName'); throw new Error('forbidden'); }
    insertColumnAfter() { state.creationCalls.push('insertColumnAfter'); throw new Error('forbidden'); }
  }
  const spreadsheet = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => { state.creationCalls.push('insertSheet:' + n); throw new Error('forbidden'); },
    deleteSheet: () => { state.creationCalls.push('deleteSheet'); throw new Error('forbidden'); },
  };
  const SpreadsheetApp = {
    openById: () => spreadsheet,
    create: () => { state.creationCalls.push('SpreadsheetApp.create'); throw new Error('forbidden'); },
    flush: () => {},
  };

  /* BigQuery */
  const bq = { tables: { assignments: [], runs: [], vertex_queue: [] }, exists: { assignments: true, runs: true, vertex_queue: true }, schemas: {} };
  const BigQuery = {
    Jobs: {
      query: (request, projectId) => { state.bqRequests.push({ request: JSON.parse(JSON.stringify(request)), projectId }); return runBq(request); },
      getQueryResults: () => { throw new Error('not used in mock'); },
      insert: () => { state.creationCalls.push('BigQuery.Jobs.insert'); throw new Error('forbidden'); },
    },
    Tables: {
      get: (p, d, t) => {
        state.bqTablesGetCalls.push([p, d, t]);
        if (!bq.exists[t]) throw new Error('Not found: Table ' + p + ':' + d + '.' + t);
        return { schema: { fields: bq.schemas[t] } };
      },
      insert: () => { state.creationCalls.push('BigQuery.Tables.insert'); throw new Error('forbidden'); },
      patch: () => { state.creationCalls.push('BigQuery.Tables.patch'); throw new Error('forbidden'); },
      update: () => { state.creationCalls.push('BigQuery.Tables.update'); throw new Error('forbidden'); },
    },
    Datasets: { insert: () => { state.creationCalls.push('BigQuery.Datasets.insert'); throw new Error('forbidden'); } },
    Tabledata: { insertAll: () => { state.creationCalls.push('BigQuery.Tabledata.insertAll'); throw new Error('forbidden'); } },
  };

  function decodeParams(list) {
    const out = {};
    (list || []).forEach((p) => { out[p.name] = decodeValue(p.parameterType, p.parameterValue); });
    return out;
  }
  function decodeScalar(type, pv) {
    if (!pv || pv.value === undefined) return null;
    if (type === 'INT64' || type === 'FLOAT64') return Number(pv.value);
    if (type === 'BOOL') return pv.value === 'true';
    return pv.value;
  }
  function decodeValue(pt, pv) {
    if (pt.type === 'ARRAY') {
      return (pv.arrayValues || []).map((av) => {
        if (pt.arrayType.type === 'STRUCT') {
          const o = {};
          pt.arrayType.structTypes.forEach((st) => { o[st.name] = decodeScalar(st.type.type, av.structValues[st.name]); });
          return o;
        }
        return decodeScalar(pt.arrayType.type, av);
      });
    }
    return decodeScalar(pt.type, pv);
  }
  function result(rows, affected) {
    const keys = rows.length ? Object.keys(rows[0]) : [];
    const fields = keys.map((k) => {
      const v = rows.find((r) => r[k] !== null && r[k] !== undefined);
      const val = v ? v[k] : null;
      return { name: k, type: typeof val === 'number' ? 'FLOAT' : typeof val === 'boolean' ? 'BOOLEAN' : 'STRING' };
    });
    return { jobComplete: true, jobReference: { jobId: 'job_' + state.bqRequests.length, location: 'US' }, schema: { fields },
      rows: rows.map((r) => ({ f: keys.map((k) => ({ v: r[k] === null || r[k] === undefined ? null : String(r[k]) })) })),
      numDmlAffectedRows: affected === undefined ? undefined : String(affected) };
  }
  const dateIn = (iso) => formatDate(new Date(iso), TZ, 'yyyy-MM-dd');

  // Independent re-implementation of the SQL follow-up matching (cross-checks Subject.gs).
  function sqlSeq(subject, prefix, stop) {
    const norm = String(subject || '').toLowerCase().replace(new RegExp(prefix), '').replace(/[^a-z0-9]+/g, ' ').trim();
    return norm.split(' ').filter((w) => w !== '' && stop.indexOf(w) === -1).join(' ');
  }
  function sqlScore(nSeq, hSeq, minWords) {
    const n = nSeq.split(' '), hh = hSeq.split(' ');
    const nt = [...new Set(n.filter(Boolean))], ht = [...new Set(hh.filter(Boolean))];
    const inter = nt.filter((w) => ht.includes(w)).length;
    if (!inter) return 0;
    const overlap = inter / (nt.length + ht.length - inter);
    const longer = n.length >= hh.length ? nSeq : hSeq, shorter = n.length >= hh.length ? hSeq : nSeq;
    const contained = Math.min(n.length, hh.length) >= minWords && (' ' + longer + ' ').indexOf(' ' + shorter + ' ') !== -1;
    return Math.max(overlap, contained ? 1 : 0);
  }

  function runBq(request) {
    const op = (String(request.query).match(/--\s*op:(\S+)/) || [])[1];
    const p = decodeParams(request.queryParameters);
    const A = bq.tables.assignments, R = bq.tables.runs, Q = bq.tables.vertex_queue;
    switch (op) {
      case 'assignments.existing': return result(A.filter((r) => !r.dry_run && p.ids.includes(r.ticket_id)).map((r) => ({ ticket_id: r.ticket_id })));
      case 'assignments.todayCounts': {
        const g = {};
        A.filter((r) => !r.dry_run && r.counts_toward_balance && dateIn(r.assigned_at) === p.today).forEach((r) => {
          const k = r.mailbox_id + '|' + r.employee_id; g[k] = g[k] || { mailbox_id: r.mailbox_id, employee_id: r.employee_id, n: 0 }; g[k].n++;
        });
        return result(Object.values(g));
      }
      case 'assignments.merge': {
        let n = 0;
        p.rows.forEach((s) => {
          const t = A.find((r) => r.ticket_id === s.ticket_id);
          if (t && t.dry_run) { Object.assign(t, s, { version: t.version + 1 }); n++; } else if (!t) { A.push(Object.assign({}, s, { version: 1 })); n++; }
        });
        return result([], n);
      }
      case 'assignments.writebackUpdate': {
        let n = 0;
        p.rows.forEach((u) => { const t = A.find((r) => r.ticket_id === u.ticket_id && !r.dry_run); if (t) { t.writeback_status = u.writeback_status; t.writeback_attempts++; t.writeback_error = u.writeback_error; n++; } });
        return result([], n);
      }
      case 'assignments.pendingWritebacks':
        return result(A.filter((r) => !r.dry_run && ['pending', 'failed'].includes(r.writeback_status) && r.writeback_attempts < p.max_attempts &&
          (r.run_id === null || r.run_id !== p.current_run_id)).map((r) => ({ ticket_id: r.ticket_id, ivanti_rec_id: r.ivanti_rec_id, employee_id: r.employee_id, mailbox_id: r.mailbox_id, writeback_attempts: r.writeback_attempts })));
      case 'assignments.search':
        return result(A.filter((r) => dateIn(r.assigned_at) >= p.from_date && dateIn(r.assigned_at) <= p.to_date && (!p.ticket_id || r.ticket_id === p.ticket_id) &&
          (!p.employee_id || r.employee_id === p.employee_id) && (!p.mailbox_id || r.mailbox_id === p.mailbox_id) && (p.include_dry_run || !r.dry_run)).map((r) => Object.assign({}, r)));
      case 'assignments.get': return result(A.filter((r) => r.ticket_id === p.ticket_id && !r.dry_run).map((r) => Object.assign({}, r)));
      case 'assignments.reassign': {
        const t = A.find((r) => r.ticket_id === p.ticket_id && !r.dry_run && r.version === p.expected_version);
        if (!t) return result([], 0);
        Object.assign(t, { employee_id: p.employee_id, assigned_by: p.assigned_by, version: t.version + 1, writeback_status: 'pending', writeback_attempts: 0, writeback_error: null });
        return result([], 1);
      }
      case 'assignments.recentSnapshots': return result(A.filter((r) => !r.dry_run && r.ticket_snapshot_json).slice(-p.limit).map((r) => ({ ticket_id: r.ticket_id, subject: r.subject, snapshot: r.ticket_snapshot_json })));
      case 'history.match': {
        const out = [];
        p.new_tickets.forEach((n) => {
          const scored = A.filter((h) => !h.dry_run && h.subject && h.employee_id && h.ticket_id !== n.ticket_id).map((h) => {
            const hs = sqlSeq(h.subject, p.prefix_pattern, p.stop_words);
            return { h, score: hs ? sqlScore(n.seq, hs, p.min_words) : 0 };
          }).filter((x) => x.score > 0 && x.score >= p.threshold)
            .sort((a, b) => b.score - a.score || String(b.h.assigned_at).localeCompare(String(a.h.assigned_at)))
            .slice(0, p.limit_per_ticket);
          scored.forEach((x) => out.push({ ticket_id: n.ticket_id, matched_ticket_id: x.h.ticket_id, owner: x.h.employee_id, mailbox_id: x.h.mailbox_id, score: x.score, matched_at: x.h.assigned_at }));
        });
        return result(out);
      }
      case 'runs.upsert': {
        p.rows.forEach((s) => { const t = R.find((r) => r.run_id === s.run_id); if (t) Object.assign(t, s, { trigger_type: t.trigger_type }); else R.push(Object.assign({}, s)); });
        return result([], p.rows.length);
      }
      case 'runs.recent': return result(R.slice().reverse().slice(0, p.limit).map((r) => Object.assign({}, r)));
      case 'queue.upsert': {
        p.rows.forEach((s) => {
          const t = Q.find((r) => r.ticket_id === s.ticket_id);
          if (t && ['pending', 'no_one_scheduled', 'failed', 'manual_review', 'routed'].includes(t.status)) Object.assign(t, s, { attempts: t.attempts + 1, version: t.version + 1 });
          else if (!t) Q.push(Object.assign({}, s, { attempts: 1, version: 1, created_at: new Date().toISOString() }));
        });
        return result([], p.rows.length);
      }
      case 'queue.setStatus': {
        let n = 0;
        p.rows.forEach((s) => {
          const t = Q.find((r) => r.ticket_id === s.ticket_id && (s.expected_version === null || r.version === s.expected_version));
          if (t) { t.status = s.status; t.result_mailbox_id = s.result_mailbox_id || t.result_mailbox_id; t.version++; n++; }
        });
        return result([], n);
      }
      case 'queue.list': return result(Q.filter((r) => p.statuses.includes(r.status)).map((r) => Object.assign({}, r)));
      default: throw new Error('Mock BigQuery: unknown op ' + op);
    }
  }

  /* Ivanti (UrlFetchApp) */
  const resp = (code, body) => ({ getResponseCode: () => code, getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  const UrlFetchApp = {
    fetch: (url, opts) => {
      state.fetchCalls.push({ url, opts });
      const u = new URL(url);
      const top = Number(u.searchParams.get('$top')), skip = Number(u.searchParams.get('$skip'));
      const filter = u.searchParams.get('$filter') || '';
      const pool = /Owner ne null/.test(filter) ? state.ivantiHistory || [] : state.ivantiIncidents.filter((x) => !x.Owner);
      return resp(200, { value: pool.slice(skip, skip + top) });
    },
    fetchAll: (reqs) => {
      state.fetchAllCalls.push(reqs);
      return reqs.map((r) => {
        const recId = decodeURIComponent((r.url.match(/\('([^']+)'\)/) || [])[1] || '');
        if (state.ivantiFailRecIds.has(recId)) return resp(500, 'boom');
        const inc = state.ivantiIncidents.find((x) => x.RecId === recId);
        if (inc) inc.Owner = JSON.parse(r.payload).Owner;
        return resp(204, '');
      });
    },
  };

  /* ScriptApp */
  const triggers = [];
  const ScriptApp = {
    newTrigger: (handler) => { const b = { timeBased: () => b, everyMinutes: () => b, after: () => b, create: () => { const t = { getHandlerFunction: () => handler }; triggers.push(t); return t; } }; return b; },
    getProjectTriggers: () => triggers.slice(),
    deleteTrigger: (t) => { const i = triggers.indexOf(t); if (i >= 0) triggers.splice(i, 1); },
    getOAuthToken: () => 'token',
  };

  const globals = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    PropertiesService: { getScriptProperties: () => propsApi },
    CacheService: { getScriptCache: () => cacheApi },
    LockService: { getScriptLock: () => ({ tryLock: () => !state.lockBusy, waitLock: () => { if (state.lockBusy) throw new Error('busy'); }, releaseLock: () => {}, hasLock: () => true }) },
    Utilities: { getUuid: () => crypto.randomUUID(), sleep: () => {}, formatDate: formatDate },
    Session: { getActiveUser: () => ({ getEmail: () => state.user }), getEffectiveUser: () => ({ getEmail: () => state.owner }), getScriptTimeZone: () => TZ },
    SpreadsheetApp, BigQuery, UrlFetchApp, ScriptApp,
    HtmlService: { createTemplateFromFile: () => ({ evaluate: () => ({ setTitle() { return this; }, addMetaTag() { return this; } }) }), createHtmlOutputFromFile: () => ({ getContent: () => '' }) },
  };
  return { state, globals, sheets, MockSheet, bq, props, cache, triggers };
}

/**
 * Load the app. Returns { run(code), g(name), mocks }. opts.configure (default true) fills in
 * QueryConfig with test values and creates every required Sheet tab and BigQuery table IN THE
 * MOCK (this stands in for the developer's setup).
 */
function loadApp(opts) {
  opts = opts || {};
  const mocks = createMocks();
  const ctx = vm.createContext(Object.assign({}, mocks.globals));
  gsFiles().forEach((f) => vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f }));
  const run = (code) => vm.runInContext(code, ctx);
  const g = (name) => run(name);
  if (opts.configure !== false) {
    run(`QUERY_CONFIG.sheet.spreadsheetId = 'sheet-1'; QUERY_CONFIG.ivanti.baseUrl = 'https://ivanti.test';
         QUERY_CONFIG.bigQuery.projectId = 'proj'; QUERY_CONFIG.bigQuery.appDataset = 'app';`);
    mocks.props.set('IVANTI_API_KEY', 'test-key');
    const tabs = g('REQUIRED_SHEET_TABS');
    Object.keys(tabs).forEach((name) => { mocks.sheets[name] = new mocks.MockSheet(name, Object.keys(tabs[name].columns)); });
    const legacy = { BOOL: 'BOOLEAN', INT64: 'INTEGER', FLOAT64: 'FLOAT' };
    const schema = g('REQUIRED_SCHEMA');
    Object.keys(schema).forEach((t) => { mocks.bq.schemas[t] = schema[t].columns.map((c) => ({ name: c[0], type: legacy[c[1]] || c[1], mode: c[2] })); });
  }
  return { run, g, mocks, ctx };
}

/** Seed a typical setup through the app's own Store (as an admin would through the UI). */
function seed(app, today) {
  const Store = app.g('Store');
  const ids = {};
  Store.mutate({ user: 'admin@example.com' }, (tx) => {
    ids.billing = tx.insert('Mailboxes', { name: 'Billing - Special Handling', description: 'IDs 4000-5000', priority: 1, active: true }).id;
    ids.general = tx.insert('Mailboxes', { name: 'General', description: '', priority: 2, active: true }).id;
    ids.ana = tx.insert('Employees', { employee_email: 'ana@example.com', display_name: 'Ana', ivanti_owner_id: 'OWN-ANA', active: true }).id;
    ids.ben = tx.insert('Employees', { employee_email: 'ben@example.com', display_name: 'Ben', ivanti_owner_id: 'OWN-BEN', active: true }).id;
    ids.cy = tx.insert('Employees', { employee_email: 'cy@example.com', display_name: 'Cy', ivanti_owner_id: 'OWN-CY', active: true }).id;
    ids.dee = tx.insert('Employees', { employee_email: 'dee@example.com', display_name: 'Dee', ivanti_owner_id: 'OWN-DEE', active: true }).id;
    tx.insert('Rules', { mailbox_id: ids.billing, conditions_json: [{ field: 'Category', op: 'equals', value: 'Billing' }, { field: 'IncidentNumber', op: 'between', value: [4000, 5000] }], active: true });
    tx.insert('Rules', { mailbox_id: ids.general, conditions_json: [{ field: 'Category', op: 'in', value: ['General', 'Billing'] }], active: true });
    ['ana', 'ben', 'cy'].forEach((k) => tx.insert('Schedule', { date: today, mailbox_id: ids.billing, employee_id: ids[k] }));
    tx.insert('Schedule', { date: today, mailbox_id: ids.general, employee_id: ids.dee });
  });
  return ids;
}

function incident(n, category, subject, created) {
  return { RecId: 'REC' + n, IncidentNumber: n, Subject: subject, Category: category, Status: 'Logged', Owner: null,
    CreatedDateTime: created || new Date(Date.UTC(2026, 10, 16, 8, 0, n % 60)).toISOString() };
}

module.exports = { loadApp, seed, incident, gsFiles, SRC, TZ, formatDate };
