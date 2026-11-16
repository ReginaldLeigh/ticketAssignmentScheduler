/**
 * SchemaCheck.gs — READ-ONLY check that every developer-created table and Sheet tab exists with
 * the expected columns (D23). It only reads metadata and header rows. It never creates or fixes
 * anything: it reports what a developer still needs to do.
 */
const BQ_TYPE_ALIASES = { BOOLEAN: 'BOOL', INTEGER: 'INT64', FLOAT: 'FLOAT64' };

const SchemaCheck = {
  /** Sheet tabs only (enough for the schedule/admin pages). */
  checkSheets() {
    const problems = [];
    if (!QUERY_CONFIG.sheet.spreadsheetId) return ['QueryConfig.gs: sheet.spreadsheetId is not set.'];
    let ssOk = true;
    try { Store.spreadsheet_(); } catch (e) { ssOk = false; problems.push('The spreadsheet could not be opened: ' + e.message); }
    if (!ssOk) return problems;
    Object.keys(REQUIRED_SHEET_TABS).forEach((tab) => {
      const headers = Store.headers(tab);
      if (headers === null) { problems.push('Sheet tab "' + tab + '" does not exist. A developer must add it.'); return; }
      const missing = Object.keys(REQUIRED_SHEET_TABS[tab].columns).filter((c) => headers.indexOf(c) === -1);
      if (missing.length) problems.push('Sheet tab "' + tab + '" is missing header(s): ' + missing.join(', ') + '.');
    });
    return problems;
  },

  /** BigQuery tables P1–P3 (+ a separately configured ticket-history table). */
  checkBigQuery() {
    const problems = [];
    const bq = QUERY_CONFIG.bigQuery;
    if (!bq.projectId || !bq.appDataset) return ['QueryConfig.gs: bigQuery.projectId and bigQuery.appDataset must be set.'];
    Object.keys(REQUIRED_SCHEMA).forEach((key) => {
      const spec = REQUIRED_SCHEMA[key];
      let ref;
      try { ref = BQ.ref(bq[spec.configKey]); } catch (e) { problems.push(e.message); return; }
      let fields;
      try { fields = BQ.getTableFields(ref); } catch (e) { problems.push('Could not read table ' + ref.sql + ': ' + e.message); return; }
      if (fields === null) {
        problems.push('BigQuery table ' + ref.sql + ' (' + key + ') does not exist. A developer must create it from docs/SCHEMA.md.');
        return;
      }
      SchemaCheck.compare_(key, ref, fields, spec.columns).forEach((p) => problems.push(p));
    });
    const hist = bq.ticketHistory;
    if (hist && hist.table) {
      let ref;
      try { ref = BQ.ref(hist.table); } catch (e) { problems.push(e.message); return problems; }
      const fields = BQ.getTableFields(ref);
      if (fields === null) problems.push('Ticket history table ' + ref.sql + ' does not exist.');
      else {
        const names = fields.map((f) => f.name);
        ['ticketId', 'subject', 'owner', 'recordedAt'].concat(hist.columns.mailbox ? ['mailbox'] : []).forEach((k) => {
          const col = hist.columns[k];
          if (names.indexOf(col) === -1) problems.push('Ticket history table ' + ref.sql + ' has no column "' + col + '" (' + k + ').');
        });
      }
    }
    return problems;
  },

  compare_(key, ref, fields, expected) {
    const problems = [];
    const byName = {};
    fields.forEach((f) => { byName[f.name] = f; });
    expected.forEach((col) => {
      const name = col[0], type = col[1], mode = col[2];
      const f = byName[name];
      if (!f) { problems.push('Table ' + ref.sql + ' is missing column ' + name + ' ' + type + ' ' + mode + '.'); return; }
      const actualType = BQ_TYPE_ALIASES[String(f.type).toUpperCase()] || String(f.type).toUpperCase();
      if (actualType !== type) problems.push('Table ' + ref.sql + ' column ' + name + ' should be ' + type + ' (found ' + actualType + ').');
      const actualMode = String(f.mode || 'NULLABLE').toUpperCase();
      if (mode === 'NULLABLE' && actualMode === 'REQUIRED') {
        problems.push('Table ' + ref.sql + ' column ' + name + ' must be NULLABLE (it is REQUIRED).');
      }
      if (actualMode === 'REPEATED') problems.push('Table ' + ref.sql + ' column ' + name + ' must not be REPEATED.');
    });
    return problems;
  },

  /** Everything: developer settings + Sheet tabs + BigQuery tables. */
  checkAll() {
    const config = Config.check();
    const sheets = SchemaCheck.checkSheets();
    let bigQuery = [];
    try { bigQuery = SchemaCheck.checkBigQuery(); } catch (e) { bigQuery = ['BigQuery check failed: ' + e.message]; }
    const result = { ok: !config.length && !sheets.length && !bigQuery.length, config: config, sheets: sheets, bigQuery: bigQuery,
      checkedAt: new Date().toISOString() };
    PropertiesService.getScriptProperties().setProperty('last_check', JSON.stringify(result).slice(0, 8000));
    return result;
  },

  last() {
    const raw = PropertiesService.getScriptProperties().getProperty('last_check');
    try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  },
};
