/**
 * Config.gs — admin-editable settings (Settings tab), roles, config snapshot and checkConfig().
 */

/** Defaults used when a key is not present in the Settings tab. */
const DEFAULT_SETTINGS = {
  SUBJECT_MATCH_THRESHOLD: { value: 0.75, type: 'number', min: 0.3, max: 1, label: 'Follow-up match threshold (0.3–1)' },
  SUBJECT_MIN_WORDS: { value: 3, type: 'int', min: 1, max: 10, label: 'Minimum meaningful words for a follow-up' },
  RUN_TIMES: { value: '06:00,13:00', type: 'times', label: 'Automatic run times (HH:mm, comma separated)' },
  RUN_DAYS: { value: 'MON,TUE,WED,THU,FRI', type: 'days', label: 'Automatic run days' },
  RUN_NOW_COOLDOWN_MIN: { value: 2, type: 'int', min: 0, max: 60, label: 'Run now cooldown (minutes)' },
  WRITEBACK_MAX_ATTEMPTS: { value: 5, type: 'int', min: 1, max: 20, label: 'Ivanti update retries' },
  VERTEX_MIN_CONFIDENCE: { value: 0.7, type: 'number', min: 0, max: 1, label: 'Vertex minimum confidence' },
};

/** Used only when the StopWords tab has no active entries. */
const DEFAULT_STOP_WORDS = ['a', 'an', 'the', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'at', 'is', 'are',
  'was', 'it', 'my', 'me', 'i', 'we', 'our', 'you', 'your', 'with', 'from', 'by', 'this', 'that', 'please',
  'pls', 'hi', 'hello', 'issue', 'question', 'request', 'regarding', 're', 'about', 'still', 'not'];

const Config = {
  /** Settings merged over defaults, with types applied. */
  settings(rows) {
    rows = rows || Store.read('Settings');
    const out = {};
    Object.keys(DEFAULT_SETTINGS).forEach((k) => { out[k] = DEFAULT_SETTINGS[k].value; });
    rows.forEach((r) => {
      const def = DEFAULT_SETTINGS[r.key];
      if (!def) return;
      try { out[r.key] = Config.parseSetting(r.key, r.value); } catch (e) { /* keep default */ }
    });
    return out;
  },

  parseSetting(key, raw) {
    const def = DEFAULT_SETTINGS[key];
    if (!def) throw new ValidationError('Unknown setting: ' + key);
    const s = String(raw === null || raw === undefined ? '' : raw).trim();
    if (def.type === 'number' || def.type === 'int') {
      const n = Number(s);
      if (s === '' || isNaN(n)) throw new ValidationError(def.label + ' must be a number.');
      if (def.type === 'int' && Math.round(n) !== n) throw new ValidationError(def.label + ' must be a whole number.');
      if (n < def.min || n > def.max) throw new ValidationError(def.label + ' must be between ' + def.min + ' and ' + def.max + '.');
      return n;
    }
    if (def.type === 'times') {
      const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
      if (!parts.length) throw new ValidationError('Enter at least one run time.');
      parts.forEach((p) => { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(p)) throw new ValidationError('Invalid time "' + p + '". Use HH:mm.'); });
      return parts.sort().join(',');
    }
    if (def.type === 'days') {
      const valid = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
      const parts = s.toUpperCase().split(',').map((x) => x.trim()).filter(Boolean);
      parts.forEach((p) => { if (valid.indexOf(p) === -1) throw new ValidationError('Invalid day "' + p + '".'); });
      return parts.join(',');
    }
    return s;
  },

  stopWords(rows) {
    const active = (rows || Store.read('StopWords')).filter((r) => r.active).map((r) => String(r.value).trim().toLowerCase()).filter(Boolean);
    return active.length ? active : DEFAULT_STOP_WORDS.slice();
  },

  /** Consistent snapshot for one assignment run (read under the lock, §5 step 2). */
  snapshot() {
    const s = Store.snapshot(['Mailboxes', 'Rules', 'Employees', 'Schedule', 'Settings', 'SubjectIgnoreList', 'StopWords']);
    const today = Config.today();
    const mailboxes = s.Mailboxes.filter((m) => m.active).sort((a, b) => (a.priority || 0) - (b.priority || 0));
    const employees = s.Employees;
    const settings = Config.settings(s.Settings);
    const stopWords = Config.stopWords(s.StopWords);
    const ignore = s.SubjectIgnoreList.filter((r) => r.active).map((r) => r.value);
    const revs = s._revisions;
    return {
      today: today,
      mailboxes: mailboxes,
      mailboxById: Config.indexBy_(s.Mailboxes, 'id'),
      rules: s.Rules.filter((r) => r.active),
      employees: employees,
      employeeById: Config.indexBy_(employees, 'id'),
      scheduleToday: s.Schedule.filter((e) => e.date === today),
      settings: settings,
      stopWords: stopWords,
      ignoreList: ignore,
      revision: ['Mailboxes', 'Rules', 'Employees', 'Schedule', 'Settings'].map((k) => k[0] + revs[k]).join('.'),
    };
  },

  indexBy_(arr, key) {
    const o = {};
    arr.forEach((x) => { o[x[key]] = x; });
    return o;
  },

  today(date) {
    return Utilities.formatDate(date || new Date(), Store.tz_(), 'yyyy-MM-dd');
  },

  /** Developer settings that are still missing. Empty list = ready. */
  check() {
    const problems = [];
    const iv = QUERY_CONFIG.ivanti, bq = QUERY_CONFIG.bigQuery;
    if (!QUERY_CONFIG.sheet.spreadsheetId) problems.push('QueryConfig.gs: sheet.spreadsheetId is not set.');
    if (!iv.baseUrl) problems.push('QueryConfig.gs: ivanti.baseUrl is not set.');
    if (!PropertiesService.getScriptProperties().getProperty('IVANTI_API_KEY')) problems.push('Script Property IVANTI_API_KEY is not set.');
    if (!bq.projectId) problems.push('QueryConfig.gs: bigQuery.projectId is not set.');
    if (!bq.appDataset) problems.push('QueryConfig.gs: bigQuery.appDataset is not set.');
    ['assignmentsTable', 'runsTable', 'vertexQueueTable'].forEach((k) => { if (!bq[k]) problems.push('QueryConfig.gs: bigQuery.' + k + ' is not set.'); });
    return problems;
  },

  /* ─────────────────────────────── Roles (D16) ─────────────────────────────── */

  currentUser() {
    return String(Session.getActiveUser().getEmail() || '').toLowerCase();
  },

  /** Admins tab; if it has no active admins yet, the account that runs the app is admin (bootstrap). */
  isAdmin(email) {
    email = String(email || '').toLowerCase();
    if (!email) return false;
    const admins = Store.read('Admins').filter((a) => a.active).map((a) => String(a.email).toLowerCase());
    if (admins.length) return admins.indexOf(email) !== -1;
    const owner = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
    return email === owner;
  },

  requireUser() {
    const email = Config.currentUser();
    if (!email) {
      throw new PermissionError('Your Google account could not be identified. The app only works for accounts in your organization.');
    }
    return email;
  },

  requireAdmin() {
    const email = Config.requireUser();
    if (!Config.isAdmin(email)) throw new PermissionError('Only admins can do this.');
    return email;
  },
};
