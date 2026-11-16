# Developer setup

Do these steps once, in order. Until they're all done, the app shows what's missing instead of
running. It never creates anything to fill a gap.

## 0. Choose the account the app runs as

Use a **dedicated shared account** (for example `ticket-scheduler@yourco.com`), not a person's own
account. Every BigQuery query, Sheet edit and Ivanti call runs as this account, and so do the
scheduled runs. If the app ran under someone who later left, it would stop working. Users only need
a Google account in your Workspace domain; they need no BigQuery, Sheet or Ivanti access.

## 1. Create the tables and the Sheet

Follow **[SCHEMA.md](SCHEMA.md)**: dataset, the three BigQuery tables, per-table permissions, the
spreadsheet and its nine tabs.

## 2. Push the code

```bash
npm install -g @google/clasp     # once
clasp login                      # as the app account
clasp create --type standalone --title "Ticket Assignment Scheduler" --rootDir src
#   or, for an existing project: copy .clasp.json.example to .clasp.json and set scriptId
clasp push
```

## 3. Configure (`src/QueryConfig.gs`)

Every value marked `TODO(dev)`:

| Setting | What to put |
|---|---|
| `ivanti.baseUrl` | Your tenant, e.g. `https://yourco.ivanticloud.com` |
| `ivanti.newIncidentsFilter` | OData filter for Incidents ready to assign (default: no owner, status Logged) |
| `ivanti.selectFields` / `fieldMap` | Field names in your tenant. `selectFields` are also the fields admins can use in rules. |
| `ivanti.updateMethod` | `patch` or `put`, depending on your tenant |
| `ivanti.backfillFilter`, `ownerField` | Only for the one-time history backfill (step 6) |
| `bigQuery.projectId`, `appDataset`, `location` | From step 1 |
| `bigQuery.*Table` | Table names, if you used different ones |
| `bigQuery.ticketHistory` | Leave `table: ''` to use `assignments`, or point it at another existing history table |
| `sheet.spreadsheetId` | From step 1 |

Then **Project Settings → Script Properties** → add `IVANTI_API_KEY`. It's sent as
`Authorization: rest_api_key=<key>`; change `authHeaderTemplate` if your tenant expects a different format.

All SQL lives in the `SQL` object in the same file. Only `SELECT`, `INSERT` and `MERGE` are allowed.

## 4. Deploy the web app

**Deploy → New deployment → Web app**: *Execute as: Me*, *Who has access: Anyone within your domain*.
`appsscript.json` already sets this. Open the URL as the app account and check
**Run assignment → Check setup**: it must say *Everything is set up*.

## 5. Switch on automatic runs

On the **Run assignment** page, click **Switch on automatic runs**, or run `installTriggers()` in the
editor. This installs a 10-minute ticker that starts runs at **6:00 AM and 1:00 PM, Monday to Friday**
(America/New_York). Admins can change the times and days in Settings.

## 6. Load past tickets as history (recommended)

Follow-ups are found by comparing subjects with earlier tickets. The `assignments` table starts empty,
so load past Incidents once. In the editor run, for example:

```js
backfillHistoryFromIvanti('2026-01-01')
```

This only **adds rows** to the existing `assignments` table, marked `routing_method = 'backfill'`.
They never count toward the ±1 split and are never sent to Ivanti. Owners are matched to the Roster
by `ivanti_owner_id`, so fill in the Roster first.

## 7. Shadow week, then go live

1. For a week, admins use **Run now** with **Dry run** ticked. Nothing changes in Ivanti, and dry-run
   rows are ignored by history, balancing and the duplicate check.
2. Compare the Assignment Log (tick *Include dry runs*) with how tickets were really assigned. Use
   **Settings → Test a subject** to tune the follow-up threshold.
3. Switch on automatic runs (step 5).

## Tests

```bash
npm test        # node --test; no packages needed (Node 18+)
```

`tests/noTableCreation.test.js` fails the build if any code tries to create, alter or drop a table,
dataset, view, Sheet tab or column.

## Other handoffs

- **Extra Ivanti fields** (Owner Team, Status…): [IVANTI_INTEGRATION.md](IVANTI_INTEGRATION.md)
- **Vertex AI classification**: [VERTEX_INTEGRATION.md](VERTEX_INTEGRATION.md)
