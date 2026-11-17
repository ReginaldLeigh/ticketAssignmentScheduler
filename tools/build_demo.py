#!/usr/bin/env python3
"""Build preview/demo.html: the REAL app (dist/Code.gs + the real UI) running entirely in the browser.

Google services (Sheets, BigQuery, Ivanti, locks, properties) are replaced by the same in-memory
mocks the unit tests use (tests/harness.js), and google.script.run calls the server functions
directly. Nothing is saved: reloading the page starts over with fresh sample data.

Run:  python3 tools/condense.py && python3 tools/build_demo.py
"""
import os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def read(*p):
    with open(os.path.join(ROOT, *p), encoding='utf-8') as f:
        return f.read()

code = read('dist', 'Code.gs')
harness = read('tests', 'harness.js')
mocks = harness[harness.index('function formatDate'):harness.index('/**\n * Load the app.')]
styles = read('src', 'html', 'Styles.html')
app = read('src', 'html', 'App.html')
app_js = re.search(r'<script>(.*)</script>', app, re.S).group(1)

# Demo-only hooks in the UI: re-boot when switching roles, and poll every 5 s so live updates show quickly.
old_poll = """    setInterval(() => { if (!document.hidden) poll(); }, 30000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });"""
assert old_poll in app_js
app_js = app_js.replace(old_poll, """    if (!window.__demoPolling) {
      window.__demoPolling = true;
      setInterval(() => { if (!document.hidden) poll(); }, 5000);
    }""")
assert app_js.rstrip().endswith('boot();\n})();') or app_js.rstrip().endswith('boot();\n})();'.strip())
app_js = re.sub(r'\n  boot\(\);\n\}\)\(\);\s*$', """
  window.__demoBoot = function () { S.view = 'schedule'; S.editing = false; S.filterEmp = ''; fill(document.getElementById('toasts')); boot(); };
  boot();
})();
""", app_js)
assert '__demoBoot' in app_js

for chunk in (code, mocks, app_js):
    assert '</script' not in chunk

DEMO_SETUP = r"""
(function () {
  'use strict';
  const PAT = 'pat.morgan@example.com', JORDAN = 'jordan.lee@example.com', ANA = 'ana.ruiz@example.com', KIM = 'kim.tran@example.com', SAM = 'sam.rivera@example.com';
  const st = DEMO.state;
  st.owner = PAT; st.user = PAT;
  Utilities.getUuid = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'id' + Date.now().toString(36) + Math.random().toString(36).slice(2);

  // "Developer setup", done in memory: teams, settings, the Sheet tabs and the BigQuery tables.
  TEAMS.push({ id: 'billing', name: 'Billing Support', managers: [PAT] });
  TEAMS.push({ id: 'payments', name: 'Payments', managers: [KIM] });
  QUERY_CONFIG.sheet.spreadsheetId = 'demo-sheet';
  QUERY_CONFIG.ivanti.baseUrl = 'https://ivanti.example';
  QUERY_CONFIG.bigQuery.projectId = 'demo-project';
  QUERY_CONFIG.bigQuery.appDataset = 'scheduler';
  QUERY_CONFIG.ivanti.employeeLookup.enabled = true;
  QUERY_CONFIG.sharedQueue.visibleFields = ['ticketId', 'createdAt', 'subject'];
  DEMO.props.set('IVANTI_API_KEY', 'demo-key');
  Object.keys(REQUIRED_SHEET_TABS).forEach((n) => { DEMO.sheets[n] = new DEMO.MockSheet(n, Object.keys(REQUIRED_SHEET_TABS[n].columns)); });
  const legacy = { BOOL: 'BOOLEAN', INT64: 'INTEGER', FLOAT64: 'FLOAT' };
  Object.keys(REQUIRED_SCHEMA).forEach((t) => { DEMO.bq.schemas[t] = REQUIRED_SCHEMA[t].columns.map((c) => ({ name: c[0], type: legacy[c[1]] || c[1], mode: c[2] })); });

  // Stand-in for the existing Ivanti lookup: knows everyone except Grace and addresses starting with "unknown".
  let nextId = 2000;
  const ivantiIds = {};
  lookupIvantiEmployee_ = function (email) {
    if (/^unknown|grace\.kim@/.test(email)) return { value: [] };
    ivantiIds[email] = ivantiIds[email] || 'IV-' + (nextId++);
    return { RecId: ivantiIds[email], PrimaryEmail: email };
  };

  // Sample teams, mailboxes, rules and this week's schedules.
  const today = Config.today();
  const addDays = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const monday = addDays(today, -((new Date(today + 'T12:00:00Z').getUTCDay() + 6) % 7));
  const days = [0, 1, 2, 3, 4].map((i) => addDays(monday, i));
  if (days.indexOf(today) === -1) days[4] = today; // weekend visit: make today a staffed day so runs assign
  const ids = {};
  const person = (tx, name, email) => {
    const r = IvantiLookup.resolve(email);
    return tx.insert('Employees', { display_name: name, employee_email: email, ivanti_owner_id: r.id || '', ivanti_lookup_status: r.status, ivanti_checked_at: new Date().toISOString() }).id;
  };
  Store.mutate({ user: PAT, teamId: 'billing' }, (tx) => {
    tx.insert('Admins', { email: JORDAN }); tx.insert('Admins', { email: SAM });
    ids.special = tx.insert('Mailboxes', { name: 'Billing - Special Handling', description: 'Billing tickets numbered 4000–5000', priority: 1 }).id;
    ids.refunds = tx.insert('Mailboxes', { name: 'Refunds', description: 'Card and ACH refunds', priority: 2 }).id;
    ids.general = tx.insert('Mailboxes', { name: 'General billing', description: 'Everything else in Billing and General', priority: 3 }).id;
    const ppl = [['Ana Ruiz', ANA], ['Ben Okafor', 'ben.okafor@example.com'], ['Chloe Martin', 'chloe.martin@example.com'], ['Dev Patel', 'dev.patel@example.com'],
      ['Erin Walsh', 'erin.walsh@example.com'], ['Felix Huang', 'felix.huang@example.com'], ['Grace Kim', 'grace.kim@example.com']];
    const [ana, ben, chloe, dev, erin, felix, grace] = ppl.map((p) => person(tx, p[0], p[1]));
    tx.insert('Rules', { mailbox_id: ids.special, conditions_json: [{ field: 'Category', op: 'equals', value: 'Billing' }, { field: 'IncidentNumber', op: 'between', value: [4000, 5000] }] });
    tx.insert('Rules', { mailbox_id: ids.refunds, conditions_json: [{ field: 'Subject', op: 'contains', value: 'refund' }] });
    tx.insert('Rules', { mailbox_id: ids.general, conditions_json: [{ field: 'Category', op: 'in', value: ['Billing', 'General'] }] });
    tx.insert('SubjectIgnoreList', { value: 'password reset' });
    const week = [
      { [ids.special]: [ana, ben, chloe], [ids.refunds]: [dev], [ids.general]: [erin, felix] },
      { [ids.special]: [ana, dev, erin], [ids.refunds]: [ben], [ids.general]: [chloe, grace] },
      { [ids.special]: [ben, chloe, felix], [ids.refunds]: [ana], [ids.general]: [dev, erin] },
      { [ids.special]: [ana, erin, felix], [ids.refunds]: [chloe, grace], [ids.general]: [ben, dev] },
      { [ids.special]: [ben, dev, chloe], [ids.refunds]: [erin], [ids.general]: [ana, felix, grace] },
    ];
    days.forEach((date, i) => Object.keys(week[i]).forEach((mb) => week[i][mb].forEach((emp) => tx.insert('Schedule', { date: date, mailbox_id: mb, employee_id: emp }))));
  });
  Store.mutate({ user: KIM, teamId: 'payments' }, (tx) => {
    ids.cards = tx.insert('Mailboxes', { name: 'Card disputes', description: 'Chargebacks and disputed card payments', priority: 1 }).id;
    ids.payTriage = tx.insert('Mailboxes', { name: 'Payments triage', description: 'Payment questions with no rule; Vertex will route here', priority: 2 }).id;
    const hugo = person(tx, 'Hugo Lane', 'hugo.lane@example.com'), iris = person(tx, 'Iris Chen', 'iris.chen@example.com');
    tx.insert('Rules', { mailbox_id: ids.cards, conditions_json: [{ field: 'Category', op: 'equals', value: 'Payments' }] });
    days.forEach((date, i) => { tx.insert('Schedule', { date: date, mailbox_id: ids.cards, employee_id: i % 2 ? iris : hugo }); tx.insert('Schedule', { date: date, mailbox_id: ids.payTriage, employee_id: i % 2 ? hugo : iris }); });
  });

  // Ivanti stand-in: each run's first page brings a fresh batch of believable tickets for both teams.
  let special = 4100, other = 6100, minute = 0;
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const states = ['Ohio', 'Texas', 'Oregon', 'Georgia', 'Utah'];
  function incident(n, category, subject) {
    minute++;
    return { RecId: 'REC-' + n, IncidentNumber: n, Subject: subject, Category: category, Subcategory: '', Status: 'Logged', Owner: null,
      Priority: '3', Source: 'Email', Symptom: subject + '. Customer wrote in asking for help.', CreatedDateTime: new Date(Date.now() - (200 - minute) * 60000).toISOString() };
  }
  function batch() {
    const out = [];
    for (let i = 0; i < 4; i++) {
      const n = special++;
      out.push(incident(n, 'Billing', pick(['Invoice ' + (88000 + n) + ' charged twice', 'Credit memo needed for account ' + (300 + n % 97),
        'Late fee dispute on invoice ' + (88000 + n), 'Tax exemption certificate for ' + pick(states) + ' store ' + (n % 90 + 10)])));
    }
    for (let i = 0; i < 2; i++) { const n = other++; out.push(incident(n, 'Billing', 'Refund not received for order ' + (51000 + n))); }
    for (let i = 0; i < 2; i++) {
      const n = other++;
      out.push(incident(n, pick(['General', 'Billing']), pick(['Update payment method on file for ' + pick(['ACME Corp', 'Northwind', 'Globex', 'Initech']),
        'Cannot download statement for period ' + (n % 12 + 1), 'Question about auto-pay schedule for account ' + (700 + n % 50)])));
    }
    for (let i = 0; i < 2; i++) { const n = other++; out.push(incident(n, 'Payments', pick(['Chargeback filed on order ', 'Card declined twice for order ']) + (61000 + n))); }
    const n = other++;
    out.push(incident(n, pick(['Hardware', 'Facilities']), pick(['Docking station not charging laptop', 'Badge reader at north entrance not working', 'Monitor flickering after update']) + ' (desk ' + (n % 40 + 1) + ')'));
    const earlier = DEMO.bq.tables.assignments.filter((a) => !a.dry_run && a.routing_method !== 'follow_up' && a.team_id === 'billing');
    if (earlier.length) { const e = pick(earlier); out.push(incident(other++, 'Billing', 'RE: ' + e.subject)); }
    return out;
  }
  const realFetch = UrlFetchApp.fetch;
  UrlFetchApp.fetch = function (url, opts) {
    if (/\$skip=0(&|$)/.test(url)) batch().forEach((x) => st.ivantiIncidents.push(x));
    return realFetch(url, opts);
  };

  // Earlier 6:00 AM runs for both teams, so logs, history and queues already have content.
  Pipeline.run({ teamId: 'billing', trigger: 'scheduled', triggeredBy: 'system', runSlot: today + ' 06:00' });
  Pipeline.run({ teamId: 'payments', trigger: 'scheduled', triggeredBy: 'system', runSlot: today + ' 06:00' });
  [...DEMO.props.keys()].filter((k) => k.indexOf('last_run_finished_at') === 0).forEach((k) => DEMO.props.delete(k));

  // google.script.run → call the server function directly (async, with a little latency, JSON round-trip like the real thing).
  function runner() {
    let ok = null, fail = null;
    const r = new Proxy({}, { get(_, name) {
      if (name === 'withSuccessHandler') return (f) => { ok = f; return r; };
      if (name === 'withFailureHandler') return (f) => { fail = f; return r; };
      return (arg) => setTimeout(() => {
        try { const res = window[name](arg); ok && ok(JSON.parse(JSON.stringify(res === undefined ? null : res))); }
        catch (e) { console.error(e); fail && fail(e); }
      }, 120 + Math.random() * 160);
    } });
    return r;
  }
  window.google = { script: { get run() { return runner(); } } };

  // Demo bar: switch person, simulate a colleague.
  const ROLES = { manager: PAT, admin: JORDAN, employee: ANA, other: KIM };
  const roleBtns = document.querySelectorAll('[data-role]');
  function setRole(key) {
    st.user = ROLES[key];
    roleBtns.forEach((b) => b.setAttribute('aria-pressed', b.dataset.role === key ? 'true' : 'false'));
    if (window.__demoBoot) window.__demoBoot();
  }
  roleBtns.forEach((b) => b.addEventListener('click', () => setRole(b.dataset.role)));
  roleBtns.forEach((b) => b.setAttribute('aria-pressed', b.dataset.role === 'manager' ? 'true' : 'false'));
  document.getElementById('colleague').addEventListener('click', () => {
    const emps = Store.read('Employees', { teamId: 'billing' }).filter((e) => e.active), mbs = Store.read('Mailboxes', { teamId: 'billing' }).filter((m) => m.active);
    const sched = Store.read('Schedule', { teamId: 'billing' });
    for (let tries = 0; tries < 50; tries++) {
      const date = days[Math.floor(Math.random() * days.length)], mb = pick(mbs), emp = pick(emps);
      if (sched.some((e) => e.date === date && e.mailbox_id === mb.id && e.employee_id === emp.id)) continue;
      Store.mutate({ user: SAM, teamId: 'billing' }, (tx) => tx.insert('Schedule', { date: date, mailbox_id: mb.id, employee_id: emp.id }));
      const note = document.getElementById('colleague-note');
      note.textContent = 'Sam (Billing admin) just added ' + emp.display_name + ' to ' + mb.name + '. Billing screens update within a few seconds.';
      setTimeout(() => { note.textContent = ''; }, 9000);
      return;
    }
  });
})();
"""

BAR_CSS = """
<style>
  .demo-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px; padding: 10px 20px; background: var(--post-deep); color: #fff; font-size: .9rem; }
  .demo-bar strong { font-weight: 600; }
  .demo-bar .seg { display: inline-flex; border: 1px solid rgba(255,255,255,.45); border-radius: 6px; overflow: hidden; }
  .demo-bar .seg button, .demo-bar .ghost { background: transparent; color: #fff; border: 0; padding: 6px 12px; cursor: pointer; font: inherit; min-height: 34px; }
  .demo-bar .seg button + button { border-left: 1px solid rgba(255,255,255,.45); }
  .demo-bar .seg button[aria-pressed="true"] { background: var(--tag); color: var(--ink); font-weight: 600; }
  .demo-bar .ghost { border: 1px solid rgba(255,255,255,.45); border-radius: 6px; }
  .demo-bar .ghost:hover, .demo-bar .seg button:hover:not([aria-pressed="true"]) { background: rgba(255,255,255,.12); }
  .demo-bar button:focus-visible { outline: 2px solid var(--tag); outline-offset: 2px; }
  .demo-bar .note { flex-basis: 100%; min-height: 0; color: var(--tag); }
  .demo-bar .note:empty { display: none; }
  .demo-bar .spacer { flex: 1; }
  .shell { min-height: calc(100vh - 54px); }
  @media (max-width: 860px) { .demo-bar .seg { flex-wrap: wrap; } }
</style>
"""
BAR_HTML = """
<div class="demo-bar" role="region" aria-label="Demo controls">
  <span><strong>Demo</strong> with sample data. Nothing is saved; reload to start over.</span>
  <span class="spacer"></span>
  <span>View as</span>
  <span class="seg" role="group" aria-label="View as">
    <button type="button" data-role="manager">Pat, Billing manager</button>
    <button type="button" data-role="admin">Jordan, Billing admin</button>
    <button type="button" data-role="employee">Ana, Billing employee</button>
    <button type="button" data-role="other">Kim, Payments manager</button>
  </span>
  <button type="button" class="ghost" id="colleague">Simulate a colleague's edit</button>
  <span class="note" id="colleague-note" aria-live="polite"></span>
</div>
"""

index = read('src', 'html', 'Index.html')
index = index.replace('<base target="_top">\n', '')
index = index.replace("<?!= include('html/Styles'); ?>", styles.strip() + BAR_CSS)
index = index.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n    <meta name="viewport" content="width=device-width, initial-scale=1">\n    <title>Mailbox rota demo</title>')
index = index.replace('<body>\n', '<body>\n' + BAR_HTML, 1)
scripts = ("<script>\nconst TZ = 'America/New_York';\n" + mocks +
           "\nconst DEMO = (function () { const m = createMocks(); const g = Object.assign({}, m.globals); delete g.console; Object.assign(window, g); return m; })();\n</script>\n"
           "<script>\n" + code + "\n</script>\n"
           "<script>\n" + DEMO_SETUP + "\n</script>\n"
           "<script>" + app_js + "</script>")
index = index.replace("<?!= include('html/App'); ?>", scripts)
assert '<?' not in index
os.makedirs(os.path.join(ROOT, 'dist'), exist_ok=True)
os.makedirs(os.path.join(ROOT, 'preview'), exist_ok=True)
with open(os.path.join(ROOT, 'preview', 'demo.html'), 'w', encoding='utf-8') as f:
    f.write(index)
print('Built preview/demo.html (%d KB)' % (len(index) // 1024))
