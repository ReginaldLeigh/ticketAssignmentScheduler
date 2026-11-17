/**
 * Ivanti.gs — Ivanti Neurons for ITSM REST client. Ivanti is the ONLY ticket source (D5).
 * Every URL, filter and field name comes from QUERY_CONFIG.ivanti (QueryConfig.gs).
 */
const Ivanti = {
  apiKey_() {
    const key = PropertiesService.getScriptProperties().getProperty('IVANTI_API_KEY');
    if (!key) throw new ConfigMissingError('Script Property IVANTI_API_KEY is not set.');
    return key;
  },

  headers_() {
    const cfg = QUERY_CONFIG.ivanti;
    const h = { Accept: 'application/json' };
    h[cfg.authHeaderName] = cfg.authHeaderTemplate.replace('{key}', Ivanti.apiKey_());
    return h;
  },

  baseUrl_() {
    const b = QUERY_CONFIG.ivanti.baseUrl;
    if (!b) throw new ConfigMissingError('QueryConfig.gs: ivanti.baseUrl is not set.');
    return b.replace(/\/+$/, '');
  },

  /** Fetch Incidents for an OData filter, following pages. Returns raw Ivanti records. */
  fetchIncidents_(filter, maxPages) {
    const cfg = QUERY_CONFIG.ivanti;
    const out = [];
    for (let page = 0; page < (maxPages || cfg.maxPagesPerRun); page++) {
      const qs = [
        '$filter=' + encodeURIComponent(filter),
        '$select=' + encodeURIComponent(cfg.selectFields.join(',')),
        '$top=' + cfg.pageSize,
        '$skip=' + (page * cfg.pageSize),
      ];
      if (cfg.orderBy) qs.push('$orderby=' + encodeURIComponent(cfg.orderBy));
      const url = Ivanti.baseUrl_() + cfg.incidentsPath + '?' + qs.join('&');
      const resp = UrlFetchApp.fetch(url, { method: 'get', headers: Ivanti.headers_(), muteHttpExceptions: true });
      const code = resp.getResponseCode();
      if (code < 200 || code >= 300) {
        throw new Error('Ivanti returned HTTP ' + code + ' when fetching Incidents: ' + String(resp.getContentText()).slice(0, 300));
      }
      const body = JSON.parse(resp.getContentText() || '{}');
      const items = body.value || [];
      items.forEach((x) => out.push(x));
      if (items.length < cfg.pageSize) break;
    }
    return out;
  },

  /** Turn a raw Ivanti record into the app's ticket shape. */
  toTicket(rec) {
    const m = QUERY_CONFIG.ivanti.fieldMap;
    const fields = {};
    QUERY_CONFIG.ivanti.selectFields.forEach((f) => { if (f in rec) fields[f] = rec[f]; });
    return {
      ticketId: String(rec[m.ticketId]),
      recId: String(rec[m.recId]),
      subject: rec[m.subject] ? String(rec[m.subject]) : '',
      description: rec[m.description] ? String(rec[m.description]) : '',
      category: rec[m.category] || '',
      subcategory: rec[m.subcategory] || '',
      createdAt: rec[m.createdAt] || '',
      fields: fields,
    };
  },

  /** New Incidents that are ready to be assigned. */
  fetchNewIncidents() {
    return Ivanti.fetchIncidents_(QUERY_CONFIG.ivanti.newIncidentsFilter).map(Ivanti.toTicket)
      .filter((t) => t.ticketId && t.ticketId !== 'undefined' && t.recId && t.recId !== 'undefined');
  },

  /**
   * Send updates in batches. items: [{ recId, body }]. Returns [{ ok, status, error }] in order.
   */
  updateRecords(items) {
    const cfg = QUERY_CONFIG.ivanti;
    const results = [];
    for (let i = 0; i < items.length; i += cfg.writebackBatchSize) {
      const chunk = items.slice(i, i + cfg.writebackBatchSize);
      const reqs = chunk.map((it) => ({
        url: Ivanti.baseUrl_() + cfg.updatePath.replace('{RecId}', encodeURIComponent(it.recId)),
        method: cfg.updateMethod,
        headers: Ivanti.headers_(),
        contentType: 'application/json',
        payload: JSON.stringify(it.body),
        muteHttpExceptions: true,
      }));
      let resps;
      try { resps = UrlFetchApp.fetchAll(reqs); } catch (e) {
        chunk.forEach(() => results.push({ ok: false, status: 0, error: String(e.message || e).slice(0, 500) }));
        continue;
      }
      resps.forEach((r) => {
        const code = r.getResponseCode();
        const ok = code >= 200 && code < 300;
        results.push({ ok: ok, status: code, error: ok ? null : ('HTTP ' + code + ': ' + String(r.getContentText()).slice(0, 400)) });
      });
    }
    return results;
  },
};

/* ───────────────────────── Employee lookup by email (change request §4) ───────────────────────── */

/**
 * TODO(Ivanti-lookup): paste the existing function here, or call it from here.
 * Admins never see or type Ivanti IDs: the app uses this to find each employee's ID from their email.
 *
 * @param {string} email  employee email (lower-case)
 * @return {Object|string|null} the Ivanti API's JSON for that employee (an object or a JSON string),
 *         or null if Ivanti has no employee with that email. Throw if Ivanti can't be reached.
 *
 * Then, in QueryConfig.gs: set ivanti.employeeLookup.idPath to where the ID sits in that JSON
 * (e.g. 'RecId' or 'value.0.RecId') and set ivanti.employeeLookup.enabled = true.
 */
function lookupIvantiEmployee_(email) { // eslint-disable-line no-unused-vars
  return null;
}

const IvantiLookup = {
  /**
   * Find an employee's Ivanti ID. Never throws.
   * @return {{status:'found'|'not_found'|'error', id:(string|null), error:(string|null)}}
   */
  resolve(email) {
    const cfg = QUERY_CONFIG.ivanti.employeeLookup || {};
    if (!cfg.enabled) return { status: 'error', id: null, error: 'Ivanti employee lookup is not set up yet (developer setting).' };
    let raw;
    try { raw = lookupIvantiEmployee_(String(email || '').toLowerCase()); } catch (e) {
      return { status: 'error', id: null, error: 'Ivanti could not be reached: ' + String((e && e.message) || e).slice(0, 200) };
    }
    if (raw === null || raw === undefined || raw === '') return { status: 'not_found', id: null, error: null };
    let obj = raw;
    if (typeof raw === 'string') {
      try { obj = JSON.parse(raw); } catch (e) { return { status: 'error', id: null, error: 'The lookup returned text that is not JSON.' }; }
    }
    const id = IvantiLookup.pick_(obj, cfg.idPath || 'RecId');
    if (id === null || id === undefined || String(id).trim() === '') return { status: 'not_found', id: null, error: null };
    return { status: 'found', id: String(id), error: null };
  },

  /** Read a dot path such as 'value.0.RecId' from an object. */
  pick_(obj, path) {
    return String(path).split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
  },
};
