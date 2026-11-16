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
