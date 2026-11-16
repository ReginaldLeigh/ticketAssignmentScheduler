/**
 * WebApp.gs — web app entry point and the server functions the browser calls (google.script.run).
 *
 * Access model: deployed "Execute as: me" / "Access: your domain". Every call runs as the one
 * account that owns the app; users need no BigQuery, Sheet or Ivanti access. The caller's email is
 * checked on every call: anyone in the domain can view and use Run now; every write to config,
 * the schedule or the log requires the caller to be on the Admins tab (D16, D19).
 *
 * Every api* function returns { ok: true, data } or { ok: false, error: { type, message, details } }.
 */
function doGet() {
  return HtmlService.createTemplateFromFile('html/Index').evaluate()
    .setTitle('Ticket Assignment Scheduler')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function include(name) { return HtmlService.createHtmlOutputFromFile(name).getContent(); }

function api_(fn) {
  try { return { ok: true, data: fn() }; } catch (e) {
    if (!(e instanceof AppError)) console.error(e && e.stack ? e.stack : e);
    return { ok: false, error: { type: (e && e.name) || 'Error', message: (e && e.message) || String(e), details: (e && e.details) || null } };
  }
}

function ctx_(user, args) { return { user: user, requestId: args && args.requestId ? String(args.requestId).slice(0, 64) : null }; }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function addDays_(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function requireDate_(s, label) { if (!DATE_RE.test(String(s || ''))) throw new ValidationError((label || 'Date') + ' must look like 2026-11-16.'); return s; }
function text_(v, label, max, required) {
  const s = String(v === null || v === undefined ? '' : v).trim();
  if (required && !s) throw new ValidationError(label + ' is required.');
  if (s.length > max) throw new ValidationError(label + ' must be at most ' + max + ' characters.');
  return s;
}

/* ─────────────────────────────── Bootstrap & polling ─────────────────────────────── */

function apiBootstrap() {
  return api_(() => {
    const user = Config.requireUser();
    const sheetProblems = SchemaCheck.checkSheets();
    if (sheetProblems.length) return { user: user, isAdmin: false, setupProblems: sheetProblems };
    const isAdmin = Config.isAdmin(user);
    const out = {
      user: user, isAdmin: isAdmin, setupProblems: [], today: Config.today(), timeZone: Store.tz_(),
      revisions: Store.getRevisions(),
      mailboxes: Store.read('Mailboxes'),
      employees: Store.read('Employees').map((e) => isAdmin ? e : { id: e.id, display_name: e.display_name, active: e.active }),
      ruleFields: QUERY_CONFIG.ivanti.selectFields.slice(),
      operators: RULE_OPERATORS,
      settingDefs: DEFAULT_SETTINGS,
    };
    if (isAdmin) {
      out.settings = Config.settings();
      out.settingRows = Store.read('Settings');
    }
    return out;
  });
}

/** Light poll (every 30 s while the tab is visible): revisions + whether a run is in progress. */
function apiPoll() {
  return api_(() => {
    Config.requireUser();
    const lease = Lease.current();
    return { revisions: Store.getRevisions(), running: lease ? { startedBy: lease.startedBy, startedAt: lease.startedAt, trigger: lease.trigger } : null };
  });
}

/** Human-readable notes for changes after `since` (ISO), e.g. "jordan added Sam to Billing (Tue)". */
function apiGetChanges(args) {
  return api_(() => {
    const me = Config.requireUser();
    const since = String((args && args.since) || '');
    const entries = Store.readAuditTail(30).filter((e) => !since || String(e.at) > since);
    if (!entries.length) return { notes: [], latest: since };
    const emps = Config.indexBy_(Store.read('Employees'), 'id');
    const mbs = Config.indexBy_(Store.read('Mailboxes'), 'id');
    const who = (u) => (u === me ? 'You' : String(u || 'someone').split('@')[0]);
    const day = (d) => { try { return Utilities.formatDate(new Date(d + 'T12:00:00Z'), 'UTC', 'EEE'); } catch (e) { return d; } };
    const notes = entries.slice(0, 5).map((e) => {
      let after = {}, before = {};
      try { after = JSON.parse(e.after_json || '{}'); } catch (x) { /* ignore */ }
      try { before = JSON.parse(e.before_json || '{}'); } catch (x) { /* ignore */ }
      const rec = Object.keys(after).length ? after : before;
      if (e.entity === 'Schedule') {
        const emp = (emps[rec.employee_id] || {}).display_name || 'someone';
        const mb = (mbs[rec.mailbox_id] || {}).name || 'a mailbox';
        if (e.action === 'insert') return who(e.user) + ' added ' + emp + ' to ' + mb + ' (' + day(rec.date) + ')';
        if (e.action === 'remove') return who(e.user) + ' removed ' + emp + ' from ' + mb + ' (' + day(rec.date) + ')';
        return who(e.user) + ' moved ' + emp + ' to ' + mb + ' (' + day(rec.date) + ')';
      }
      const label = { Mailboxes: 'mailbox', Rules: 'a rule', Employees: 'employee', Settings: 'setting', Admins: 'admins',
        SubjectIgnoreList: 'the subject ignore list', StopWords: 'stop words' }[e.entity] || e.entity;
      const name = rec.name || rec.display_name || rec.key || rec.email || rec.value || '';
      return who(e.user) + ' ' + (e.action === 'insert' ? 'added' : e.action === 'remove' ? 'removed' : 'updated') + ' ' + label + (name && label !== 'a rule' ? ' ' + name : '');
    });
    return { notes: notes, latest: entries[0].at };
  });
}

/* ─────────────────────────────── Schedule ─────────────────────────────── */

function apiGetWeek(args) {
  return api_(() => {
    Config.requireUser();
    const start = requireDate_(args && args.weekStart, 'Week start');
    const end = addDays_(start, 6);
    const isAdmin = Config.isAdmin(Config.currentUser());
    return {
      weekStart: start,
      entries: Store.read('Schedule').filter((e) => e.date >= start && e.date <= end),
      mailboxes: Store.read('Mailboxes'),
      employees: Store.read('Employees').map((e) => isAdmin ? e : { id: e.id, display_name: e.display_name, active: e.active }),
      revisions: Store.getRevisions(),
    };
  });
}

function checkScheduleTarget_(tx, date, mailboxId, employeeId) {
  requireDate_(date);
  const mb = tx.find('Mailboxes', mailboxId);
  if (!mb || !mb.active) throw new ValidationError('That mailbox is not active (someone may have just deactivated it).');
  const emp = tx.find('Employees', employeeId);
  if (!emp || !emp.active) throw new ValidationError('That employee is not active (someone may have just deactivated them).');
  return { mb: mb, emp: emp };
}

function apiScheduleAdd(args) {
  return api_(() => {
    const user = Config.requireAdmin();
    return Store.mutate(ctx_(user, args), (tx) => {
      const t = checkScheduleTarget_(tx, args.date, args.mailboxId, args.employeeId);
      const dup = tx.rows('Schedule').find((e) => e.date === args.date && e.mailbox_id === args.mailboxId && e.employee_id === args.employeeId);
      if (dup) return { status: 'already_scheduled', entry: dup, message: t.emp.display_name + ' is already scheduled there.' };
      return { status: 'added', entry: tx.insert('Schedule', { date: args.date, mailbox_id: args.mailboxId, employee_id: args.employeeId }) };
    });
  });
}

function apiScheduleRemove(args) {
  return api_(() => {
    const user = Config.requireAdmin();
    return Store.mutate(ctx_(user, args), (tx) => {
      const cur = tx.find('Schedule', args.id);
      if (!cur || cur.deleted_at) return { status: 'already_removed' };
      return { status: 'removed', entry: tx.remove('Schedule', args.id, args.version) };
    });
  });
}

function apiScheduleMove(args) {
  return api_(() => {
    const user = Config.requireAdmin();
    return Store.mutate(ctx_(user, args), (tx) => {
      const cur = tx.find('Schedule', args.id);
      if (!cur || cur.deleted_at) throw new NotFoundError('This entry was removed by someone else.');
      const t = checkScheduleTarget_(tx, args.date, args.mailboxId, cur.employee_id);
      const dup = tx.rows('Schedule').find((e) => e.id !== cur.id && e.date === args.date && e.mailbox_id === args.mailboxId && e.employee_id === cur.employee_id);
      if (dup) throw new ValidationError(t.emp.display_name + ' is already scheduled there.');
      return { status: 'moved', entry: tx.update('Schedule', args.id, { date: args.date, mailbox_id: args.mailboxId }, args.version, 'move') };
    });
  });
}

function apiScheduleCopyWeek(args) {
  return api_(() => {
    const user = Config.requireAdmin();
    const from = requireDate_(args.fromStart, 'Source week');
    const to = requireDate_(args.toStart, 'Target week');
    const offset = Math.round((Date.parse(to + 'T12:00:00Z') - Date.parse(from + 'T12:00:00Z')) / 86400000);
    if (offset === 0) throw new ValidationError('Choose a different week to copy into.');
    return Store.mutate(ctx_(user, args), (tx) => {
      const rows = tx.rows('Schedule');
      const existing = {};
      rows.forEach((e) => { existing[e.date + '|' + e.mailbox_id + '|' + e.employee_id] = true; });
      const fromEnd = addDays_(from, 6);
      let added = 0, skipped = 0;
      rows.filter((e) => e.date >= from && e.date <= fromEnd).forEach((e) => {
        const date = addDays_(e.date, offset);
        const key = date + '|' + e.mailbox_id + '|' + e.employee_id;
        const mb = tx.find('Mailboxes', e.mailbox_id), emp = tx.find('Employees', e.employee_id);
        if (existing[key] || !mb || !mb.active || !emp || !emp.active) { skipped++; return; }
        tx.insert('Schedule', { date: date, mailbox_id: e.mailbox_id, employee_id: e.employee_id });
        existing[key] = true;
        added++;
      });
      return { added: added, skipped: skipped };
    });
  });
}

/* ─────────────────────────────── Mailboxes & rules ─────────────────────────────── */

function apiListRules() {
  return api_(() => { Config.requireUser(); return { rules: Store.read('Rules'), mailboxes: Store.read('Mailboxes') }; });
}

function apiSaveMailbox(args) {
  return api_(() => {
    const user = Config.requireAdmin();
    const name = text_(args.name, 'Name', 100, true);
    const description = text_(args.description, 'Description', 500, false);
    return Store.mutate(ctx_(user, args), (tx) => {
      const all = tx.rows('Mailboxes');
      if (all.some((m) => m.id !== args.id && m.active && String(m.name).toLowerCase() === name.toLowerCase())) {
        throw new ValidationError('Another active mailbox is already called "' + name + '".');
      }
      if (args.id) return tx.update('Mailboxes', args.id, { name: name, description: description, active: !!args.active }, args.version);
      const maxP = all.reduce((m, x) => Math.max(m, Number(x.priority) || 0), 0);
      return tx.insert('Mailboxes', { name: name, description: description, priority: maxP + 1, active: true });
    });
  });
}

/** Move a mailbox up/down in rule-check priority, relative to the CURRENT order (§6.5). */
function apiMoveMailbox(args) {
  return api_(() => {
    const user = Config.requireAdmin();
    return Store.mutate(ctx_(user, args), (tx) => {
      const order = tx.rows('Mailboxes').sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0) || String(a.name).localeCompare(String(b.name)));
      const i = order.findIndex((m) => m.id === args.id);
      if (i === -1) throw new NotFoundError('Mailbox not found.');
      const j = args.direction === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= order.length) return { status: 'unchanged' };
      const tmp = order[i]; order[i] = order[j]; order[j] = tmp;
      order.forEach((m, idx) => { if (Number(m.priority) !== idx + 1) tx.update('Mailboxes', m.id, { priority: idx + 1 }, null, 'reorder'); });
      return { status: 'moved' };
    });
  });
}

function apiSaveRule(args) {
  return api_(() => {
    const user = Config.requireAdmin();
    const conditions = Rules.validate(args.conditions);
    return Store.mutate(ctx_(user, args), (tx) => {
      const mb = tx.find('Mailboxes', args.mailboxId);
      if (!mb) throw new ValidationError('Choose a mailbox.');
      if (!mb.active && args.active !== false) throw new ValidationError('Mailbox "' + mb.name + '" is not active (someone may have just deactivated it).');
      const data = { mailbox_id: args.mailboxId, conditions_json: conditions, active: args.active !== false };
      if (args.id) return tx.update('Rules', args.id, data, args.version);
      return tx.insert('Rules', data);
    });
  });
}

function apiRemoveRule(args) {
  return api_(() => {
    const user = Config.requireAdmin();
    return Store.mutate(ctx_(user, args), (tx) => tx.remove('Rules', args.id, args.version));
  });
}

/** Try conditions against tickets assigned in the last 30 days (from BigQuery). */
function apiTestRule(args) {
  return api_(() => {
    Config.requireAdmin();
    const conditions = Rules.validate(args.conditions);
    const t = BQ.ref(QUERY_CONFIG.bigQuery.assignmentsTable).sql;
    const rows = BQ.query(SQL.assignmentsRecentSnapshots(t), [BQ.p.int64('limit', 300)]).rows;
    const matched = [];
    rows.forEach((r) => {
      let fields = {};
      try { fields = JSON.parse(r.snapshot || '{}'); } catch (e) { fields = {}; }
      if (Rules.matches(conditions, { fields: fields })) matched.push({ ticketId: r.ticket_id, subject: r.subject });
    });
    return { tested: rows.length, matchedCount: matched.length, matched: matched.slice(0, 25) };
  });
}

/* ─────────────────────────────── Roster ─────────────────────────────── */

function apiSaveEmployee(args) {
  return api_(() => {
    const user = Config.requireAdmin();
    const email = text_(args.employee_email, 'Email', 200, true).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ValidationError('Enter a valid email address.');
    const name = text_(args.display_name, 'Name', 100, true);
    const ownerId = text_(args.ivanti_owner_id, 'Ivanti owner ID', 200, false);
    return Store.mutate(ctx_(user, args), (tx) => {
      if (tx.rows('Employees').some((e) => e.id !== args.id && String(e.employee_email).toLowerCase() === email)) {
        throw new ValidationError('An employee with this email already exists.');
      }
      const data = { employee_email: email, display_name: name, ivanti_owner_id: ownerId, active: args.active !== false };
      if (args.id) return tx.update('Employees', args.id, data, args.version);
      return tx.insert('Employees', data);
    });
  });
}

/* ─────────────────────────────── Settings & lists ─────────────────────────────── */

function apiSaveSetting(args) {
  return api_(() => {
    const user = Config.requireAdmin();
    const value = Config.parseSetting(args.key, args.value);
    return Store.mutate(ctx_(user, args), (tx) => {
      const cur = tx.find('Settings', args.key);
      if (cur) return tx.update('Settings', args.key, { value: String(value) }, args.version);
      return tx.insert('Settings', { key: args.key, value: String(value) });
    });
  });
}

const EDITABLE_LISTS = { SubjectIgnoreList: 'Subject ignore list', StopWords: 'Stop words', Admins: 'Admins' };

function apiGetLists() {
  return api_(() => {
    Config.requireAdmin();
    return { SubjectIgnoreList: Store.read('SubjectIgnoreList').filter((r) => r.active),
      StopWords: Store.read('StopWords').filter((r) => r.active), Admins: Store.read('Admins').filter((r) => r.active),
      defaultStopWords: DEFAULT_STOP_WORDS };
  });
}

function apiAddListItem(args) {
  return api_(() => {
    const user = Config.requireAdmin();
    if (!EDITABLE_LISTS[args.list]) throw new ValidationError('Unknown list.');
    const isAdmins = args.list === 'Admins';
    let value = text_(args.value, isAdmins ? 'Email' : 'Value', 200, true);
    if (isAdmins) {
      value = value.toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) throw new ValidationError('Enter a valid email address.');
    } else value = value.toLowerCase();
    const field = isAdmins ? 'email' : 'value';
    return Store.mutate(ctx_(user, args), (tx) => {
      const existing = tx.rows(args.list).find((r) => String(r[field]).toLowerCase() === value);
      if (existing && existing.active) return { status: 'already_present', item: existing };
      if (existing) return { status: 'restored', item: tx.update(args.list, existing.id, { active: true }, null, 'restore') };
      const data = {}; data[field] = value;
      return { status: 'added', item: tx.insert(args.list, data) };
    });
  });
}

function apiRemoveListItem(args) {
  return api_(() => {
    const user = Config.requireAdmin();
    if (!EDITABLE_LISTS[args.list]) throw new ValidationError('Unknown list.');
    return Store.mutate(ctx_(user, args), (tx) => {
      if (args.list === 'Admins' && tx.rows('Admins').filter((a) => a.active).length <= 1) {
        throw new ValidationError('You cannot remove the last admin.');
      }
      const cur = tx.find(args.list, args.id);
      if (!cur || !cur.active) return { status: 'already_removed' };
      return { status: 'removed', item: tx.remove(args.list, args.id, args.version) };
    });
  });
}

function apiTestSubject(args) {
  return api_(() => { Config.requireAdmin(); return FollowUp.testSubject(text_(args.subject, 'Subject', 500, true)); });
}

function apiGetAudit(args) {
  return api_(() => { Config.requireAdmin(); return Store.readAuditTail(Math.min(Number(args && args.limit) || 100, 500)); });
}

function apiRefreshAfterManualEdit() {
  return api_(() => { Config.requireAdmin(); Store.bumpAllRevisions(); return { status: 'refreshed' }; });
}

function apiCheckSetup() {
  return api_(() => { Config.requireAdmin(); return { check: SchemaCheck.checkAll(), triggers: Triggers.status() }; });
}

function apiInstallSchedule() {
  return api_(() => { Config.requireAdmin(); return Triggers.install(); });
}

/* ─────────────────────────────── Runs ─────────────────────────────── */

/** Anyone can click Run now (D19). Only admins can choose a dry run. */
function apiRunNow(args) {
  return api_(() => {
    const user = Config.requireUser();
    const dryRun = !!(args && args.dryRun);
    if (dryRun && !Config.isAdmin(user)) throw new PermissionError('Only admins can start a dry run.');
    return Pipeline.run({ trigger: 'manual', triggeredBy: user, dryRun: dryRun });
  });
}

function apiRunStatus() {
  return api_(() => {
    const user = Config.requireUser();
    const s = Pipeline.status();
    try { const st = Config.settings(); s.schedule = { times: st.RUN_TIMES, days: st.RUN_DAYS }; } catch (e) { s.schedule = null; }
    if (!Config.isAdmin(user)) { s.lastCheck = s.lastCheck ? { ok: s.lastCheck.ok } : null; s.runsError = s.runsError ? 'Run history is not available yet.' : null; }
    return s;
  });
}

/* ─────────────────────────────── Assignment log & queue (admins) ─────────────────────────────── */

function apiSearchAssignments(args) {
  return api_(() => {
    Config.requireAdmin();
    const today = Config.today();
    const from = args && args.from ? requireDate_(args.from, 'From') : addDays_(today, -7);
    const to = args && args.to ? requireDate_(args.to, 'To') : today;
    const t = BQ.ref(QUERY_CONFIG.bigQuery.assignmentsTable).sql;
    const rows = BQ.query(SQL.assignmentsSearch(t), [
      BQ.p.string('tz', Store.tz_()), BQ.p.date('from_date', from), BQ.p.date('to_date', to),
      BQ.p.string('ticket_id', text_(args && args.ticketId, 'Ticket', 100, false)),
      BQ.p.string('employee_id', String((args && args.employeeId) || '')),
      BQ.p.string('mailbox_id', String((args && args.mailboxId) || '')),
      BQ.p.bool('include_dry_run', !!(args && args.includeDryRun)),
    ]).rows;
    const todayCounts = {};
    rows.filter((r) => r.assigned_at && !r.dry_run).forEach((r) => {
      const k = r.employee_id;
      todayCounts[k] = todayCounts[k] || { balanced: 0, followUps: 0 };
      if (r.counts_toward_balance) todayCounts[k].balanced++; else if (r.routing_method === 'follow_up') todayCounts[k].followUps++;
    });
    return { from: from, to: to, rows: rows, perEmployee: todayCounts };
  });
}

function apiReassign(args) {
  return api_(() => {
    const user = Config.requireAdmin();
    return Pipeline.reassign(text_(args.ticketId, 'Ticket', 100, true), String(args.employeeId || ''), args.version, user);
  });
}

function apiRetryWriteback(args) {
  return api_(() => { const user = Config.requireAdmin(); return Pipeline.retryWriteback(text_(args.ticketId, 'Ticket', 100, true), user); });
}

function apiListQueue() {
  return api_(() => {
    Config.requireAdmin();
    return Pipeline.listQueue(['pending', 'no_one_scheduled', 'failed', 'manual_review', 'classified']).map((q) => {
      let p = {};
      try { p = JSON.parse(q.payload_json || '{}'); } catch (e) { p = {}; }
      return { ticket_id: q.ticket_id, subject: p.subject || '', category: p.category || '', status: q.status, reason: q.reason,
        result_mailbox_id: q.result_mailbox_id, confidence: q.confidence, rationale: q.rationale, attempts: q.attempts,
        created_at: q.created_at, version: q.version };
    });
  });
}

function apiResolveQueue(args) {
  return api_(() => {
    const user = Config.requireAdmin();
    return Pipeline.resolveQueue(text_(args.ticketId, 'Ticket', 100, true), String(args.mailboxId || ''),
      args.employeeId ? String(args.employeeId) : null, args.version, user);
  });
}
