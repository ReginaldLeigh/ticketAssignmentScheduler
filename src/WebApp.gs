/**
 * WebApp.gs — web app entry point and the server functions the browser calls (google.script.run).
 *
 * Access model: deployed "Execute as: me" / "Access: your domain". Every call runs as the one
 * account that owns the app; users need no BigQuery, Sheet or Ivanti access.
 *
 * Teams and roles (change request §5): every call identifies the caller's ONE team and role on the
 * server (Config.require). Reads return only that team's data; writes run in a team-scoped Store tx
 * that refuses other teams' records. The one deliberate exception is the SHARED unrouted queue,
 * which every team's managers and admins see, limited to the developer-chosen fields.
 *
 *   Employee  view schedule, mailboxes and rules · Run now
 *   Admin     + edit schedule, mailboxes, rules, roster, team settings · log · queues · dry run
 *   Manager   + add and remove the team's admins
 *
 * Ivanti IDs never leave the server: every employee sent to a browser goes through publicEmployee_().
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

/** Store ctx for a caller (from Config.require) plus the browser's request id. */
function ctx_(caller, args) {
  return { user: caller.user, teamId: caller.teamId, requestId: args && args.requestId ? String(args.requestId).slice(0, 64) : null };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_CODES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MAX_RANGE_DAYS = 92;
function addDays_(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function dayCode_(dateStr) { return DAY_CODES[new Date(dateStr + 'T12:00:00Z').getUTCDay()]; }
function requireDate_(s, label) { if (!DATE_RE.test(String(s || ''))) throw new ValidationError((label || 'Date') + ' must look like 2026-11-16.'); return s; }
function text_(v, label, max, required) {
  const s = String(v === null || v === undefined ? '' : v).trim();
  if (required && !s) throw new ValidationError(label + ' is required.');
  if (s.length > max) throw new ValidationError(label + ' must be at most ' + max + ' characters.');
  return s;
}
function isAdminRole_(role) { return role === 'admin' || role === 'manager'; }

/** The only shape in which an employee leaves the server. Never includes the Ivanti ID. */
function publicEmployee_(e, role) {
  if (!isAdminRole_(role)) return { id: e.id, display_name: e.display_name, active: e.active };
  return { id: e.id, display_name: e.display_name, employee_email: e.employee_email, active: e.active, version: e.version,
    linked: !!e.ivanti_owner_id, ivanti_lookup_status: e.ivanti_owner_id ? 'found' : (e.ivanti_lookup_status || 'unknown'),
    ivanti_checked_at: e.ivanti_checked_at || null };
}

/* ─────────────────────────────── Bootstrap & polling ─────────────────────────────── */

function apiBootstrap() {
  return api_(() => {
    const setup = SchemaCheck.checkSheets().concat(Config.checkTeams());
    if (setup.length) return { user: Config.currentUser(), role: null, setupProblems: setup };
    const c = Config.require('employee');
    const admin = isAdminRole_(c.role);
    const out = {
      user: c.user, role: c.role, isAdmin: admin, canManageAdmins: c.role === 'manager', setupProblems: [],
      team: { id: c.teamId, name: c.teamName }, employeeId: c.employeeId,
      today: Config.today(), timeZone: Store.tz_(),
      revisions: Store.getRevisions(c.teamId),
      mailboxes: Store.read('Mailboxes', { teamId: c.teamId }),
      employees: Store.read('Employees', { teamId: c.teamId }).map((e) => publicEmployee_(e, c.role)),
      ruleFields: QUERY_CONFIG.ivanti.selectFields.slice(),
      operators: RULE_OPERATORS,
      teamSettingDefs: TEAM_SETTING_DEFS,
    };
    if (admin) out.settings = Config.settings(c.teamId);
    return out;
  });
}

/** Light poll (every 30 s while the tab is visible): this team's revisions + whether a run is in progress. */
function apiPoll() {
  return api_(() => {
    const c = Config.require('employee');
    return { revisions: Store.getRevisions(c.teamId), running: Pipeline.describeLease_(Lease.current()) };
  });
}

/** Human-readable notes for this team's changes after `since` (ISO), e.g. "jordan added Sam to Billing (Tue)". */
function apiGetChanges(args) {
  return api_(() => {
    const c = Config.require('employee');
    const since = String((args && args.since) || '');
    const entries = Store.readAuditTail(30, c.teamId).filter((e) => !since || String(e.at) > since);
    if (!entries.length) return { notes: [], latest: since };
    const emps = Config.indexBy_(Store.read('Employees', { teamId: c.teamId }), 'id');
    const mbs = Config.indexBy_(Store.read('Mailboxes', { teamId: c.teamId }), 'id');
    const who = (u) => (u === c.user ? 'You' : String(u || 'someone').split('@')[0]);
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
      if (e.action === 'ivanti_lookup') return (rec.display_name || 'An employee') + "'s Ivanti link was updated";
      const label = { Mailboxes: 'mailbox', Rules: 'a rule', Employees: 'employee', Settings: 'a team setting', Admins: 'admin',
        SubjectIgnoreList: 'the subject ignore list', StopWords: 'stop words' }[e.entity] || e.entity;
      const name = rec.name || rec.display_name || rec.email || rec.value || '';
      return who(e.user) + ' ' + (e.action === 'insert' ? 'added' : e.action === 'remove' ? 'removed' : 'updated') + ' ' + label +
        (name && label !== 'a rule' && label !== 'a team setting' ? ' ' + name : '');
    });
    return { notes: notes, latest: entries[0].at };
  });
}

/* ─────────────────────────────── Schedule ─────────────────────────────── */

function apiGetWeek(args) {
  return api_(() => {
    const c = Config.require('employee');
    const start = requireDate_(args && args.weekStart, 'Week start');
    const end = addDays_(start, 6);
    return {
      weekStart: start,
      entries: Store.read('Schedule', { teamId: c.teamId }).filter((e) => e.date >= start && e.date <= end),
      mailboxes: Store.read('Mailboxes', { teamId: c.teamId }),
      employees: Store.read('Employees', { teamId: c.teamId }).map((e) => publicEmployee_(e, c.role)),
      revisions: Store.getRevisions(c.teamId),
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
    const c = Config.require('admin');
    return Store.mutate(ctx_(c, args), (tx) => {
      const t = checkScheduleTarget_(tx, args.date, args.mailboxId, args.employeeId);
      const dup = tx.rows('Schedule').find((e) => e.date === args.date && e.mailbox_id === args.mailboxId && e.employee_id === args.employeeId);
      if (dup) return { status: 'already_scheduled', entry: dup, message: t.emp.display_name + ' is already scheduled there.' };
      return { status: 'added', entry: tx.insert('Schedule', { date: args.date, mailbox_id: args.mailboxId, employee_id: args.employeeId }) };
    });
  });
}

function apiScheduleRemove(args) {
  return api_(() => {
    const c = Config.require('admin');
    return Store.mutate(ctx_(c, args), (tx) => {
      const cur = tx.find('Schedule', args.id);
      if (!cur || cur.deleted_at) return { status: 'already_removed' };
      return { status: 'removed', entry: tx.remove('Schedule', args.id, args.version) };
    });
  });
}

function apiScheduleMove(args) {
  return api_(() => {
    const c = Config.require('admin');
    return Store.mutate(ctx_(c, args), (tx) => {
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
    const c = Config.require('admin');
    const from = requireDate_(args.fromStart, 'Source week');
    const to = requireDate_(args.toStart, 'Target week');
    const offset = Math.round((Date.parse(to + 'T12:00:00Z') - Date.parse(from + 'T12:00:00Z')) / 86400000);
    if (offset === 0) throw new ValidationError('Choose a different week to copy into.');
    return Store.mutate(ctx_(c, args), (tx) => {
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

/** Dates from..to (inclusive) that fall on the chosen days. Validates the range. */
function rangeDates_(from, to, days) {
  requireDate_(from, 'From'); requireDate_(to, 'To');
  if (to < from) throw new ValidationError('"To" must be on or after "From".');
  const span = Math.round((Date.parse(to + 'T12:00:00Z') - Date.parse(from + 'T12:00:00Z')) / 86400000) + 1;
  if (span > MAX_RANGE_DAYS) throw new ValidationError('A range can be at most ' + MAX_RANGE_DAYS + ' days. Choose a shorter range.');
  const want = (Array.isArray(days) ? days : []).map((d) => String(d).toUpperCase()).filter((d) => DAY_CODES.indexOf(d) !== -1);
  if (!want.length) throw new ValidationError('Choose at least one day of the week.');
  const out = [];
  for (let i = 0; i < span; i++) { const d = addDays_(from, i); if (want.indexOf(dayCode_(d)) !== -1) out.push(d); }
  if (!out.length) throw new ValidationError('No dates in that range fall on the chosen days.');
  return out;
}

/**
 * Schedule (or clear) one employee on one mailbox for every chosen weekday in a date range, in one
 * all-or-nothing save. args: { requestId, employeeId, mailboxId, from, to, days: ['MON',…], action: 'add'|'remove', preview }
 * preview: true → counts only, nothing saved.
 */
function apiScheduleRange(args) {
  return api_(() => {
    const c = Config.require('admin');
    const action = args && args.action === 'remove' ? 'remove' : 'add';
    const dates = rangeDates_(args.from, args.to, args.days);
    const plan = (rows, mb, emp) => {
      const mine = rows.filter((e) => e.employee_id === args.employeeId);
      const here = {}; mine.filter((e) => e.mailbox_id === args.mailboxId).forEach((e) => { here[e.date] = e; });
      const elsewhere = [];
      if (action === 'add') {
        const names = Config.indexBy_(Store.read('Mailboxes', { teamId: c.teamId }), 'id');
        mine.filter((e) => e.mailbox_id !== args.mailboxId && dates.indexOf(e.date) !== -1)
          .forEach((e) => elsewhere.push({ date: e.date, mailbox: (names[e.mailbox_id] || {}).name || 'another mailbox' }));
      }
      return { here: here, elsewhere: elsewhere, employee: emp.display_name, mailbox: mb.name,
        toAdd: dates.filter((d) => !here[d]), toRemove: dates.filter((d) => here[d]) };
    };
    const summarise = (p) => ({ action: action, dates: dates.length, employee: p.employee, mailbox: p.mailbox,
      add: p.toAdd.length, skip: action === 'add' ? dates.length - p.toAdd.length : dates.length - p.toRemove.length,
      remove: p.toRemove.length, alsoOn: p.elsewhere.slice(0, 10), firstDate: dates[0] });
    if (args.preview) {
      const mb = Store.read('Mailboxes', { teamId: c.teamId }).find((m) => m.id === args.mailboxId && m.active);
      const emp = Store.read('Employees', { teamId: c.teamId }).find((e) => e.id === args.employeeId && e.active);
      if (!mb || !emp) throw new ValidationError('Choose an active employee and mailbox from your team.');
      return summarise(plan(Store.read('Schedule', { teamId: c.teamId }), mb, emp));
    }
    return Store.mutate(ctx_(c, args), (tx) => {
      const t = checkScheduleTarget_(tx, dates[0], args.mailboxId, args.employeeId);
      const p = plan(tx.rows('Schedule'), t.mb, t.emp);
      if (action === 'add') p.toAdd.forEach((d) => tx.insert('Schedule', { date: d, mailbox_id: args.mailboxId, employee_id: args.employeeId }));
      else p.toRemove.forEach((d) => tx.remove('Schedule', p.here[d].id));
      const s = summarise(p);
      return { action: action, added: action === 'add' ? s.add : 0, removed: action === 'remove' ? s.remove : 0, skipped: s.skip, firstDate: s.firstDate };
    });
  });
}

/* ─────────────────────────────── Mailboxes & rules ─────────────────────────────── */

function apiListRules() {
  return api_(() => {
    const c = Config.require('employee');
    return { rules: Store.read('Rules', { teamId: c.teamId }), mailboxes: Store.read('Mailboxes', { teamId: c.teamId }) };
  });
}

function apiSaveMailbox(args) {
  return api_(() => {
    const c = Config.require('admin');
    const name = text_(args.name, 'Name', 100, true);
    const description = text_(args.description, 'Description', 500, false);
    return Store.mutate(ctx_(c, args), (tx) => {
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

/** Move a mailbox up/down in rule-check priority, relative to the team's CURRENT order (§6.5). */
function apiMoveMailbox(args) {
  return api_(() => {
    const c = Config.require('admin');
    return Store.mutate(ctx_(c, args), (tx) => {
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
    const c = Config.require('admin');
    const conditions = Rules.validate(args.conditions);
    return Store.mutate(ctx_(c, args), (tx) => {
      const mb = tx.find('Mailboxes', args.mailboxId);
      if (!mb) throw new ValidationError('Choose one of your team\'s mailboxes.');
      if (!mb.active && args.active !== false) throw new ValidationError('Mailbox "' + mb.name + '" is not active (someone may have just deactivated it).');
      const data = { mailbox_id: args.mailboxId, conditions_json: conditions, active: args.active !== false };
      if (args.id) return tx.update('Rules', args.id, data, args.version);
      return tx.insert('Rules', data);
    });
  });
}

function apiRemoveRule(args) {
  return api_(() => {
    const c = Config.require('admin');
    return Store.mutate(ctx_(c, args), (tx) => tx.remove('Rules', args.id, args.version));
  });
}

/**
 * Try conditions against the team's tickets from the last 30 days. Also reports matches that an
 * earlier team in TEAMS order would take first (A8), so overlaps are visible before saving.
 */
function apiTestRule(args) {
  return api_(() => {
    const c = Config.require('admin');
    const conditions = Rules.validate(args.conditions);
    const t = BQ.ref(QUERY_CONFIG.bigQuery.assignmentsTable).sql;
    const rows = BQ.query(SQL.assignmentsRecentSnapshots(t), [BQ.p.string('team_id', c.teamId), BQ.p.int64('limit', 300)]).rows;
    const snap = Config.snapshot();
    const myIndex = TEAMS.findIndex((x) => x.id === c.teamId);
    const matched = [];
    const claimed = {};
    rows.forEach((r) => {
      let fields = {};
      try { fields = JSON.parse(r.snapshot || '{}'); } catch (e) { fields = {}; }
      if (!Rules.matches(conditions, { fields: fields })) return;
      matched.push({ ticketId: r.ticket_id, subject: r.subject });
      const route = Rules.route({ fields: fields }, snap);
      if (route && route.teamId !== c.teamId && TEAMS.findIndex((x) => x.id === route.teamId) < myIndex) {
        const n = Config.teamName(route.teamId); claimed[n] = (claimed[n] || 0) + 1;
      }
    });
    return { tested: rows.length, matchedCount: matched.length, matched: matched.slice(0, 25),
      claimedByOtherTeams: Object.keys(claimed).map((k) => ({ team: k, count: claimed[k] })) };
  });
}

/* ─────────────────────────────── Roster ─────────────────────────────── */

function lookupMessage_(name, email, r) {
  if (r.status === 'found') return null;
  if (r.status === 'not_found') {
    return 'Saved. Ivanti has no employee with the email ' + email + '. ' + name +
      " can be scheduled but won't receive tickets until Ivanti finds them. Check the email, or ask your Ivanti administrator.";
  }
  return 'Saved. Ivanti couldn\'t be reached to link ' + name + '. The app will try again at the next run.' + (r.error ? ' (' + r.error + ')' : '');
}

/** Roster accepts name and email only; the Ivanti ID is looked up on the server (change request §4). */
function apiSaveEmployee(args) {
  return api_(() => {
    const c = Config.require('admin');
    const email = text_(args.employee_email, 'Email', 200, true).toLowerCase();
    if (!EMAIL_RE.test(email)) throw new ValidationError('Enter a valid email address.');
    const name = text_(args.display_name, 'Name', 100, true);
    const existing = args.id ? Store.read('Employees', { teamId: c.teamId }).find((e) => e.id === args.id) : null;
    if (args.id && !existing) throw new NotFoundError('This employee no longer exists in your team.');
    const needsLookup = !existing || String(existing.employee_email).toLowerCase() !== email || !existing.ivanti_owner_id;
    const r = needsLookup ? IvantiLookup.resolve(email) : null;   // outside the lock: Ivanti may be slow
    const saved = Store.mutate(ctx_(c, args), (tx) => {
      Config.assertNotOnOtherTeam(tx, email, c.teamId);
      if (tx.rows('Employees').some((e) => e.id !== args.id && String(e.employee_email).toLowerCase() === email)) {
        throw new ValidationError('An employee with this email is already on your roster.');
      }
      const data = { employee_email: email, display_name: name, active: args.active !== false };
      if (r) Object.assign(data, { ivanti_owner_id: r.id || '', ivanti_lookup_status: r.status, ivanti_checked_at: new Date().toISOString() });
      return args.id ? tx.update('Employees', args.id, data, args.version) : tx.insert('Employees', data);
    });
    return { employee: publicEmployee_(saved, c.role), lookup: r ? { status: r.status, message: lookupMessage_(name, email, r) } : null };
  });
}

/** "Check again" on the Roster: look the employee up in Ivanti now. */
function apiCheckEmployeeLink(args) {
  return api_(() => {
    const c = Config.require('admin');
    const emp = Store.read('Employees', { teamId: c.teamId }).find((e) => e.id === args.id);
    if (!emp) throw new NotFoundError('This employee no longer exists in your team.');
    const r = IvantiLookup.resolve(emp.employee_email);
    const saved = Store.mutate(ctx_(c, args), (tx) => {
      const cur = tx.find('Employees', emp.id);
      if (!cur || cur.employee_email !== emp.employee_email) throw new ConflictError('This employee was changed by someone else. Try again.');
      return tx.update('Employees', emp.id, { ivanti_owner_id: r.id || '', ivanti_lookup_status: r.status, ivanti_checked_at: new Date().toISOString() },
        null, 'ivanti_lookup');
    });
    return { employee: publicEmployee_(saved, c.role), lookup: { status: r.status,
      message: r.status === 'found' ? emp.display_name + ' is now linked to Ivanti.' : lookupMessage_(emp.display_name, emp.employee_email, r) } };
  });
}

/* ─────────────────────────────── Team settings & lists ─────────────────────────────── */

function apiGetTeamSettings() {
  return api_(() => {
    const c = Config.require('admin');
    const active = (tab) => Store.read(tab, { teamId: c.teamId }).filter((r) => r.active);
    return {
      settings: Config.settings(c.teamId), settingRows: Store.read('Settings', { teamId: c.teamId }), defs: TEAM_SETTING_DEFS,
      SubjectIgnoreList: active('SubjectIgnoreList'), StopWords: active('StopWords'), Admins: active('Admins'),
      managers: (Config.team(c.teamId).managers || []).slice(), canManageAdmins: c.role === 'manager',
      defaultStopWords: DEFAULT_STOP_WORDS, threshold: DEVELOPER_SETTINGS.SUBJECT_MATCH_THRESHOLD,
    };
  });
}

function apiSaveTeamSetting(args) {
  return api_(() => {
    const c = Config.require('admin');
    const value = Config.parseTeamSetting(args.key, args.value);
    return Store.mutate(ctx_(c, args), (tx) => {
      const cur = tx.rows('Settings').find((r) => r.key === args.key);
      if (cur) return tx.update('Settings', cur.id, { value: String(value) }, args.version);
      return tx.insert('Settings', { key: args.key, value: String(value) });
    });
  });
}

const EDITABLE_LISTS = { SubjectIgnoreList: 'admin', StopWords: 'admin', Admins: 'manager' };

function apiAddListItem(args) {
  return api_(() => {
    const need = EDITABLE_LISTS[args && args.list];
    if (!need) throw new ValidationError('Unknown list.');
    const c = Config.require(need);
    const isAdmins = args.list === 'Admins';
    const value = text_(args.value, isAdmins ? 'Email' : 'Value', 200, true).toLowerCase();
    if (isAdmins && !EMAIL_RE.test(value)) throw new ValidationError('Enter a valid email address.');
    if (isAdmins && Config.managerTeam(value) === c.teamId) throw new ValidationError(value + ' is already a manager of this team.');
    const field = isAdmins ? 'email' : 'value';
    return Store.mutate(ctx_(c, args), (tx) => {
      if (isAdmins) Config.assertNotOnOtherTeam(tx, value, c.teamId);
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
    const need = EDITABLE_LISTS[args && args.list];
    if (!need) throw new ValidationError('Unknown list.');
    const c = Config.require(need);
    return Store.mutate(ctx_(c, args), (tx) => {
      const cur = tx.find(args.list, args.id);
      if (!cur || !cur.active) return { status: 'already_removed' };
      return { status: 'removed', item: tx.remove(args.list, args.id, args.version) };
    });
  });
}

function apiTestSubject(args) {
  return api_(() => { const c = Config.require('admin'); return FollowUp.testSubject(text_(args.subject, 'Subject', 500, true), c.teamId); });
}

function apiGetAudit(args) {
  return api_(() => {
    const c = Config.require('admin');
    // Who, when, what and which record; the raw before/after records stay on the server.
    return Store.readAuditTail(Math.min(Number(args && args.limit) || 100, 500), c.teamId)
      .map((e) => ({ at: e.at, user: e.user, entity: e.entity, entity_id: e.entity_id, action: e.action }));
  });
}

function apiCheckSetup() {
  return api_(() => { Config.require('admin'); return { check: SchemaCheck.checkAll(), triggers: Triggers.status() }; });
}

function apiInstallSchedule() {
  return api_(() => { Config.require('admin'); return Triggers.install(); });
}

/* ─────────────────────────────── Runs ─────────────────────────────── */

/** Every role can click Run now (A7); it runs the caller's team. Only managers and admins can dry-run. */
function apiRunNow(args) {
  return api_(() => {
    const c = Config.require('employee');
    const dryRun = !!(args && args.dryRun);
    if (dryRun && !isAdminRole_(c.role)) throw new PermissionError('Only managers and admins can start a dry run.');
    return Pipeline.run({ teamId: c.teamId, trigger: 'manual', triggeredBy: c.user, dryRun: dryRun });
  });
}

function apiRunStatus() {
  return api_(() => {
    const c = Config.require('employee');
    const s = Pipeline.status(c.teamId);
    try { const st = Config.settings(c.teamId); s.schedule = { times: st.RUN_TIMES, days: st.RUN_DAYS }; } catch (e) { s.schedule = null; }
    s.teamName = c.teamName;
    if (!isAdminRole_(c.role)) { s.lastCheck = s.lastCheck ? { ok: s.lastCheck.ok } : null; s.runsError = s.runsError ? 'Run history is not available yet.' : null; }
    return s;
  });
}

/* ─────────────────────────────── Assignment log & queues (managers and admins) ─────────────────────────────── */

function apiSearchAssignments(args) {
  return api_(() => {
    const c = Config.require('admin');
    const today = Config.today();
    const from = args && args.from ? requireDate_(args.from, 'From') : addDays_(today, -7);
    const to = args && args.to ? requireDate_(args.to, 'To') : today;
    const t = BQ.ref(QUERY_CONFIG.bigQuery.assignmentsTable).sql;
    const rows = BQ.query(SQL.assignmentsSearch(t), [
      BQ.p.string('team_id', c.teamId), BQ.p.string('tz', Store.tz_()), BQ.p.date('from_date', from), BQ.p.date('to_date', to),
      BQ.p.string('ticket_id', text_(args && args.ticketId, 'Ticket', 100, false)),
      BQ.p.string('employee_id', String((args && args.employeeId) || '')),
      BQ.p.string('mailbox_id', String((args && args.mailboxId) || '')),
      BQ.p.bool('include_dry_run', !!(args && args.includeDryRun)),
    ]).rows;
    const perEmployee = {};
    rows.filter((r) => r.assigned_at && !r.dry_run).forEach((r) => {
      const k = r.employee_id;
      perEmployee[k] = perEmployee[k] || { balanced: 0, followUps: 0 };
      if (r.counts_toward_balance) perEmployee[k].balanced++; else if (r.routing_method === 'follow_up') perEmployee[k].followUps++;
    });
    return { from: from, to: to, rows: rows, perEmployee: perEmployee };
  });
}

function apiReassign(args) {
  return api_(() => {
    const c = Config.require('admin');
    return Pipeline.reassign(c, text_(args.ticketId, 'Ticket', 100, true), String(args.employeeId || ''), args.version);
  });
}

function apiRetryWriteback(args) {
  return api_(() => { const c = Config.require('admin'); return Pipeline.retryWriteback(c, text_(args.ticketId, 'Ticket', 100, true)); });
}

const SHARED_FIELD_LABELS = { ticketId: 'Ticket', createdAt: 'Arrived', subject: 'Subject', description: 'Description',
  category: 'Category', subcategory: 'Subcategory' };
const PAYLOAD_KEYS = { ticketId: 'ticket_id', createdAt: 'created_at', subject: 'subject', description: 'description',
  category: 'category', subcategory: 'subcategory' };

/** Only the developer-chosen fields of a shared ticket (QUERY_CONFIG.sharedQueue.visibleFields). */
function sharedView_(payload) {
  const out = {};
  (QUERY_CONFIG.sharedQueue.visibleFields || []).forEach((f) => {
    const v = PAYLOAD_KEYS[f] ? payload[PAYLOAD_KEYS[f]] : (payload.fields || {})[f];
    out[f] = v === undefined || v === null ? '' : String(v).slice(0, 500);
  });
  return out;
}

function apiListQueue() {
  return api_(() => {
    const c = Config.require('admin');
    const q = Pipeline.listQueues(c.teamId);
    const parse = (s) => { try { return JSON.parse(s || '{}'); } catch (e) { return {}; } };
    return {
      team: q.team.map((r) => {
        const p = parse(r.payload_json);
        return { ticket_id: r.ticket_id, subject: p.subject || '', category: p.category || '', status: r.status, reason: r.reason,
          created_at: r.created_at, version: r.version };
      }),
      shared: q.shared.map((r) => ({ ticket_id: r.ticket_id, version: r.version, status: r.status, fields: sharedView_(parse(r.payload_json)) })),
      sharedFields: (QUERY_CONFIG.sharedQueue.visibleFields || []).map((f) => ({ key: f, label: SHARED_FIELD_LABELS[f] || f })),
    };
  });
}

function apiResolveQueue(args) {
  return api_(() => {
    const c = Config.require('admin');
    return Pipeline.resolveQueue(c, text_(args.ticketId, 'Ticket', 100, true), String(args.mailboxId || ''),
      args.employeeId ? String(args.employeeId) : null, args.version);
  });
}
