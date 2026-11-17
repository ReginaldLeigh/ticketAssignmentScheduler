/**
 * Vertex.gs — Vertex AI handoff (to be implemented by a developer later).
 *
 * WHERE THE VERTEX CODE GOES: implement classifyTicket_() below. Nothing else needs to change.
 * See docs/VERTEX_INTEGRATION.md for the full contract, OAuth scope and testing steps.
 *
 * Flow today:
 *   • A ticket that matches no team's rules and is not a follow-up is offered to Vertex, which
 *     chooses among the mailboxes that have a NAME BUT NO RULES (across all teams, A3).
 *   • classifyTicket_() returns null today, so those tickets go to the SHARED queue, which every
 *     team's managers and admins see; any of them can pull a ticket into their own mailbox.
 *   • processVertexQueue() re-tries pending rows (run it from the editor or a trigger once
 *     classifyTicket_() is implemented, to classify tickets queued earlier).
 * Vertex code must use BigQuery.gs for any BigQuery access and must not create tables (D23).
 */

/**
 * Builds the structured payload Vertex will read. Stored in vertex_queue.payload_json.
 * @return {VertexTicketPayload}
 */
function buildVertexPayload_(ticket, snapshot) {
  return {
    ticket_id: ticket.ticketId,
    ivanti_rec_id: ticket.recId,
    subject: ticket.subject || '',
    description: String(ticket.description || '').slice(0, 4000),
    category: ticket.category || '',
    subcategory: ticket.subcategory || '',
    created_at: ticket.createdAt || '',
    fields: ticket.fields || {},
    // Only rule-less mailboxes are Vertex candidates (A3). Each carries its team.
    candidate_mailboxes: Rules.ruleless(snapshot).map((c) => ({ mailbox_id: c.mailbox.id, name: c.mailbox.name,
      description: c.mailbox.description || '', team_id: c.teamId, team_name: c.teamName })),
  };
}

/**
 * TODO(Vertex): implement.
 * @param {VertexTicketPayload} payload  built by buildVertexPayload_()
 * @return {{mailboxId:string, confidence:number, rationale:string}|null}
 *         null = could not classify → the ticket stays 'pending' in vertex_queue.
 *         mailboxId MUST be one of payload.candidate_mailboxes[].mailbox_id.
 */
function classifyTicket_(payload) { // eslint-disable-line no-unused-vars
  return null;
}

const Vertex = {
  /** Validates a classifier result against the candidate list. */
  classify(payload) {
    let res = null;
    try { res = classifyTicket_(payload); } catch (e) { return { error: String(e.message || e) }; }
    if (!res) return null;
    const ok = payload.candidate_mailboxes.some((m) => m.mailbox_id === res.mailboxId);
    if (!ok) return { error: 'Vertex returned a mailbox that is not in the candidate list.' };
    return { mailboxId: res.mailboxId, confidence: Number(res.confidence) || 0, rationale: String(res.rationale || '').slice(0, 2000) };
  },
};

/**
 * Re-try every 'pending' vertex_queue row. Developer-run (editor) or trigger, after
 * classifyTicket_() is implemented. Uses the same run lease as assignment runs.
 */
function processVertexQueue() {
  return Pipeline.processQueue({ triggeredBy: 'system' });
}
