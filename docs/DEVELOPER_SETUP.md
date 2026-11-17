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

### Teams and managers

List every team in `TEAMS`. Order matters: when a ticket matches rules on more than one team, the
team listed first gets it.

```js
const TEAMS = [
  { id: 'billing',  name: 'Billing Support', managers: ['pat.morgan@yourco.com'] },
  { id: 'payments', name: 'Payments',        managers: ['kim.tran@yourco.com'] },
];
```

- `id` is stored in every row (`team_id`). Don't change it once a team has data.
- Managers can do everything admins can, and are the only ones who can add or remove admins (in
  **Team settings**). Admins and employees are added in the app, not here.
- A person can be on one team only. A manager listed on two teams fails the setup check.

### Developer-only settings

`DEVELOPER_SETTINGS` holds the values admins can't change. They apply to every team:

| Setting | Default | What it does |
|---|---|---|
| `SUBJECT_MATCH_THRESHOLD` | `0.75` | How similar a subject must be to count as a follow-up (0–1) |
| `SUBJECT_MIN_WORDS` | `3` | Subjects with fewer meaningful words are never follow-ups |
| `RUN_NOW_COOLDOWN_MIN` | `2` | Minutes a team waits between Run now clicks |
| `WRITEBACK_MAX_ATTEMPTS` | `5` | Tries to set the Owner in Ivanti before giving up |
| `VERTEX_MIN_CONFIDENCE` | `0.7` | Vertex answers below this go to the queue for review |

Run times and days stay in the app: each team's admins set them in **Team settings**.

### Shared queue

`sharedQueue.visibleFields` lists the ticket fields every team can see for tickets no team could
place (default `['ticketId', 'createdAt']`). Use names from `ivanti.fieldMap`. Keep it short:
these tickets are visible across teams.

### Ivanti employee lookup

Paste your existing lookup function into `lookupIvantiEmployee_(email)` at the bottom of
`src/Ivanti.gs`, then set `ivanti.employeeLookup.enabled: true` and `idPath` to where the ID sits in
what it returns (see [IVANTI_INTEGRATION.md](IVANTI_INTEGRATION.md)). Until then, nobody can be linked
and nobody receives tickets; the setup check says so.

### Everything else

Every value marked `TODO(dev)`:

| Setting | What to put |
|---|---|
| `ivanti.baseUrl` | Your tenant, e.g. `https://yourco.ivanticloud.com` |
| `ivanti.newIncidentsFilter` | OData filter for Incidents ready to assign (default: no owner, status Logged) |
| `ivanti.selectFields` / `fieldMap` | Field names in your tenant. `selectFields` are also the fields admins can use in rules. |
| `ivanti.updateMethod` | `patch` or `put`, depending on your tenant |
| `bigQuery.projectId`, `appDataset`, `location` | From step 1 |
| `bigQuery.*Table` | Table names, if you used different ones |
| `bigQuery.ticketHistory` | Leave `table: ''` to use `assignments`, or point it at another existing history table |
| `sheet.spreadsheetId` | From step 1 |

Then **Project Settings → Script Properties** → add `IVANTI_API_KEY`. It's sent as
`Authorization: rest_api_key=<key>`; change `authHeaderTemplate` if your tenant expects a different format.

All SQL lives in the `SQL` object in the same file. Only `SELECT`, `INSERT` and `MERGE` are allowed.

## 4. Deploy the web app

**Deploy → New deployment → Web app**: *Execute as: Me*, *Who has access: Anyone within your domain*.
`appsscript.json` already sets this. Open the URL as one of the managers and check
**Run assignment → Check setup**: it must say *Everything is set up*.

## 5. Switch on automatic runs

On the **Run assignment** page, click **Switch on automatic runs**, or run `installTriggers()` in the
editor. This installs one 10-minute ticker for all teams. Each team runs separately, at its own times: by
default **6:00 AM and 1:00 PM, Monday to Friday** (America/New_York). Each team's admins can change
their times and days in **Team settings**.

## 6. Shadow week, then go live

1. For a week, each team's admins use **Run now** with **Dry run** ticked. A run only handles that team's tickets. Nothing changes in Ivanti, and dry-run
   rows are ignored by history, balancing and the duplicate check.
2. Compare the Assignment Log (tick *Include dry runs*) with how tickets were really assigned. Use
   **Team settings → Test a subject** to check matches, and adjust `SUBJECT_MATCH_THRESHOLD` if needed.
3. Switch on automatic runs (step 5).

The ticket history starts empty: follow-ups are found once the app has assigned tickets.

## Tests

```bash
npm test          # node --test; no packages needed (Node 18+)
npm run test:dist # the same tests against the single-file build in dist/
npm run demo      # builds preview/demo.html, a click-through demo with sample data
```

`preview/demo.html` bundles the test mocks and is for review only. Never deploy it.

`tests/noTableCreation.test.js` fails the build if any code tries to create, alter or drop a table,
dataset, view, Sheet tab or column.

## Other handoffs

- **Extra Ivanti fields** (Owner Team, Status…): [IVANTI_INTEGRATION.md](IVANTI_INTEGRATION.md)
- **Vertex AI classification**: [VERTEX_INTEGRATION.md](VERTEX_INTEGRATION.md)
