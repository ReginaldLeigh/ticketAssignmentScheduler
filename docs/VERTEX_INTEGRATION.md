# Vertex AI integration (for the developer who adds it)

## Where the code goes

**One function: `classifyTicket_(payload)` in `src/Vertex.gs`.** Nothing else needs to change.

```js
/**
 * @param {VertexTicketPayload} payload
 * @return {{mailboxId:string, confidence:number, rationale:string}|null}
 */
function classifyTicket_(payload) {
  // TODO(Vertex): call Vertex here.
  return null;
}
```

- Return `null` if you can't classify the ticket. It stays `pending` in `vertex_queue` and shows in
  the **Unrouted queue** page.
- `mailboxId` **must** be one of `payload.candidate_mailboxes[].mailbox_id`. Anything else is
  rejected and the ticket is marked `failed`.
- `confidence` is 0–1. Results below `DEVELOPER_SETTINGS.VERTEX_MIN_CONFIDENCE` in
  `src/QueryConfig.gs` (default 0.7) are marked `manual_review` for an admin to check. They're never assigned automatically.

## When it's called

During each assignment run, for tickets that match **no rule on any team** and are **not a follow-up**
of an earlier ticket on any team. A classified ticket joins the team that owns the chosen mailbox,
then goes through that team's ±1 balancer and Ivanti update with `routing_method = 'vertex'`.
You only choose the mailbox, never the employee or the team.

**Candidates are only mailboxes with no rules.** Teams set these up on purpose: a mailbox with a name
and description but no search criteria means "let Vertex decide". Mailboxes with rules are never
offered. If no team has a rule-less mailbox, `candidate_mailboxes` is empty, Vertex isn't called,
and the ticket goes to the shared queue.

## Payload (`buildVertexPayload_`, stored in `vertex_queue.payload_json`)

```json
{
  "ticket_id": "4517",
  "ivanti_rec_id": "9F1C…",
  "subject": "Charged twice for March",
  "description": "First 4,000 characters of the Ivanti description field",
  "category": "Billing",
  "subcategory": "Payments",
  "created_at": "2026-11-16T13:05:00Z",
  "fields": { "…every field in QueryConfig ivanti.selectFields…": "" },
  "candidate_mailboxes": [
    { "mailbox_id": "uuid", "name": "Payments triage", "description": "Payment questions with no rule",
      "team_id": "payments", "team_name": "Payments" }
  ]
}
```

Candidates come from every team, so a model can weigh the team as well as the mailbox. Mailbox
descriptions are edited by each team's admins on the Mailboxes page. Ask them to write descriptions that
help the model, such as what kinds of tickets belong in each mailbox.

## Calling Vertex from Apps Script

1. Add the scope `https://www.googleapis.com/auth/cloud-platform` to `src/appsscript.json`.
2. Put the project, region and model in Script Properties (for example `VERTEX_PROJECT`,
   `VERTEX_LOCATION`, `VERTEX_MODEL`).
3. Call the endpoint with `UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json',
   headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, payload: JSON.stringify(body),
   muteHttpExceptions: true })`. Ask for a JSON answer containing `mailboxId`, `confidence` and `rationale`.
4. Keep each call well under a few seconds. A run handles up to ~100 tickets and has a 6-minute limit.

## Tickets queued before Vertex existed

Run `processVertexQueue()` from the editor once your function works, or add a trigger for it. It
re-tries every `pending` row in the shared queue, gives each confident answer to the team that owns
the chosen mailbox, and marks the rest `manual_review`. It uses
the same run lease, so it never overlaps an assignment run.

## Rules you must keep

- **Never create, alter or drop tables** (BigQuery or Sheets). Use `BQ.query()` in `BigQuery.gs`
  for any BigQuery access. It only allows `SELECT`, `INSERT` and `MERGE`.
- Run `npm test` before deploying. `tests/noTableCreation.test.js` covers `Vertex.gs` too.
