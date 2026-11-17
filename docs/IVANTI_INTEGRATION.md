# Ivanti integration

## What the app does in Ivanti

- **Reads** Incidents that match `QUERY_CONFIG.ivanti.newIncidentsFilter`, oldest first, in pages.
  Ivanti is the only ticket source.
- **Sets the Owner** of each assigned Incident, and nothing else. Updates are sent in batches of 25.
  Failures are retried on later runs, up to `DEVELOPER_SETTINGS.WRITEBACK_MAX_ATTEMPTS`, and admins
  see them on the Assignment Log, where they can click **Retry update**.
- **Looks up each person's Ivanti ID** from their work email, using your existing lookup function
  (below). Admins only enter a name and email; they never see or type the ID.

Every URL, filter and field name is in `src/QueryConfig.gs → QUERY_CONFIG.ivanti`. The API key is the
Script Property `IVANTI_API_KEY`.

## Employee lookup: where to drop your function

Paste your existing function into **`lookupIvantiEmployee_(email)`** at the bottom of `src/Ivanti.gs`:

```js
function lookupIvantiEmployee_(email) {
  // TODO(Ivanti-lookup): paste the existing lookup here.
  // Return the JSON Ivanti sends back (an object, or the raw JSON string). Return null if not found.
  return null;
}
```

Then, in `QUERY_CONFIG.ivanti.employeeLookup`:

| Setting | What to put |
|---|---|
| `enabled` | `true` once the function is in place |
| `idPath` | Where the ID sits in the returned JSON, as a dotted path. `'RecId'` for `{ "RecId": "…" }`; `'value.0.RecId'` for an OData list like `{ "value": [ { "RecId": "…" } ] }` |

How the app uses it:

- It runs when an admin adds someone or changes their email, when an admin clicks **Check again** on
  the Roster, and at the start of each run for anyone not yet linked. Lookups run before the app
  takes its lock, so a slow Ivanti call never blocks other people's edits.
- The result is `found` (ID saved to `Employees.ivanti_owner_id`), `not_found` (empty result or no
  value at `idPath`) or `error` (the function threw). The app never throws on a failed lookup.
- When someone isn't found, the admin sees a notice that stays until dismissed, the Roster marks them
  **Not found in Ivanti**, and the schedule marks them **Not linked to Ivanti**. They can still be
  scheduled, but they get no tickets. If nobody linked is scheduled on a mailbox, its tickets wait in
  the team's queue.
- The ID never reaches the browser, and the AuditLog shows it as `[hidden]`.

## Sending more fields (Owner Team, Status, …)

Everything sent to Ivanti is built in **one function**, `buildOwnerPatch_()` in `src/Writeback.gs`:

```js
function buildOwnerPatch_(assignment) {
  return {
    Owner: assignment.employee.ivanti_owner_id,
    // TODO(Ivanti-fields): add OwnerTeam / Status / other required fields here.
  };
}
```

`assignment` contains `ticketId`, `recId`, `employee` (the Roster row) and `mailbox` (the Mailboxes row).

**If the value depends on the mailbox** (for example each mailbox has its own Owner Team):

1. Add a column, such as `ivanti_owner_team`, to the right of the existing headers on the **Mailboxes**
   tab. You add it by hand; the app never adds columns.
2. Add `ivanti_owner_team: 'string'` to `REQUIRED_SHEET_TABS.Mailboxes.columns` in `QueryConfig.gs`,
   so the app reads it and the setup check requires it.
3. Use it in the function: `OwnerTeam: assignment.mailbox && assignment.mailbox.ivanti_owner_team`.
4. Optionally add a field to the mailbox form in `src/html/App.html → editMailbox()` and save it in
   `apiSaveMailbox()` in `WebApp.gs`. Until then, fill the column in the Sheet; the
   app picks it up on the next run (open pages show it after a reload).

## Testing a change safely

1. Run `npm test`. `tests/teams.test.js` covers the lookup, including "not found" and errors.
2. Use **Run now** with **Dry run** ticked: nothing is sent to Ivanti, so you can check routing.
3. To test the update itself, point `newIncidentsFilter` at a single test Incident, for example
   `IncidentNumber eq 99999`, and run once without dry run.
