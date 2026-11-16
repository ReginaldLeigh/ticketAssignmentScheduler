/**
 * QueryConfig.gs — THE developer configuration file.
 *
 * Every Ivanti endpoint, filter and field name, every BigQuery table name and column mapping,
 * and every SQL statement the app runs lives in this one file (requirement D13).
 * Nothing else in the app hard-codes a query, endpoint, field or table name.
 *
 * ┌──────────────────────────────────────────────────────────────────────────────────────────┐
 * │  NO TABLE CREATION (D23)                                                                 │
 * │  This app NEVER creates, alters or drops BigQuery datasets/tables/views, and never adds   │
 * │  Google Sheet tabs or columns. A DEVELOPER creates every table listed below, by hand,     │
 * │  from docs/SCHEMA.md. If a table is missing, runs stop and the Runs page lists what is    │
 * │  missing. Any code that tries to create a table is blocked at runtime (BigQuery.gs,       │
 * │  Store.gs) and fails the NoTableCreation unit tests (tests/noTableCreation.test.js).      │
 * └──────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * Secrets are NOT stored here. Put them in Project Settings → Script Properties:
 *   IVANTI_API_KEY   (required)  Ivanti Neurons for ITSM REST API key
 */

const QUERY_CONFIG = {
  /* ─────────────────────────────── Ivanti Neurons for ITSM ─────────────────────────────── */
  ivanti: {
    // The ONLY ticket source (D5).
    baseUrl: '',                                            // TODO(dev): e.g. https://<tenant>.ivanticloud.com
    incidentsPath: '/api/odata/businessobject/incidents',   // TODO(dev): confirm for your tenant

    // OData $filter that selects Incidents that are ready to be assigned.  TODO(dev): confirm.
    newIncidentsFilter: "Owner eq null and Status eq 'Logged'",
    // OData $orderby so older tickets are assigned first.
    orderBy: 'CreatedDateTime asc',
    // Fields to request ($select). Every field here can be used in mailbox rules.  TODO(dev)
    selectFields: ['RecId', 'IncidentNumber', 'Subject', 'Category', 'Subcategory', 'Status',
                   'Priority', 'Source', 'CreatedDateTime', 'Symptom'],
    pageSize: 100,
    maxPagesPerRun: 20,

    // Map Ivanti field names → the names the app uses internally.  TODO(dev)
    fieldMap: {
      ticketId: 'IncidentNumber',   // human ticket number; unique key in BigQuery
      recId: 'RecId',               // Ivanti record id; used to update the Owner
      subject: 'Subject',           // compared for follow-ups
      description: 'Symptom',       // sent to Vertex (later)
      category: 'Category',
      subcategory: 'Subcategory',
      createdAt: 'CreatedDateTime',
    },

    // Updating the Owner (D1, D6). '{RecId}' is replaced with the record id.
    updatePath: "/api/odata/businessobject/incidents('{RecId}')",
    updateMethod: 'patch',          // TODO(dev): 'patch' or 'put', per tenant
    writebackBatchSize: 25,

    // Authentication header. '{key}' is replaced with Script Property IVANTI_API_KEY.
    authHeaderName: 'Authorization',
    authHeaderTemplate: 'rest_api_key={key}',

    // Developer-run history backfill (Backfill.gs): which past Incidents to load.
    // '{fromIso}' is replaced with the start date (ISO 8601).  TODO(dev): confirm.
    backfillFilter: "Owner ne null and CreatedDateTime ge {fromIso}",
    // Ivanti field that holds the owner on past Incidents (matched to Employees.ivanti_owner_id).
    ownerField: 'Owner',
  },

  /* ──────────────────────────────────────── BigQuery ─────────────────────────────────────── */
  bigQuery: {
    projectId: '',        // TODO(dev): GCP project that holds the dataset and is billed for queries
    appDataset: '',       // TODO(dev): dataset CREATED BY A DEVELOPER for this app
    location: 'US',       // TODO(dev): dataset location (e.g. 'US', 'EU', 'us-east1')

    /* ───────────────────────── REQUIRED TABLE — P1 `assignments` ─────────────────────────
     * CREATED BY: a developer. This app NEVER creates or alters tables (D23). See docs/SCHEMA.md.
     * WHERE:      <appDataset>.assignments  → set assignmentsTable below (name, or dataset.table,
     *             or project.dataset.table)
     * PURPOSE:    One row per Ivanti ticket the app assigns. It is:
     *               • the ticket HISTORY for follow-up matching (D2, D24): subject + employee_id
     *               • the source of today's ±1 balance counts (counts_toward_balance = TRUE only)
     *               • the duplicate check (a ticket with a non-dry-run row is never re-assigned)
     *               • the Ivanti Owner writeback status, used for retries
     *               • the data behind the Assignment Log page
     * SCHEMA (column · type · mode):
     *   ticket_id              STRING     REQUIRED   Ivanti IncidentNumber; unique key (MERGE)
     *   ivanti_rec_id          STRING     REQUIRED   Ivanti RecId; used to set the Owner
     *   subject                STRING     REQUIRED   compared with new tickets for follow-ups
     *   mailbox_id             STRING     NULLABLE   Mailboxes.id
     *   employee_id            STRING     NULLABLE   Employees.id (the owner follow-ups return to)
     *   routing_method         STRING     REQUIRED   rule | follow_up | vertex | manual | backfill
     *   counts_toward_balance  BOOL       REQUIRED   FALSE for follow-ups and backfill (D7)
     *   matched_ticket_id      STRING     NULLABLE   earlier ticket a follow-up matched
     *   match_score            FLOAT64    NULLABLE   0–1
     *   rule_id                STRING     NULLABLE   Rules.id that routed it
     *   rule_version           INT64      NULLABLE   version of that rule
     *   config_revision        STRING     NULLABLE   config snapshot the run used
     *   run_id                 STRING     NULLABLE   runs.run_id (NULL for manual actions)
     *   dry_run                BOOL       REQUIRED   dry-run rows are ignored by history/dedupe/balance
     *   assigned_at            TIMESTAMP  REQUIRED
     *   assigned_by            STRING     NULLABLE   'system', 'backfill', or the admin's email
     *   version                INT64      REQUIRED   optimistic-concurrency version (starts at 1)
     *   writeback_status       STRING     REQUIRED   pending | success | failed | skipped_dry_run | not_applicable
     *   writeback_attempts     INT64      REQUIRED
     *   writeback_error        STRING     NULLABLE
     *   ticket_snapshot_json   JSON       NULLABLE   Ivanti fields used for routing
     * PARTITION:  DATE(assigned_at)        CLUSTER: mailbox_id, employee_id
     * ACCESS:     app account → BigQuery Data Editor on THIS TABLE ONLY (never on the dataset)
     * WRITES:     MERGE on ticket_id (BigQuery.gs) · READS: Balancer, FollowUp, Pipeline, Assignment Log
     * CHECKED BY: SchemaCheck.gs → checkSchema() against REQUIRED_SCHEMA.assignments
     * ───────────────────────────────────────────────────────────────────────────────────── */
    assignmentsTable: 'assignments',

    /* ───────────────────────────── REQUIRED TABLE — P2 `runs` ────────────────────────────
     * CREATED BY: a developer. This app NEVER creates or alters tables (D23). See docs/SCHEMA.md.
     * WHERE:      <appDataset>.runs  → set runsTable below
     * PURPOSE:    One row per assignment run (scheduled 6 AM / 1 PM weekdays, Run now, or a
     *             continuation). Powers the Run Assignment page (status, who started it, counts,
     *             errors) and records which scheduled slot each run covered.
     * SCHEMA (column · type · mode):
     *   run_id              STRING     REQUIRED   unique key
     *   trigger_type        STRING     REQUIRED   scheduled | manual | continuation
     *   triggered_by        STRING     REQUIRED   email, or 'system'
     *   run_slot            STRING     NULLABLE   e.g. '2026-11-16 06:00' (scheduled runs only)
     *   dry_run             BOOL       REQUIRED
     *   started_at          TIMESTAMP  REQUIRED
     *   finished_at         TIMESTAMP  NULLABLE   NULL while running
     *   status              STRING     REQUIRED   running | succeeded | failed | stopped_check_failed | continued
     *   config_revision     STRING     NULLABLE
     *   fetched             INT64      NULLABLE
     *   assigned            INT64      NULLABLE
     *   follow_ups          INT64      NULLABLE
     *   unrouted            INT64      NULLABLE
     *   writeback_failures  INT64      NULLABLE
     *   errors_json         JSON       NULLABLE
     * PARTITION:  DATE(started_at)
     * ACCESS:     app account → BigQuery Data Editor on THIS TABLE ONLY
     * WRITES:     MERGE on run_id · READS: Run Assignment page
     * CHECKED BY: SchemaCheck.gs → checkSchema() against REQUIRED_SCHEMA.runs
     * ───────────────────────────────────────────────────────────────────────────────────── */
    runsTable: 'runs',

    /* ────────────────────────── REQUIRED TABLE — P3 `vertex_queue` ───────────────────────
     * CREATED BY: a developer. This app NEVER creates or alters tables (D23). See docs/SCHEMA.md.
     * WHERE:      <appDataset>.vertex_queue  → set vertexQueueTable below
     * PURPOSE:    One row per ticket the app could not route (no rule matched and not a
     *             follow-up, or no one scheduled on its mailbox). Holds the structured payload
     *             for Vertex (added later by a developer) and backs the Unrouted Queue page.
     * SCHEMA (column · type · mode):
     *   ticket_id          STRING     REQUIRED   unique key
     *   payload_json       JSON       REQUIRED   Vertex payload (see Vertex.gs)
     *   status             STRING     REQUIRED   pending | classified | failed | manual_review |
     *                                            no_one_scheduled | resolved_manually | routed
     *   reason             STRING     NULLABLE   no_rule_match | no_one_scheduled
     *   result_mailbox_id  STRING     NULLABLE
     *   confidence         FLOAT64    NULLABLE
     *   rationale          STRING     NULLABLE
     *   attempts           INT64      REQUIRED
     *   created_at         TIMESTAMP  REQUIRED
     *   processed_at       TIMESTAMP  NULLABLE
     *   version            INT64      REQUIRED
     * CLUSTER:    status
     * ACCESS:     app account → BigQuery Data Editor on THIS TABLE ONLY
     * WRITES:     MERGE on ticket_id · READS: Unrouted Queue page, processVertexQueue()
     * CHECKED BY: SchemaCheck.gs → checkSchema() against REQUIRED_SCHEMA.vertex_queue
     * ───────────────────────────────────────────────────────────────────────────────────── */
    vertexQueueTable: 'vertex_queue',

    // Where follow-up matching looks for earlier tickets (D24).
    // Default ('' table) = the assignments table above. A developer may point this at another
    // EXISTING table of Ivanti ticket history (the app only SELECTs from it).
    ticketHistory: {
      table: '',
      columns: {
        ticketId: 'ticket_id',
        subject: 'subject',
        owner: 'employee_id',
        mailbox: 'mailbox_id',        // '' if the history table has no mailbox column
        recordedAt: 'assigned_at',
      },
      // 'employee_id' = owner column holds Employees.id; 'ivanti_owner_id' = holds Ivanti owner ids.
      ownerColumnType: 'employee_id',
      // Extra SQL condition (developer-controlled). Default excludes dry-run rows of the assignments table.
      extraFilter: 'dry_run = FALSE',
    },
  },

  /* ────────────────────────────────────── Google Sheet ───────────────────────────────────── */
  sheet: {
    spreadsheetId: '',    // TODO(dev): spreadsheet whose tabs are listed in REQUIRED_SHEET_TABS (created by a developer)
  },

  /* ─────────────────────────────────── Subject matching ──────────────────────────────────── */
  subjectMatching: {
    // Leading reply/forward prefixes and tags removed before comparing subjects.
    // Used by BOTH JavaScript and BigQuery (RE2), so keep it to simple syntax. Applied after lower-casing.
    prefixPattern: '^(\\s*((re|fw|fwd|aw|sv|tr|wg)\\s*:|\\[\\s*(ext|external)\\s*\\]))+',
  },
};

/**
 * REQUIRED_SCHEMA — what SchemaCheck.gs expects each developer-created table to contain.
 * This is a READ-ONLY specification used to CHECK tables. The app never uses it to build tables.
 * Types use GoogleSQL names; SchemaCheck also accepts the legacy aliases BigQuery reports
 * (BOOLEAN, INTEGER, FLOAT).
 */
const REQUIRED_SCHEMA = {
  assignments: {
    configKey: 'assignmentsTable',
    columns: [
      ['ticket_id', 'STRING', 'REQUIRED'], ['ivanti_rec_id', 'STRING', 'REQUIRED'],
      ['subject', 'STRING', 'REQUIRED'], ['mailbox_id', 'STRING', 'NULLABLE'],
      ['employee_id', 'STRING', 'NULLABLE'], ['routing_method', 'STRING', 'REQUIRED'],
      ['counts_toward_balance', 'BOOL', 'REQUIRED'], ['matched_ticket_id', 'STRING', 'NULLABLE'],
      ['match_score', 'FLOAT64', 'NULLABLE'], ['rule_id', 'STRING', 'NULLABLE'],
      ['rule_version', 'INT64', 'NULLABLE'], ['config_revision', 'STRING', 'NULLABLE'],
      ['run_id', 'STRING', 'NULLABLE'], ['dry_run', 'BOOL', 'REQUIRED'],
      ['assigned_at', 'TIMESTAMP', 'REQUIRED'], ['assigned_by', 'STRING', 'NULLABLE'],
      ['version', 'INT64', 'REQUIRED'], ['writeback_status', 'STRING', 'REQUIRED'],
      ['writeback_attempts', 'INT64', 'REQUIRED'], ['writeback_error', 'STRING', 'NULLABLE'],
      ['ticket_snapshot_json', 'JSON', 'NULLABLE'],
    ],
  },
  runs: {
    configKey: 'runsTable',
    columns: [
      ['run_id', 'STRING', 'REQUIRED'], ['trigger_type', 'STRING', 'REQUIRED'],
      ['triggered_by', 'STRING', 'REQUIRED'], ['run_slot', 'STRING', 'NULLABLE'],
      ['dry_run', 'BOOL', 'REQUIRED'], ['started_at', 'TIMESTAMP', 'REQUIRED'],
      ['finished_at', 'TIMESTAMP', 'NULLABLE'], ['status', 'STRING', 'REQUIRED'],
      ['config_revision', 'STRING', 'NULLABLE'], ['fetched', 'INT64', 'NULLABLE'],
      ['assigned', 'INT64', 'NULLABLE'], ['follow_ups', 'INT64', 'NULLABLE'],
      ['unrouted', 'INT64', 'NULLABLE'], ['writeback_failures', 'INT64', 'NULLABLE'],
      ['errors_json', 'JSON', 'NULLABLE'],
    ],
  },
  vertex_queue: {
    configKey: 'vertexQueueTable',
    columns: [
      ['ticket_id', 'STRING', 'REQUIRED'], ['payload_json', 'JSON', 'REQUIRED'],
      ['status', 'STRING', 'REQUIRED'], ['reason', 'STRING', 'NULLABLE'],
      ['result_mailbox_id', 'STRING', 'NULLABLE'], ['confidence', 'FLOAT64', 'NULLABLE'],
      ['rationale', 'STRING', 'NULLABLE'], ['attempts', 'INT64', 'REQUIRED'],
      ['created_at', 'TIMESTAMP', 'REQUIRED'], ['processed_at', 'TIMESTAMP', 'NULLABLE'],
      ['version', 'INT64', 'REQUIRED'],
    ],
  },
};

/**
 * REQUIRED_SHEET_TABS — tabs a developer creates in the configured spreadsheet, with row 1
 * holding exactly these headers (extra columns to the right are allowed and preserved).
 * The app NEVER adds tabs or columns; it only reads and writes rows.
 * Column types tell Store.gs how to read/write values.
 */
const REQUIRED_SHEET_TABS = {
  Mailboxes: { idField: 'id', softDelete: 'active', columns: {
    id: 'string', name: 'string', description: 'string', priority: 'number', active: 'bool',
    version: 'number', updated_by: 'string', updated_at: 'datetime' } },
  Rules: { idField: 'id', softDelete: 'active', columns: {
    id: 'string', mailbox_id: 'string', conditions_json: 'json', active: 'bool',
    version: 'number', updated_by: 'string', updated_at: 'datetime' } },
  Employees: { idField: 'id', softDelete: 'active', columns: {
    id: 'string', employee_email: 'string', display_name: 'string', active: 'bool',
    ivanti_owner_id: 'string', version: 'number', updated_by: 'string', updated_at: 'datetime' } },
  Schedule: { idField: 'id', softDelete: 'deleted_at', columns: {
    id: 'string', date: 'date', mailbox_id: 'string', employee_id: 'string', deleted_at: 'datetime',
    version: 'number', updated_by: 'string', updated_at: 'datetime' } },
  Admins: { idField: 'id', softDelete: 'active', columns: {
    id: 'string', email: 'string', active: 'bool', version: 'number', updated_by: 'string',
    updated_at: 'datetime' } },
  Settings: { idField: 'key', softDelete: null, columns: {
    key: 'string', value: 'string', version: 'number', updated_by: 'string', updated_at: 'datetime' } },
  SubjectIgnoreList: { idField: 'id', softDelete: 'active', columns: {
    id: 'string', value: 'string', active: 'bool', version: 'number', updated_by: 'string',
    updated_at: 'datetime' } },
  StopWords: { idField: 'id', softDelete: 'active', columns: {
    id: 'string', value: 'string', active: 'bool', version: 'number', updated_by: 'string',
    updated_at: 'datetime' } },
  AuditLog: { idField: null, softDelete: null, appendOnly: true, columns: {
    at: 'datetime', user: 'string', entity: 'string', entity_id: 'string', action: 'string',
    before_json: 'string', after_json: 'string', request_id: 'string' } },
};

/**
 * SQL — every statement the app sends to BigQuery. Only SELECT, INSERT and MERGE are allowed;
 * BigQuery.gs rejects anything else before it is sent (D23). Each statement begins with an
 * "-- op:" label that identifies it in logs and tests.
 * `t` is a resolved table reference string like `project.dataset.table` (with backticks).
 */
const SQL = {
  assignmentsExisting: (t) => `-- op:assignments.existing
SELECT ticket_id FROM ${t}
WHERE dry_run = FALSE AND ticket_id IN UNNEST(@ids)`,

  assignmentsTodayCounts: (t) => `-- op:assignments.todayCounts
SELECT mailbox_id, employee_id, COUNT(*) AS n FROM ${t}
WHERE dry_run = FALSE AND counts_toward_balance = TRUE
  AND assigned_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 2 DAY)
  AND DATE(assigned_at, @tz) = @today
GROUP BY mailbox_id, employee_id`,

  assignmentsMerge: (t) => `-- op:assignments.merge
MERGE ${t} T
USING (
  SELECT r.ticket_id, r.ivanti_rec_id, r.subject, r.mailbox_id, r.employee_id, r.routing_method,
         r.counts_toward_balance, r.matched_ticket_id, r.match_score, r.rule_id, r.rule_version,
         r.config_revision, r.run_id, r.dry_run, TIMESTAMP(r.assigned_at) AS assigned_at,
         r.assigned_by, r.writeback_status, r.writeback_attempts, r.writeback_error,
         SAFE.PARSE_JSON(r.ticket_snapshot_json) AS ticket_snapshot_json
  FROM UNNEST(@rows) AS r
) S
ON T.ticket_id = S.ticket_id
WHEN MATCHED AND T.dry_run = TRUE THEN UPDATE SET
  ivanti_rec_id = S.ivanti_rec_id, subject = S.subject, mailbox_id = S.mailbox_id,
  employee_id = S.employee_id, routing_method = S.routing_method,
  counts_toward_balance = S.counts_toward_balance, matched_ticket_id = S.matched_ticket_id,
  match_score = S.match_score, rule_id = S.rule_id, rule_version = S.rule_version,
  config_revision = S.config_revision, run_id = S.run_id, dry_run = S.dry_run,
  assigned_at = S.assigned_at, assigned_by = S.assigned_by, version = T.version + 1,
  writeback_status = S.writeback_status, writeback_attempts = S.writeback_attempts,
  writeback_error = S.writeback_error, ticket_snapshot_json = S.ticket_snapshot_json
WHEN NOT MATCHED THEN INSERT (
  ticket_id, ivanti_rec_id, subject, mailbox_id, employee_id, routing_method,
  counts_toward_balance, matched_ticket_id, match_score, rule_id, rule_version, config_revision,
  run_id, dry_run, assigned_at, assigned_by, version, writeback_status, writeback_attempts,
  writeback_error, ticket_snapshot_json)
VALUES (
  S.ticket_id, S.ivanti_rec_id, S.subject, S.mailbox_id, S.employee_id, S.routing_method,
  S.counts_toward_balance, S.matched_ticket_id, S.match_score, S.rule_id, S.rule_version,
  S.config_revision, S.run_id, S.dry_run, S.assigned_at, S.assigned_by, 1, S.writeback_status,
  S.writeback_attempts, S.writeback_error, S.ticket_snapshot_json)`,

  assignmentsWritebackUpdate: (t) => `-- op:assignments.writebackUpdate
MERGE ${t} T
USING (SELECT u.ticket_id, u.writeback_status, u.writeback_error FROM UNNEST(@rows) AS u) S
ON T.ticket_id = S.ticket_id AND T.dry_run = FALSE
WHEN MATCHED THEN UPDATE SET
  writeback_status = S.writeback_status,
  writeback_attempts = T.writeback_attempts + 1,
  writeback_error = S.writeback_error`,

  assignmentsPendingWritebacks: (t) => `-- op:assignments.pendingWritebacks
SELECT ticket_id, ivanti_rec_id, employee_id, mailbox_id, writeback_attempts FROM ${t}
WHERE dry_run = FALSE AND writeback_status IN ('pending', 'failed')
  AND writeback_attempts < @max_attempts
  AND (run_id IS NULL OR run_id != @current_run_id)
ORDER BY assigned_at
LIMIT 200`,

  assignmentsSearch: (t) => `-- op:assignments.search
SELECT ticket_id, ivanti_rec_id, subject, mailbox_id, employee_id, routing_method,
       counts_toward_balance, matched_ticket_id, match_score, rule_id, rule_version, run_id, dry_run,
       FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', assigned_at) AS assigned_at, assigned_by, version,
       writeback_status, writeback_attempts, writeback_error
FROM ${t}
WHERE DATE(assigned_at, @tz) BETWEEN @from_date AND @to_date
  AND (@ticket_id = '' OR ticket_id = @ticket_id)
  AND (@employee_id = '' OR employee_id = @employee_id)
  AND (@mailbox_id = '' OR mailbox_id = @mailbox_id)
  AND (@include_dry_run OR dry_run = FALSE)
ORDER BY assigned_at DESC
LIMIT 500`,

  assignmentsGet: (t) => `-- op:assignments.get
SELECT ticket_id, ivanti_rec_id, subject, mailbox_id, employee_id, routing_method,
       counts_toward_balance, version, writeback_status, writeback_attempts
FROM ${t}
WHERE ticket_id = @ticket_id AND dry_run = FALSE`,

  assignmentsReassign: (t) => `-- op:assignments.reassign
MERGE ${t} T
USING (SELECT @ticket_id AS ticket_id) S
ON T.ticket_id = S.ticket_id AND T.dry_run = FALSE AND T.version = @expected_version
WHEN MATCHED THEN UPDATE SET
  employee_id = @employee_id, assigned_by = @assigned_by, version = T.version + 1,
  writeback_status = 'pending', writeback_attempts = 0, writeback_error = NULL`,

  assignmentsRecentSnapshots: (t) => `-- op:assignments.recentSnapshots
SELECT ticket_id, subject, TO_JSON_STRING(ticket_snapshot_json) AS snapshot
FROM ${t}
WHERE dry_run = FALSE AND ticket_snapshot_json IS NOT NULL
  AND assigned_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
ORDER BY assigned_at DESC
LIMIT @limit`,

  /**
   * Follow-up matching (D9). New tickets arrive as an ARRAY<STRUCT<ticket_id, seq>> parameter,
   * where seq is the cleaned, stop-word-free subject (built by Subject.gs). History subjects are
   * cleaned the same way here in SQL. Score = max(word overlap, containment). No temporary tables.
   */
  historyMatch: (t, c) => `-- op:history.match
WITH new_t AS (
  SELECT n.ticket_id, n.seq,
         ARRAY(SELECT DISTINCT w FROM UNNEST(SPLIT(n.seq, ' ')) AS w WHERE w != '') AS toks,
         ARRAY_LENGTH(SPLIT(n.seq, ' ')) AS wc
  FROM UNNEST(@new_tickets) AS n
),
hist_norm AS (
  SELECT CAST(${c.ticketId} AS STRING) AS h_ticket_id,
         CAST(${c.owner} AS STRING) AS h_owner,
         ${c.mailbox ? `CAST(${c.mailbox} AS STRING)` : 'CAST(NULL AS STRING)'} AS h_mailbox,
         CAST(${c.recordedAt} AS TIMESTAMP) AS h_at,
         TRIM(REGEXP_REPLACE(REGEXP_REPLACE(LOWER(${c.subject}), @prefix_pattern, ''), r'[^a-z0-9]+', ' ')) AS norm
  FROM ${t}
  WHERE ${c.subject} IS NOT NULL AND ${c.owner} IS NOT NULL AND (${c.extraFilter || 'TRUE'})
),
hist AS (
  SELECT h_ticket_id, h_owner, h_mailbox, h_at,
         ARRAY_TO_STRING(ARRAY(
           SELECT w FROM UNNEST(SPLIT(norm, ' ')) AS w WITH OFFSET AS o
           WHERE w != '' AND w NOT IN UNNEST(@stop_words) ORDER BY o), ' ') AS seq
  FROM hist_norm
),
hist_t AS (
  SELECT h_ticket_id, h_owner, h_mailbox, h_at, seq,
         ARRAY(SELECT DISTINCT w FROM UNNEST(SPLIT(seq, ' ')) AS w WHERE w != '') AS toks,
         ARRAY_LENGTH(SPLIT(seq, ' ')) AS wc
  FROM hist WHERE seq != ''
),
pairs AS (
  SELECT n.ticket_id, h.h_ticket_id, h.h_owner, h.h_mailbox, h.h_at,
         n.seq AS n_seq, h.seq AS h_seq, n.wc AS n_wc, h.wc AS h_wc,
         ARRAY_LENGTH(n.toks) AS n_len, ARRAY_LENGTH(h.toks) AS h_len,
         (SELECT COUNT(*) FROM UNNEST(n.toks) AS a WHERE a IN UNNEST(h.toks)) AS inter
  FROM new_t AS n CROSS JOIN hist_t AS h
  WHERE h.h_ticket_id != n.ticket_id
),
scored AS (
  SELECT ticket_id, h_ticket_id, h_owner, h_mailbox, h_at,
         GREATEST(
           IFNULL(SAFE_DIVIDE(inter, n_len + h_len - inter), 0),
           IF(LEAST(n_wc, h_wc) >= @min_words AND
              STRPOS(CONCAT(' ', IF(n_wc >= h_wc, n_seq, h_seq), ' '),
                     CONCAT(' ', IF(n_wc >= h_wc, h_seq, n_seq), ' ')) > 0, 1.0, 0.0)
         ) AS score
  FROM pairs
  WHERE inter > 0
)
SELECT ticket_id, h_ticket_id AS matched_ticket_id, h_owner AS owner, h_mailbox AS mailbox_id,
       score, FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', h_at) AS matched_at
FROM scored
WHERE score >= @threshold
QUALIFY ROW_NUMBER() OVER (PARTITION BY ticket_id ORDER BY score DESC, h_at DESC) <= @limit_per_ticket`,

  runsUpsert: (t) => `-- op:runs.upsert
MERGE ${t} T
USING (
  SELECT r.run_id, r.trigger_type, r.triggered_by, r.run_slot, r.dry_run,
         TIMESTAMP(r.started_at) AS started_at, TIMESTAMP(r.finished_at) AS finished_at, r.status,
         r.config_revision, r.fetched, r.assigned, r.follow_ups, r.unrouted, r.writeback_failures,
         SAFE.PARSE_JSON(r.errors_json) AS errors_json
  FROM UNNEST(@rows) AS r
) S
ON T.run_id = S.run_id
WHEN MATCHED THEN UPDATE SET
  finished_at = S.finished_at, status = S.status, config_revision = S.config_revision,
  fetched = S.fetched, assigned = S.assigned, follow_ups = S.follow_ups, unrouted = S.unrouted,
  writeback_failures = S.writeback_failures, errors_json = S.errors_json
WHEN NOT MATCHED THEN INSERT (
  run_id, trigger_type, triggered_by, run_slot, dry_run, started_at, finished_at, status,
  config_revision, fetched, assigned, follow_ups, unrouted, writeback_failures, errors_json)
VALUES (
  S.run_id, S.trigger_type, S.triggered_by, S.run_slot, S.dry_run, S.started_at, S.finished_at,
  S.status, S.config_revision, S.fetched, S.assigned, S.follow_ups, S.unrouted,
  S.writeback_failures, S.errors_json)`,

  runsRecent: (t) => `-- op:runs.recent
SELECT run_id, trigger_type, triggered_by, run_slot, dry_run,
       FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', started_at) AS started_at,
       FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', finished_at) AS finished_at,
       status, fetched, assigned, follow_ups, unrouted, writeback_failures,
       TO_JSON_STRING(errors_json) AS errors_json
FROM ${t}
WHERE started_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
ORDER BY started_at DESC
LIMIT @limit`,

  queueUpsert: (t) => `-- op:queue.upsert
MERGE ${t} T
USING (SELECT q.ticket_id, q.payload_json, q.status, q.reason FROM UNNEST(@rows) AS q) S
ON T.ticket_id = S.ticket_id
WHEN MATCHED AND T.status IN ('pending', 'no_one_scheduled', 'failed', 'manual_review', 'routed') THEN UPDATE SET
  payload_json = PARSE_JSON(S.payload_json), status = S.status, reason = S.reason,
  attempts = T.attempts + 1, version = T.version + 1
WHEN NOT MATCHED THEN INSERT (ticket_id, payload_json, status, reason, attempts, created_at, version)
VALUES (S.ticket_id, PARSE_JSON(S.payload_json), S.status, S.reason, 1, CURRENT_TIMESTAMP(), 1)`,

  queueSetStatus: (t) => `-- op:queue.setStatus
MERGE ${t} T
USING (
  SELECT s.ticket_id, s.status, s.result_mailbox_id, s.confidence, s.rationale, s.expected_version
  FROM UNNEST(@rows) AS s
) S
ON T.ticket_id = S.ticket_id AND (S.expected_version IS NULL OR T.version = S.expected_version)
WHEN MATCHED THEN UPDATE SET
  status = S.status,
  result_mailbox_id = COALESCE(S.result_mailbox_id, T.result_mailbox_id),
  confidence = COALESCE(S.confidence, T.confidence),
  rationale = COALESCE(S.rationale, T.rationale),
  processed_at = CURRENT_TIMESTAMP(),
  version = T.version + 1`,

  queueList: (t) => `-- op:queue.list
SELECT ticket_id, TO_JSON_STRING(payload_json) AS payload_json, status, reason, result_mailbox_id,
       confidence, rationale, attempts,
       FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', created_at) AS created_at,
       FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', processed_at) AS processed_at, version
FROM ${t}
WHERE status IN UNNEST(@statuses)
ORDER BY created_at
LIMIT 500`,
};
