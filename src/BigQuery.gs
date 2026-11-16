/**
 * BigQuery.gs — THE ONLY file allowed to call the BigQuery service.
 *
 * NO TABLE CREATION (D23). This client:
 *   1. accepts only SELECT, WITH…SELECT, INSERT and MERGE statements, and rejects every
 *      statement containing DDL or scripting keywords (checked after removing comments,
 *      string literals and quoted identifiers);
 *   2. rejects multi-statement scripts;
 *   3. builds every request itself, using jobs.query with an allow-listed set of request
 *      fields, so there is no way to name a destination table that BigQuery could create;
 *   4. calls only three service methods: Jobs.query, Jobs.getQueryResults (read results) and
 *      Tables.get (read table metadata for SchemaCheck.gs).
 * Anything else throws TableCreationForbiddenError. tests/noTableCreation.test.js enforces this.
 */

const BQ_ALLOWED_FIRST_KEYWORDS = ['SELECT', 'WITH', 'INSERT', 'MERGE'];
const BQ_FORBIDDEN_KEYWORDS =
  /\b(CREATE|ALTER|DROP|UNDROP|TRUNCATE|RENAME|GRANT|REVOKE|EXPORT|LOAD|CALL|DECLARE|BEGIN|EXECUTE|COMMIT|ROLLBACK|CLONE|ASSERT)\b/i;
const BQ_ALLOWED_REQUEST_KEYS = ['query', 'useLegacySql', 'parameterMode', 'queryParameters', 'timeoutMs', 'location'];
const BQ_RETRYABLE = /(concurrent update|could not serialize|rateLimitExceeded|backendError|internalError|exceeded rate limits|try again|service unavailable|\b50[0-9]\b)/i;

const BQ = {
  /** Resolve a configured table name ('t', 'dataset.t' or 'project.dataset.t') to its parts. */
  ref(configured) {
    const cfg = QUERY_CONFIG.bigQuery;
    if (!configured) throw new ConfigMissingError('A BigQuery table name is not configured in QueryConfig.gs.');
    const parts = String(configured).split('.');
    let projectId = cfg.projectId, datasetId = cfg.appDataset, tableId;
    if (parts.length === 1) tableId = parts[0];
    else if (parts.length === 2) { datasetId = parts[0]; tableId = parts[1]; }
    else if (parts.length === 3) { projectId = parts[0]; datasetId = parts[1]; tableId = parts[2]; }
    else throw new ConfigMissingError('Invalid table name: ' + configured);
    if (!projectId || !datasetId) {
      throw new ConfigMissingError('QueryConfig.gs: bigQuery.projectId and bigQuery.appDataset must be set.');
    }
    const ok = (s, re) => re.test(s);
    if (!ok(projectId, /^[A-Za-z0-9_\-:.]+$/) || !ok(datasetId, /^[A-Za-z0-9_]+$/) || !ok(tableId, /^[A-Za-z0-9_\-]+$/)) {
      throw new ConfigMissingError('Invalid characters in BigQuery table name: ' + configured);
    }
    return { projectId, datasetId, tableId, sql: '`' + projectId + '.' + datasetId + '.' + tableId + '`' };
  },

  /** Throws TableCreationForbiddenError unless the statement is a single SELECT/INSERT/MERGE. */
  assertSafeSql(sql) {
    const stripped = BQ.stripForCheck_(String(sql || '')).trim().replace(/;\s*$/, '');
    if (!stripped) throw new TableCreationForbiddenError('Empty SQL statement.');
    if (stripped.indexOf(';') !== -1) {
      throw new TableCreationForbiddenError('Multi-statement SQL is not allowed (D23).', { sql: String(sql).slice(0, 500) });
    }
    const first = (stripped.replace(/^[\s(]+/, '').match(/^([A-Za-z]+)/) || [])[1];
    if (!first || BQ_ALLOWED_FIRST_KEYWORDS.indexOf(first.toUpperCase()) === -1) {
      throw new TableCreationForbiddenError('Only SELECT, INSERT and MERGE statements are allowed (D23). Got: ' + first,
        { sql: String(sql).slice(0, 500) });
    }
    const bad = stripped.match(BQ_FORBIDDEN_KEYWORDS);
    if (bad) {
      throw new TableCreationForbiddenError('Forbidden SQL keyword "' + bad[1].toUpperCase() +
        '". The app never creates or alters tables; a developer must do it (D23).', { sql: String(sql).slice(0, 500) });
    }
  },

  /** Removes comments, string literals and backtick identifiers so keywords inside them are ignored. */
  stripForCheck_(sql) {
    let out = '';
    let i = 0;
    const n = sql.length;
    while (i < n) {
      const c = sql[i], c2 = sql.substr(i, 2);
      if (c2 === '--' || c === '#') { while (i < n && sql[i] !== '\n') i++; out += ' '; continue; }
      if (c2 === '/*') { const e = sql.indexOf('*/', i + 2); i = e === -1 ? n : e + 2; out += ' '; continue; }
      // Optional r / b / rb / br prefix directly before a quote (e.g. r'[^a-z]+').
      let j = i;
      if (/[rRbB]/.test(c) && (i === 0 || !/[A-Za-z0-9_]/.test(sql[i - 1]))) {
        j = i + 1;
        if (j < n && /[rRbB]/.test(sql[j]) && sql[j].toLowerCase() !== c.toLowerCase()) j++;
        if (sql[j] !== "'" && sql[j] !== '"') j = i;
      }
      const q = sql[j];
      if (q === "'" || q === '"') {
        const raw = /[rR]/.test(sql.substring(i, j));
        const triple = sql.substr(j, 3) === q + q + q;
        let k = j + (triple ? 3 : 1);
        while (k < n) {
          if (!raw && sql[k] === '\\') { k += 2; continue; }
          if (triple ? sql.substr(k, 3) === q + q + q : sql[k] === q) { k += triple ? 3 : 1; break; }
          k++;
        }
        i = k; out += " '' "; continue;
      }
      if (c === '`') { const e = sql.indexOf('`', i + 1); i = e === -1 ? n : e + 1; out += ' _id_ '; continue; }
      out += c; i++;
    }
    return out;
  },

  /**
   * Run one statement. params: array built with BQ.p.* helpers.
   * Returns { rows: [object], numDmlAffectedRows: number }.
   */
  query(sql, params, options) {
    BQ.assertSafeSql(sql);
    const cfg = QUERY_CONFIG.bigQuery;
    if (!cfg.projectId) throw new ConfigMissingError('QueryConfig.gs: bigQuery.projectId is not set.');
    const request = {
      query: sql,
      useLegacySql: false,
      parameterMode: 'NAMED',
      queryParameters: params || [],
      timeoutMs: (options && options.timeoutMs) || 60000,
    };
    if (cfg.location) request.location = cfg.location;
    BQ.assertSafeRequest_(request);

    let res = BQ.withRetry_(() => BigQuery.Jobs.query(request, cfg.projectId));
    const jobId = res.jobReference && res.jobReference.jobId;
    const loc = (res.jobReference && res.jobReference.location) || cfg.location;
    let guard = 0;
    while (!res.jobComplete) {
      if (++guard > 60) throw new Error('BigQuery query did not complete in time.');
      res = BQ.withRetry_(() => BigQuery.Jobs.getQueryResults(cfg.projectId, jobId, { location: loc, timeoutMs: 10000 }));
    }
    let rows = BQ.toObjects_(res.schema, res.rows);
    let pageToken = res.pageToken;
    while (pageToken) {
      const page = BQ.withRetry_(() => BigQuery.Jobs.getQueryResults(cfg.projectId, jobId, { location: loc, pageToken: pageToken }));
      rows = rows.concat(BQ.toObjects_(page.schema || res.schema, page.rows));
      pageToken = page.pageToken;
    }
    return { rows: rows, numDmlAffectedRows: Number(res.numDmlAffectedRows || 0) };
  },

  /** Read a table's column list (metadata only). Returns null if the table does not exist. */
  getTableFields(ref) {
    try {
      const t = BigQuery.Tables.get(ref.projectId, ref.datasetId, ref.tableId);
      return (t && t.schema && t.schema.fields) || [];
    } catch (e) {
      if (/not\s*found|404/i.test(String(e && e.message))) return null;
      throw e;
    }
  },

  assertSafeRequest_(request) {
    Object.keys(request).forEach((k) => {
      if (BQ_ALLOWED_REQUEST_KEYS.indexOf(k) === -1) {
        throw new TableCreationForbiddenError('BigQuery request field "' + k + '" is not allowed (D23).');
      }
    });
  },

  withRetry_(fn) {
    let lastErr;
    for (let attempt = 0; attempt < 5; attempt++) {
      try { return fn(); } catch (e) {
        lastErr = e;
        if (!BQ_RETRYABLE.test(String(e && e.message))) throw e;
        Utilities.sleep(Math.min(8000, 1000 * Math.pow(2, attempt)) + Math.floor(Math.random() * 500));
      }
    }
    throw lastErr;
  },

  toObjects_(schema, rows) {
    if (!rows || !schema || !schema.fields) return [];
    const fields = schema.fields;
    return rows.map((r) => {
      const o = {};
      fields.forEach((f, idx) => {
        const cell = r.f[idx];
        let v = cell ? cell.v : null;
        if (v !== null && v !== undefined) {
          const t = String(f.type).toUpperCase();
          if (t === 'INTEGER' || t === 'INT64' || t === 'FLOAT' || t === 'FLOAT64' || t === 'NUMERIC') v = Number(v);
          else if (t === 'BOOLEAN' || t === 'BOOL') v = (v === true || v === 'true');
        } else v = null;
        o[f.name] = v;
      });
      return o;
    });
  },

  /** Query-parameter builders (named parameters). */
  p: {
    scalar_(name, type, value) {
      return { name: name, parameterType: { type: type },
        parameterValue: (value === null || value === undefined) ? {} : { value: String(value) } };
    },
    string(name, v) { return BQ.p.scalar_(name, 'STRING', v); },
    int64(name, v) { return BQ.p.scalar_(name, 'INT64', v === null || v === undefined ? v : Math.round(Number(v))); },
    float64(name, v) { return BQ.p.scalar_(name, 'FLOAT64', v); },
    bool(name, v) { return BQ.p.scalar_(name, 'BOOL', v === null || v === undefined ? v : (v ? 'true' : 'false')); },
    date(name, v) { return BQ.p.scalar_(name, 'DATE', v); },
    stringArray(name, arr) {
      return { name: name, parameterType: { type: 'ARRAY', arrayType: { type: 'STRING' } },
        parameterValue: { arrayValues: (arr || []).map((v) => ({ value: String(v) })) } };
    },
    /** fields: [[fieldName, 'STRING'|'INT64'|'FLOAT64'|'BOOL'], ...] */
    structArray(name, fields, rows) {
      return {
        name: name,
        parameterType: { type: 'ARRAY', arrayType: { type: 'STRUCT',
          structTypes: fields.map((f) => ({ name: f[0], type: { type: f[1] } })) } },
        parameterValue: { arrayValues: (rows || []).map((r) => {
          const sv = {};
          fields.forEach((f) => {
            let v = r[f[0]];
            if (v === null || v === undefined) { sv[f[0]] = {}; return; }
            if (f[1] === 'BOOL') v = v ? 'true' : 'false';
            if (f[1] === 'INT64') v = Math.round(Number(v));
            sv[f[0]] = { value: String(v) };
          });
          return { structValues: sv };
        }) },
      };
    },
  },
};
