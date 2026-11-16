# Ivanti integration

## What the app does in Ivanti

- **Reads** Incidents that match `QUERY_CONFIG.ivanti.newIncidentsFilter`, oldest first, in pages.
  Ivanti is the only ticket source.
- **Sets the Owner** of each assigned Incident, and nothing else. Updates are sent in batches of 25.
  Failures are retried on later runs, up to **Settings → Ivanti update retries**, and admins see
  them on the Assignment Log, where they can click **Retry update**.

Every URL, filter and field name is in `src/QueryConfig.gs → QUERY_CONFIG.ivanti`. The API key is the
Script Property `IVANTI_API_KEY`.

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
   `apiSaveMailbox()` in `WebApp.gs`. Until then, fill the column in the Sheet and click
   **Settings → Refresh after manual Sheet edit**.

## Testing a change safely

1. Run `npm test`.
2. Use **Run now** with **Dry run** ticked: nothing is sent to Ivanti, so you can check routing.
3. To test the update itself, point `newIncidentsFilter` at a single test Incident, for example
   `IncidentNumber eq 99999`, and run once without dry run.
