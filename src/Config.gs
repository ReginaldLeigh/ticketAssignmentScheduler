/**
 * Config.gs — settings, teams and roles.
 *
 *   • DEVELOPER_SETTINGS (QueryConfig.gs): developer-only, never editable in the app.
 *   • Team settings (Settings tab, per team): RUN_TIMES and RUN_DAYS, editable by the team's
 *     managers and admins. The ignore list and stop words are per team too (their own tabs).
 *   • Roles: Manager (from TEAMS in QueryConfig.gs), Admin (Admins tab, added by managers in the app),
 *     Employee (Employees tab). A person is on ONE team only.
 */

/** Developer-only settings: validation ranges (values live in DEVELOPER_SETTINGS). */
const DEVELOPER_SETTING_DEFS = {
  SUBJECT_MATCH_THRESHOLD: { type: 'number', min: 0.3, max: 1 },
  SUBJECT_MIN_WORDS: { type: 'int', min: 1, max: 10 },
  RUN_NOW_COOLDOWN_MIN: { type: 'int', min: 0, max: 60 },
  WRITEBACK_MAX_ATTEMPTS: { type: 'int', min: 1, max: 20 },
  VERTEX_MIN_CONFIDENCE: { type: 'number', min: 0, max: 1 },
};

/** Team settings editable in the app by the team's managers and admins. */
const TEAM_SETTING_DEFS = {
  RUN_TIMES: { value: '06:00,13:00', type: 'times', label: 'Automatic run times (HH:mm, comma separated)' },
  RUN_DAYS: { value: 'MON,TUE,WED,THU,FRI', type: 'days', label: 'Automatic run days' },
};

/** Used only when a team's StopWords list has no active entries. */
const DEFAULT_STOP_WORDS = ['a', 'an', 'the', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'at', 'is', 'are',
  'was', 'it', 'my', 'me', 'i', 'we', 'our', 'you', 'your', 'with', 'from', 'by', 'this', 'that', 'please',
  'pls', 'hi', 'hello', 'issue', 'question', 'request', 'regarding', 're', 'about', 'still', 'not'];

const ROLE_RANK = { employee: 1, admin: 2, manager: 3 };
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const Config = {
  /* ─────────────────────────────── Teams ─────────────────────────────── */

  teams() { return TEAMS.slice(); },

  team(teamId) { return TEAMS.find((t) => t.id === teamId) || null; },

  teamName(teamId) { const t = Config.team(teamId); return t ? t.name : (teamId || ''); },

  managerTeam(email) {
    email = String(email || '').toLowerCase();
    const t = TEAMS.find((x) => (x.managers || []).some((m) => String(m).toLowerCase() === email));
    return t ? t.id : null;
  },

  /* ─────────────────────────────── Settings ─────────────────────────────── */

  /** Developer settings merged with one team's settings (rows = that team's Settings rows). */
  settings(teamId, rows) {
    const out = Object.assign({}, DEVELOPER_SETTINGS);
    Object.keys(TEAM_SETTING_DEFS).forEach((k) => { out[k] = TEAM_SETTING_DEFS[k].value; });
    (rows || (teamId ? Store.read('Settings', { teamId: teamId }) : [])).forEach((r) => {
      if (!TEAM_SETTING_DEFS[r.key]) return;
      try { out[r.key] = Config.parseTeamSetting(r.key, r.value); } catch (e) { /* keep default */ }
    });
    return out;
  },

  parseTeamSetting(key, raw) {
    const def = TEAM_SETTING_DEFS[key];
    if (!def) throw new ValidationError('This setting cannot be changed in the app.');
    const s = String(raw === null || raw === undefined ? '' : raw).trim();
    if (def.type === 'times') {
      const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
      if (!parts.length) throw new ValidationError('Enter at least one run time.');
      parts.forEach((p) => { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(p)) throw new ValidationError('Invalid time "' + p + '". Use HH:mm, e.g. 06:00.'); });
      return parts.sort().filter((p, i, a) => a.indexOf(p) === i).join(',');
    }
    const valid = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
    const parts = s.toUpperCase().split(',').map((x) => x.trim()).filter(Boolean);
    if (!parts.length) throw new ValidationError('Choose at least one day.');
    parts.forEach((p) => { if (valid.indexOf(p) === -1) throw new ValidationError('Invalid day "' + p + '".'); });
    return valid.filter((d) => parts.indexOf(d) !== -1).join(',');
  },

  stopWords(rows) {
    const active = (rows || []).filter((r) => r.active).map((r) => String(r.value).trim().toLowerCase()).filter(Boolean);
    return active.length ? active : DEFAULT_STOP_WORDS.slice();
  },

  /**
   * Consistent snapshot of every team for one assignment run (read under the lock, §5 step 2).
   * Routing needs all teams (rules are checked team by team in TEAMS order).
   */
  snapshot() {
    const s = Store.snapshot(['Mailboxes', 'Rules', 'Employees', 'Schedule', 'Settings', 'SubjectIgnoreList', 'StopWords']);
    const today = Config.today();
    const teams = Config.teams();
    const known = {}; teams.forEach((t) => { known[t.id] = true; });
    const ofTeam = (rows, id) => rows.filter((r) => r.team_id === id);
    const mailboxes = s.Mailboxes.filter((m) => m.active && known[m.team_id]);
    const rules = s.Rules.filter((r) => r.active && known[r.team_id]);
    const byTeam = {};
    teams.forEach((t) => {
      byTeam[t.id] = {
        mailboxes: ofTeam(mailboxes, t.id).sort((a, b) => (a.priority || 0) - (b.priority || 0) || String(a.name).localeCompare(String(b.name))),
        settings: Config.settings(t.id, ofTeam(s.Settings, t.id)),
        stopWords: Config.stopWords(ofTeam(s.StopWords, t.id)),
        ignoreList: ofTeam(s.SubjectIgnoreList, t.id).filter((r) => r.active).map((r) => r.value),
      };
    });
    const rulesByMailbox = {};
    rules.forEach((r) => { (rulesByMailbox[r.mailbox_id] = rulesByMailbox[r.mailbox_id] || []).push(r); });
    const revs = (Number(s.Mailboxes.length) + '.' + s.Rules.length + '.' + s.Employees.length + '.' + s.Schedule.length);
    return {
      today: today,
      teams: teams,
      byTeam: byTeam,
      dev: Object.assign({}, DEVELOPER_SETTINGS),
      mailboxes: mailboxes,
      mailboxById: Config.indexBy_(s.Mailboxes, 'id'),
      rules: rules,
      rulesByMailbox: rulesByMailbox,
      employees: s.Employees,
      employeeById: Config.indexBy_(s.Employees, 'id'),
      scheduleToday: s.Schedule.filter((e) => e.date === today),
      revision: 'v' + Utilities.getUuid().slice(0, 4) + '.' + revs,
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

  /** Developer settings, teams and connections that are missing or invalid. Empty list = ready. */
  check() {
    const problems = [];
    const iv = QUERY_CONFIG.ivanti, bq = QUERY_CONFIG.bigQuery;
    if (!QUERY_CONFIG.sheet.spreadsheetId) problems.push('QueryConfig.gs: sheet.spreadsheetId is not set.');
    if (!iv.baseUrl) problems.push('QueryConfig.gs: ivanti.baseUrl is not set.');
    if (!PropertiesService.getScriptProperties().getProperty('IVANTI_API_KEY')) problems.push('Script Property IVANTI_API_KEY is not set.');
    if (!iv.employeeLookup || !iv.employeeLookup.enabled) {
      problems.push('Ivanti employee lookup is not set up: add the existing function to lookupIvantiEmployee_() in Ivanti.gs and set ivanti.employeeLookup.enabled = true.');
    }
    if (!bq.projectId) problems.push('QueryConfig.gs: bigQuery.projectId is not set.');
    if (!bq.appDataset) problems.push('QueryConfig.gs: bigQuery.appDataset is not set.');
    ['assignmentsTable', 'runsTable', 'vertexQueueTable'].forEach((k) => { if (!bq[k]) problems.push('QueryConfig.gs: bigQuery.' + k + ' is not set.'); });
    return problems.concat(Config.checkTeams(), Config.checkDeveloperSettings());
  },

  checkTeams() {
    const problems = [];
    if (!TEAMS.length) return ['QueryConfig.gs: TEAMS has no teams. Add at least one team with its managers.'];
    const ids = {}, managers = {};
    TEAMS.forEach((t, i) => {
      const where = 'TEAMS[' + i + ']';
      if (!t || !/^[a-z0-9_-]{1,40}$/.test(String(t.id || ''))) problems.push(where + ': id must be lower-case letters, digits, - or _.');
      else if (ids[t.id]) problems.push(where + ': id "' + t.id + '" is used twice.');
      else ids[t.id] = true;
      if (!t || !String(t.name || '').trim()) problems.push(where + ': name is missing.');
      const ms = (t && t.managers) || [];
      if (!ms.length) problems.push(where + ' (' + (t && t.name) + '): add at least one manager email.');
      ms.forEach((m) => {
        const e = String(m).toLowerCase();
        if (!EMAIL_RE.test(e)) problems.push(where + ': "' + m + '" is not a valid email.');
        else if (managers[e]) problems.push(where + ': ' + e + ' is a manager of two teams. A person can be on one team only.');
        else managers[e] = true;
      });
    });
    return problems;
  },

  checkDeveloperSettings() {
    const problems = [];
    Object.keys(DEVELOPER_SETTING_DEFS).forEach((k) => {
      const def = DEVELOPER_SETTING_DEFS[k], v = DEVELOPER_SETTINGS[k];
      if (typeof v !== 'number' || isNaN(v) || v < def.min || v > def.max || (def.type === 'int' && Math.round(v) !== v)) {
        problems.push('QueryConfig.gs: DEVELOPER_SETTINGS.' + k + ' must be ' + (def.type === 'int' ? 'a whole number ' : 'a number ') +
          'between ' + def.min + ' and ' + def.max + '.');
      }
    });
    return problems;
  },

  /* ─────────────────────────────── Roles ─────────────────────────────── */

  currentUser() {
    return String(Session.getActiveUser().getEmail() || '').toLowerCase();
  },

  /**
   * Who is this person? → { email, teamId, teamName, role } or null.
   * Manager (TEAMS config) > Admin (Admins tab) > Employee (Employees tab). One team per person.
   */
  identify(email) {
    email = String(email || '').toLowerCase();
    if (!email) return null;
    const mTeam = Config.managerTeam(email);
    if (mTeam) return { email: email, teamId: mTeam, teamName: Config.teamName(mTeam), role: 'manager' };
    const known = {}; TEAMS.forEach((t) => { known[t.id] = true; });
    const admin = Store.read('Admins').find((a) => a.active && known[a.team_id] && String(a.email).toLowerCase() === email);
    if (admin) return { email: email, teamId: admin.team_id, teamName: Config.teamName(admin.team_id), role: 'admin' };
    const emp = Store.read('Employees').find((e) => e.active && known[e.team_id] && String(e.employee_email).toLowerCase() === email);
    if (emp) return { email: email, teamId: emp.team_id, teamName: Config.teamName(emp.team_id), role: 'employee', employeeId: emp.id };
    return null;
  },

  /**
   * The caller, with at least role `min` ('employee' | 'admin' | 'manager').
   * Returns { user, teamId, teamName, role, requestId? } — usable directly as a Store ctx.
   */
  require(min) {
    const email = Config.currentUser();
    if (!email) {
      throw new PermissionError('Your Google account could not be identified. The app only works for accounts in your organization.');
    }
    const who = Config.identify(email);
    if (!who) throw new PermissionError("You're not on a team in this app yet. Ask your manager to add you.");
    if (ROLE_RANK[who.role] < ROLE_RANK[min || 'employee']) {
      throw new PermissionError(min === 'manager' ? 'Only managers can do this.' : 'Only managers and admins can do this.');
    }
    return { user: email, teamId: who.teamId, teamName: who.teamName, role: who.role, employeeId: who.employeeId || null };
  },

  /**
   * One team per person (A2). Inside a Store tx: throws if `email` is on a team other than
   * `teamId` (as manager, active admin or active employee).
   */
  assertNotOnOtherTeam(tx, email, teamId) {
    email = String(email || '').toLowerCase();
    const mTeam = Config.managerTeam(email);
    let other = mTeam && mTeam !== teamId ? mTeam : null;
    if (!other) {
      const a = tx.rows('Admins', { allTeams: true }).find((x) => x.active && x.team_id !== teamId && String(x.email).toLowerCase() === email);
      const e = tx.rows('Employees', { allTeams: true }).find((x) => x.active && x.team_id !== teamId && String(x.employee_email).toLowerCase() === email);
      other = (a && a.team_id) || (e && e.team_id) || null;
    }
    if (other) {
      throw new ValidationError(email + ' is already on the ' + Config.teamName(other) + " team. Ask that team's manager to remove them first.");
    }
  },
};
