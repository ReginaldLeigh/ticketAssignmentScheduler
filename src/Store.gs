/**
 * Store.gs — THE ONLY file allowed to touch the Google Sheet.
 *
 * Simultaneous use (D22):
 *   • every write runs inside Store.mutate(), which holds the script lock for well under a second,
 *     reads the data fresh, validates, writes, appends an AuditLog row and bumps revision numbers;
 *   • records are found by permanent id, never by row number, and deletes are soft, so rows never
 *     shift under another user's save;
 *   • every editable record carries a version; a save made from an old version is rejected with
 *     ConflictError instead of silently overwriting (the browser shows who changed it);
 *   • a browser-generated requestId makes double-clicks and automatic retries run only once;
 *   • all changes in one mutate() are held in memory and written together at the end, so a
 *     validation error part-way through writes nothing.
 *
 * No table creation (D23): Store only opens the configured spreadsheet and reads/writes rows on
 * tabs that a developer has already created. It never adds, removes or renames tabs or columns.
 */

const STORE_LOCK_WAIT_MS = 10000;
const STORE_REQUEST_TTL_S = 600;
const STORE_MAX_CELL = 45000;

const Store = {
  ss_: null,

  /** Run fn while holding the script lock (short critical sections only). */
  withLock(fn) {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(STORE_LOCK_WAIT_MS)) {
      throw new BusyError('The app is busy saving other changes. Please try again.');
    }
    try { return fn(); } finally { lock.releaseLock(); }
  },

  spreadsheet_() {
    const id = QUERY_CONFIG.sheet.spreadsheetId;
    if (!id) throw new ConfigMissingError('QueryConfig.gs: sheet.spreadsheetId is not set.');
    if (!Store.ss_) Store.ss_ = SpreadsheetApp.openById(id);
    return Store.ss_;
  },

  tz_() { return Session.getScriptTimeZone() || 'America/New_York'; },

  sheetOrNull_(name) { return Store.spreadsheet_().getSheetByName(name); },

  tab_(name) {
    if (!REQUIRED_SHEET_TABS[name]) throw new Error('Unknown tab: ' + name);
    const sh = Store.sheetOrNull_(name);
    if (!sh) {
      throw new SchemaMissingError('Google Sheet tab "' + name + '" is missing. A developer must add it (see docs/SCHEMA.md).', { tab: name });
    }
    return sh;
  },

  /** Header row of a tab, or null if the tab does not exist. Read-only (used by SchemaCheck). */
  headers(name) {
    const sh = Store.sheetOrNull_(name);
    if (!sh) return null;
    const lastCol = sh.getLastColumn();
    if (!lastCol) return [];
    return sh.getRange(1, 1, 1, lastCol).getValues()[0].map((h) => String(h).trim());
  },

  /** Load a whole tab: headers, raw values and typed records (each with its sheet row number). */
  load_(name) {
    const spec = REQUIRED_SHEET_TABS[name];
    const sheet = Store.tab_(name);
    const values = sheet.getDataRange().getValues();
    const headers = (values[0] || []).map((h) => String(h).trim());
    const colIndex = {};
    headers.forEach((h, i) => { if (h && !(h in colIndex)) colIndex[h] = i; });
    const missing = Object.keys(spec.columns).filter((c) => !(c in colIndex));
    if (missing.length) {
      throw new SchemaMissingError('Google Sheet tab "' + name + '" is missing column(s): ' + missing.join(', ') +
        '. A developer must add them (see docs/SCHEMA.md).', { tab: name, missing: missing });
    }
    const records = [];
    for (let r = 1; r < values.length; r++) {
      const row = values[r];
      if (row.every((v) => v === '' || v === null)) continue;
      const rec = { _row: r + 1 };
      Object.keys(spec.columns).forEach((c) => { rec[c] = Store.fromCell_(spec.columns[c], row[colIndex[c]]); });
      records.push(rec);
    }
    return { name: name, spec: spec, sheet: sheet, headers: headers, colIndex: colIndex, raw: values, records: records };
  },

  isDeleted_(spec, rec) {
    return spec.softDelete === 'deleted_at' && !!rec.deleted_at;
  },

  clean_(rec) {
    if (!rec) return rec;
    const o = {};
    Object.keys(rec).forEach((k) => { if (k.charAt(0) !== '_') o[k] = rec[k]; });
    return o;
  },

  fromCell_(type, v) {
    const isDate = v instanceof Date || Object.prototype.toString.call(v) === '[object Date]';
    switch (type) {
      case 'number': return (v === '' || v === null || v === undefined) ? null : Number(v);
      case 'bool': return v === true || String(v).toUpperCase() === 'TRUE';
      case 'date':
        if (isDate) return Utilities.formatDate(v, Store.tz_(), 'yyyy-MM-dd');
        return v ? String(v).trim().slice(0, 10) : null;
      case 'datetime':
        if (isDate) return v.toISOString();
        return v ? String(v) : null;
      case 'json':
        if (v === '' || v === null || v === undefined) return null;
        try { return JSON.parse(String(v)); } catch (e) { return null; }
      default:
        if (v === null || v === undefined) return '';
        if (isDate) return v.toISOString();
        return String(v);
    }
  },

  toCell_(type, v) {
    switch (type) {
      case 'number': return (v === null || v === undefined || v === '') ? '' : Number(v);
      case 'bool': return !!v;
      case 'json': return v === null || v === undefined ? '' : Store.safeText_(JSON.stringify(v));
      case 'date': case 'datetime': return v ? String(v) : '';
      default: return v === null || v === undefined ? '' : Store.safeText_(String(v));
    }
  },

  /** Stops user text from being treated as a formula, and keeps cells under Sheets' size limit. */
  safeText_(s) {
    let out = s.length > STORE_MAX_CELL ? s.slice(0, STORE_MAX_CELL) + '…' : s;
    if (/^[=+\-@]/.test(out)) out = "'" + out;
    return out;
  },

  toRow_(t, rec, existing) {
    const width = Math.max(t.headers.length, 1);
    const arr = existing ? existing.slice(0, width) : new Array(width).fill('');
    while (arr.length < width) arr.push('');
    Object.keys(t.spec.columns).forEach((c) => { arr[t.colIndex[c]] = Store.toCell_(t.spec.columns[c], rec[c]); });
    return arr;
  },

  /* ─────────────────────────────── Public read API ─────────────────────────────── */

  /** Records of a tab (soft-deleted schedule rows excluded unless includeDeleted). No lock. */
  read(name, opts) {
    const t = Store.load_(name);
    return t.records.filter((r) => (opts && opts.includeDeleted) || !Store.isDeleted_(t.spec, r)).map(Store.clean_);
  },

  /** Consistent read of several tabs at once (taken under the lock so no save is half-visible). */
  snapshot(names) {
    return Store.withLock(() => {
      const out = {};
      names.forEach((n) => { out[n] = Store.read(n); });
      out._revisions = Store.getRevisions();
      return out;
    });
  },

  /* ─────────────────────────────── Public write API ─────────────────────────────── */

  /**
   * Run fn(tx) as one locked, all-or-nothing change set.
   * ctx: { user, requestId }. If requestId was already processed, its saved result is returned.
   */
  mutate(ctx, fn) {
    ctx = ctx || {};
    return Store.withLock(() => {
      const cache = CacheService.getScriptCache();
      if (ctx.requestId) {
        const prior = cache.get('req:' + ctx.requestId);
        if (prior) return JSON.parse(prior);
      }
      const tx = new StoreTx_(ctx);
      const result = fn(tx);
      tx.commit_();
      if (ctx.requestId) {
        try {
          const s = JSON.stringify(result === undefined ? null : result);
          if (s.length < 90000) cache.put('req:' + ctx.requestId, s, STORE_REQUEST_TTL_S);
        } catch (e) { /* result not cacheable; ignore */ }
      }
      return result;
    });
  },

  /* ─────────────────────────────── Revisions & audit ─────────────────────────────── */

  getRevisions() {
    const props = PropertiesService.getScriptProperties().getProperties();
    const out = {};
    Object.keys(REQUIRED_SHEET_TABS).forEach((tab) => { out[tab] = Number(props['rev:' + tab] || 0); });
    return out;
  },

  bumpRevisions_(tabs) {
    const props = PropertiesService.getScriptProperties();
    tabs.forEach((tab) => {
      const cur = Number(props.getProperty('rev:' + tab) || 0);
      props.setProperty('rev:' + tab, String(cur + 1));
    });
  },

  /** Bump every revision (after an emergency manual edit of the Sheet) so all open pages reload. */
  bumpAllRevisions() {
    Store.withLock(() => Store.bumpRevisions_(Object.keys(REQUIRED_SHEET_TABS)));
  },

  /** Append rows to AuditLog without loading the whole tab. Called inside the lock. */
  appendAudit_(entries) {
    if (!entries.length) return;
    const sheet = Store.tab_('AuditLog');
    const headers = Store.headers('AuditLog');
    const spec = REQUIRED_SHEET_TABS.AuditLog;
    const colIndex = {};
    headers.forEach((h, i) => { if (h && !(h in colIndex)) colIndex[h] = i; });
    const missing = Object.keys(spec.columns).filter((c) => !(c in colIndex));
    if (missing.length) {
      throw new SchemaMissingError('Google Sheet tab "AuditLog" is missing column(s): ' + missing.join(', '), { tab: 'AuditLog', missing: missing });
    }
    const t = { headers: headers, colIndex: colIndex, spec: spec };
    const rows = entries.map((e) => Store.toRow_(t, e, null));
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  },

  /** Most recent audit entries (newest first). */
  readAuditTail(limit) {
    const sheet = Store.tab_('AuditLog');
    const last = sheet.getLastRow();
    if (last < 2) return [];
    const n = Math.min(limit || 50, last - 1);
    const headers = Store.headers('AuditLog');
    const values = sheet.getRange(last - n + 1, 1, n, headers.length).getValues();
    const spec = REQUIRED_SHEET_TABS.AuditLog;
    return values.map((row) => {
      const o = {};
      headers.forEach((h, i) => { if (spec.columns[h]) o[h] = Store.fromCell_(spec.columns[h], row[i]); });
      return o;
    }).reverse();
  },
};

/** One all-or-nothing change set. Created only by Store.mutate(). */
class StoreTx_ {
  constructor(ctx) {
    this.ctx = ctx || {};
    this.tabs = {};
    this.dirty = {};
    this.appends = {};
    this.audits = [];
    this.touched = {};
    this.now = new Date().toISOString();
  }

  t_(name) {
    if (name === 'AuditLog') throw new Error('AuditLog is append-only and written automatically.');
    if (!this.tabs[name]) this.tabs[name] = Store.load_(name);
    return this.tabs[name];
  }

  /** Current rows (fresh, read inside the lock), including changes made earlier in this tx. */
  rows(name, opts) {
    const t = this.t_(name);
    return t.records.filter((r) => (opts && opts.includeDeleted) || !Store.isDeleted_(t.spec, r)).map(Store.clean_);
  }

  findRaw_(name, id) {
    const t = this.t_(name);
    return t.records.find((r) => String(r[t.spec.idField]) === String(id)) || null;
  }

  find(name, id) { return Store.clean_(this.findRaw_(name, id)); }

  insert(name, data) {
    const t = this.t_(name);
    const spec = t.spec;
    const rec = {};
    Object.keys(spec.columns).forEach((c) => { rec[c] = data[c] !== undefined ? data[c] : null; });
    if (spec.idField === 'id' && !rec.id) rec.id = Utilities.getUuid();
    if (spec.idField && this.findRaw_(name, rec[spec.idField])) {
      throw new ConflictError('A record with this id already exists.', { id: rec[spec.idField] });
    }
    if ('version' in spec.columns) rec.version = 1;
    if ('updated_by' in spec.columns) rec.updated_by = this.ctx.user || 'system';
    if ('updated_at' in spec.columns) rec.updated_at = this.now;
    if (spec.softDelete === 'active' && (rec.active === null || rec.active === undefined)) rec.active = true;
    rec._new = true;
    t.records.push(rec);
    (this.appends[name] = this.appends[name] || []).push(rec);
    this.touched[name] = true;
    this.audit_(name, rec[spec.idField], 'insert', null, Store.clean_(rec));
    return Store.clean_(rec);
  }

  update(name, id, changes, expectedVersion, action) {
    const t = this.t_(name);
    const rec = this.findRaw_(name, id);
    if (!rec) throw new NotFoundError('This item no longer exists (someone may have removed it).', { tab: name, id: id });
    if (expectedVersion !== undefined && expectedVersion !== null && Number(rec.version) !== Number(expectedVersion)) {
      throw new ConflictError((rec.updated_by || 'Someone') + ' changed this at ' + (rec.updated_at || 'an earlier time') + '.',
        { current: Store.clean_(rec), updatedBy: rec.updated_by, updatedAt: rec.updated_at });
    }
    const before = Store.clean_(rec);
    Object.keys(changes || {}).forEach((k) => {
      if (k in t.spec.columns && k !== t.spec.idField && k !== 'version' && k !== 'updated_by' && k !== 'updated_at') rec[k] = changes[k];
    });
    if ('version' in t.spec.columns) rec.version = Number(rec.version || 0) + 1;
    if ('updated_by' in t.spec.columns) rec.updated_by = this.ctx.user || 'system';
    if ('updated_at' in t.spec.columns) rec.updated_at = this.now;
    if (!rec._new) {
      this.dirty[name] = this.dirty[name] || [];
      if (this.dirty[name].indexOf(rec) === -1) this.dirty[name].push(rec);
    }
    this.touched[name] = true;
    this.audit_(name, id, action || 'update', before, Store.clean_(rec));
    return Store.clean_(rec);
  }

  /** Soft delete: active=false, or deleted_at=now. Rows are never physically removed. */
  remove(name, id, expectedVersion) {
    const spec = this.t_(name).spec;
    if (spec.softDelete === 'active') return this.update(name, id, { active: false }, expectedVersion, 'remove');
    if (spec.softDelete === 'deleted_at') return this.update(name, id, { deleted_at: this.now }, expectedVersion, 'remove');
    throw new ValidationError('Items in ' + name + ' cannot be removed.');
  }

  audit_(entity, entityId, action, before, after) {
    this.audits.push({
      at: this.now, user: this.ctx.user || 'system', entity: entity, entity_id: entityId === null ? '' : String(entityId),
      action: action, before_json: before ? JSON.stringify(before) : '', after_json: after ? JSON.stringify(after) : '',
      request_id: this.ctx.requestId || '',
    });
  }

  commit_() {
    Object.keys(this.dirty).forEach((name) => {
      const t = this.tabs[name];
      this.dirty[name].forEach((rec) => {
        const arr = Store.toRow_(t, rec, t.raw[rec._row - 1]);
        t.sheet.getRange(rec._row, 1, 1, arr.length).setValues([arr]);
      });
    });
    Object.keys(this.appends).forEach((name) => {
      const t = this.tabs[name];
      const rows = this.appends[name].map((rec) => Store.toRow_(t, rec, null));
      if (rows.length) t.sheet.getRange(t.raw.length + 1, 1, rows.length, rows[0].length).setValues(rows);
    });
    Store.appendAudit_(this.audits);
    const touched = Object.keys(this.touched);
    if (touched.length) Store.bumpRevisions_(touched.concat(this.audits.length ? ['AuditLog'] : []));
    SpreadsheetApp.flush();
  }
}
