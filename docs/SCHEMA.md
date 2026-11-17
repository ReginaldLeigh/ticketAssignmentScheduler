# Required tables: for a developer to create by hand

> **The app never creates, alters or drops tables.** It only reads and writes rows in tables that
> already exist. Everything on this page is created **by a developer** before the app is used.
> If something is missing, the app stops and the **Run assignment → Setup check** panel lists it.
> Code that tries to create a table fails the `NoTableCreation` unit tests.

The SQL below is a reference for you to run yourself in the BigQuery console or with `bq query`.
Replace `PROJECT` and `DATASET` with your values, and set the same values in `src/QueryConfig.gs`
(`bigQuery.projectId`, `bigQuery.appDataset`, `bigQuery.location`).

---

## 1. Dataset

```sql
CREATE SCHEMA `PROJECT.DATASET` OPTIONS (location = 'US');
```

## 2. BigQuery tables (approved: P1, P2, P3; `team_id` columns approved 2026-11-16)

Every table carries a `team_id`, matching an `id` in `TEAMS` in `src/QueryConfig.gs`. Each team only
ever reads and writes its own rows; the shared queue is the one exception (see P3).

> **Already created the tables before teams were added?** Add the new columns yourself; the app will
> not. `ALTER TABLE … ADD COLUMN` can only add NULLABLE columns, so for `assignments` and `runs`
> either recreate the tables (the dataset starts fresh, so they should be empty) or add the column,
> fill it, and accept that `checkSchema()` reports the mode until the table is recreated.

### P1 `assignments`: one row per ticket the app assigns

It's the ticket history used for follow-ups, today's ±1 balance counts, the duplicate check, Ivanti
update retries and the Assignment Log.

```sql
CREATE TABLE `PROJECT.DATASET.assignments` (
  ticket_id             STRING    NOT NULL OPTIONS (description = 'Ivanti IncidentNumber; unique key'),
  team_id               STRING    NOT NULL OPTIONS (description = 'TEAMS id that owns this assignment'),
  ivanti_rec_id         STRING    NOT NULL OPTIONS (description = 'Ivanti RecId; used to set the Owner'),
  subject               STRING    NOT NULL OPTIONS (description = 'Compared with new tickets for follow-ups'),
  mailbox_id            STRING             OPTIONS (description = 'Mailboxes.id'),
  employee_id           STRING             OPTIONS (description = 'Employees.id; owner follow-ups return to'),
  routing_method        STRING    NOT NULL OPTIONS (description = 'rule | follow_up | vertex | manual'),
  counts_toward_balance BOOL      NOT NULL OPTIONS (description = 'FALSE for follow-ups'),
  matched_ticket_id     STRING,
  match_score           FLOAT64,
  rule_id               STRING,
  rule_version          INT64,
  config_revision       STRING,
  run_id                STRING,
  dry_run               BOOL      NOT NULL,
  assigned_at           TIMESTAMP NOT NULL,
  assigned_by           STRING,
  version               INT64     NOT NULL,
  writeback_status      STRING    NOT NULL OPTIONS (description = 'pending | success | failed | skipped_dry_run'),
  writeback_attempts    INT64     NOT NULL,
  writeback_error       STRING,
  ticket_snapshot_json  JSON
)
PARTITION BY DATE(assigned_at)
CLUSTER BY team_id, mailbox_id, employee_id;
```

### P2 `runs`: one row per assignment run

```sql
CREATE TABLE `PROJECT.DATASET.runs` (
  run_id             STRING    NOT NULL,
  team_id            STRING    NOT NULL OPTIONS (description = 'Each run handles one team'),
  trigger_type       STRING    NOT NULL OPTIONS (description = 'scheduled | manual | continuation'),
  triggered_by       STRING    NOT NULL,
  run_slot           STRING,
  dry_run            BOOL      NOT NULL,
  started_at         TIMESTAMP NOT NULL,
  finished_at        TIMESTAMP,
  status             STRING    NOT NULL OPTIONS (description = 'running | succeeded | failed | stopped_check_failed | continued'),
  config_revision    STRING,
  fetched            INT64,
  assigned           INT64,
  follow_ups         INT64,
  unrouted           INT64,
  writeback_failures INT64,
  errors_json        JSON
)
PARTITION BY DATE(started_at)
CLUSTER BY team_id;
```

### P3 `vertex_queue`: tickets the app could not route

`team_id` is set when the team is known (a rule matched, but nobody linked to Ivanti was scheduled):
that ticket sits in the team's own queue. It is NULL when no team could place the ticket: that ticket
is in the **shared queue**, which every team's managers and admins can see (only the fields listed in
`QUERY_CONFIG.sharedQueue.visibleFields`). The first team to take a shared ticket gets it; the app
then sets `team_id` and `claimed_by_team` to that team.

```sql
CREATE TABLE `PROJECT.DATASET.vertex_queue` (
  ticket_id         STRING    NOT NULL,
  team_id           STRING             OPTIONS (description = 'NULL = shared queue'),
  claimed_by_team   STRING             OPTIONS (description = 'Team that took a shared ticket'),
  payload_json      JSON      NOT NULL OPTIONS (description = 'Structured payload for Vertex (see docs/VERTEX_INTEGRATION.md)'),
  status            STRING    NOT NULL OPTIONS (description = 'pending | classified | failed | manual_review | no_one_scheduled | no_linked_employee | resolved_manually | routed'),
  reason            STRING,
  result_mailbox_id STRING,
  confidence        FLOAT64,
  rationale         STRING,
  attempts          INT64     NOT NULL,
  created_at        TIMESTAMP NOT NULL,
  processed_at      TIMESTAMP,
  version           INT64     NOT NULL
)
CLUSTER BY team_id, status;
```

Columns marked `NOT NULL` must be REQUIRED. Every other column must be NULLABLE. Extra columns are
fine. The app checks names, types and modes with `checkSchema()`.

## 3. Permissions (least privilege, and a second safeguard against table creation)

The app runs as **one account**: the account that deploys the web app and installs the triggers.
Users need no BigQuery access. Grant that account:

```sql
-- Data Editor on EACH TABLE, never on the dataset. A dataset-level grant includes permission to
-- create tables; a table-level grant does not, so BigQuery itself refuses any table creation.
GRANT `roles/bigquery.dataEditor` ON TABLE `PROJECT.DATASET.assignments`  TO "user:APP_ACCOUNT@yourco.com";
GRANT `roles/bigquery.dataEditor` ON TABLE `PROJECT.DATASET.runs`         TO "user:APP_ACCOUNT@yourco.com";
GRANT `roles/bigquery.dataEditor` ON TABLE `PROJECT.DATASET.vertex_queue` TO "user:APP_ACCOUNT@yourco.com";
```

The account also needs **BigQuery Job User** (`roles/bigquery.jobUser`) on the project, so it can run
queries. The table-level Data Editor grant already lets `checkSchema()` read each table's definition.

If you point `bigQuery.ticketHistory.table` at another existing table, grant only
`roles/bigquery.dataViewer` on that table.

## 4. Google Sheet

Create one spreadsheet and put its ID in `QueryConfig.gs → sheet.spreadsheetId`. Share it with
**no one but the app account**: admins edit through the app, never in the Sheet.

Create these tabs, with **row 1 exactly as shown**. Extra columns to the right are allowed and kept.
Tip: format the `date` column of **Schedule** as *Plain text* (Format → Number → Plain text).

| Tab | Row 1 headers |
|---|---|
| `Mailboxes` | `id, team_id, name, description, priority, active, version, updated_by, updated_at` |
| `Rules` | `id, team_id, mailbox_id, conditions_json, active, version, updated_by, updated_at` |
| `Employees` | `id, team_id, employee_email, display_name, active, ivanti_owner_id, ivanti_lookup_status, ivanti_checked_at, version, updated_by, updated_at` |
| `Schedule` | `id, team_id, date, mailbox_id, employee_id, deleted_at, version, updated_by, updated_at` |
| `Admins` | `id, team_id, email, active, version, updated_by, updated_at` |
| `Settings` | `id, team_id, key, value, version, updated_by, updated_at` |
| `SubjectIgnoreList` | `id, team_id, value, active, version, updated_by, updated_at` |
| `StopWords` | `id, team_id, value, active, version, updated_by, updated_at` |
| `AuditLog` | `at, team_id, user, entity, entity_id, action, before_json, after_json, request_id` |

Notes on the columns:

- `team_id` is filled in by the app on every row. A person can be on only one team at a time.
- `Employees.ivanti_owner_id` is filled in by the Ivanti lookup (see `docs/IVANTI_INTEGRATION.md`).
  It never leaves the server: it isn't sent to the browser and is shown as `[hidden]` in the AuditLog.
  `ivanti_lookup_status` is `found`, `not_found` or `error`; `ivanti_checked_at` is when it last ran.
- `Settings` holds only what admins can change per team: `RUN_TIMES` and `RUN_DAYS`. Everything else
  is in `DEVELOPER_SETTINGS` in `src/QueryConfig.gs`.
- `Admins` is edited by **managers** only. Managers themselves are listed in `TEAMS` in
  `src/QueryConfig.gs`, not in the Sheet.

Leave the tabs empty below the header row. The app adds rows as people work. Each team's managers
(from `TEAMS`) can sign in straight away and add their admins and roster from the app.
