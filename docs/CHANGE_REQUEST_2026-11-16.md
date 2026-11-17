# Change request — 2026-11-16

**Status:** PLAN v3, **APPROVED AND BUILT** (2026-11-17). Folded into implementation plan v12 (`claude/implementation-plan.md`). The code is on GitHub (`main`).
**Applies to:** the built app (implementation plan v11).

## Build outcome

| # | Change | Result |
|---|---|---|
| 1 | Cancel button in dark mode | Fixed. Dialogs and buttons keep light colours with dark text; checked with dark mode forced. |
| 2 | Schedule a range | Built: **Schedule a range** button and a **Range…** button per mailbox, with shortcuts, day picks, Add or Remove, a live preview and a 92-day limit. Saves all days or none. |
| 3 | Developer settings | `DEVELOPER_SETTINGS` in `QueryConfig.gs`, validated by the setup check. "Refresh after manual Sheet edit" removed. Run times and days stay admin-editable per team. |
| 4 | Ivanti lookup | `lookupIvantiEmployee_()` drop-in point in `Ivanti.gs`, with `ivanti.employeeLookup.idPath`. Roster takes name and email only. Lasting notice, Roster banner and status, **Check again**, schedule flag. IDs never reach the browser and show as `[hidden]` in the change history. |
| 5 | Managers, admins, employees, teams | `TEAMS` in `QueryConfig.gs`; admins added by managers in **Team settings**; one team per person; full isolation in the Store and API; routing, follow-ups, Vertex candidates, team queue and shared queue as in §6–§7. |

- **Tests:** 95 pass (26 new in `tests/teams.test.js`), against both the source and the single-file build.
- **Docs updated:** `README.md`, `docs/SCHEMA.md`, `docs/DEVELOPER_SETUP.md`, `docs/IVANTI_INTEGRATION.md`, `docs/VERTEX_INTEGRATION.md`.
- **Demo:** republished with two teams and a person switcher (Billing manager, Billing admin, Billing employee, Payments manager). It now builds to `preview/demo.html`, outside `dist/`, because it bundles the test mocks.

---

## Requested changes (as given)

1. With the current colour scheme, the text of the **Cancel button in modals with a black background is not visible**. Change the font or button colour so the text is readable.
2. Let users **schedule an employee for a full week or longer in one go**.
3. **Developer-only settings move to a backend config:** Vertex confidence, Ivanti retries, Run now cooldown, follow-up threshold, minimum meaningful words, and admins. End users won't have direct access to the Google Sheet, so **remove "Refresh after manual Sheet edit"**.
4. **Admins won't have access to Ivanti IDs.** There is an existing function that takes an employee email and retrieves the employee ID from Ivanti. **Create a place for the developer to drop it in** (it returns JSON). The **Roster accepts only Employee Name and Email**.
5. **Roles are Managers, Admins and Employees.** Each manager has their own roster and admins. **Managers are configured on the backend** and see and access **only their own employees, admins, mailboxes and schedules**.

## Answers

| # | Question | Answer | What it changes |
|---|---|---|---|
| A1 | Manager vs Admin | **Same permissions, except only Managers can assign Admins, from the frontend.** | Admins are **not** backend-configured (this overrides that part of item 3). Managers stay backend-configured. |
| A2 | More than one team? | **No. A person can be on only one team at a time.** | One team per email, whether as employee, admin or manager. No team switcher. |
| A3 | How tickets reach a team | **Teams have different criteria. Mailboxes with only a name and no criteria are routed through Vertex.** | The team is decided by mailbox rules. Rule-less mailboxes are the Vertex candidates (§6). |
| A4 | Follow-ups within team | **Yes.** | Follow-ups match only the same team's history (§6). |
| A5 | Run times; ignore list and stop words | **Admin-editable. Ignore list and stop words are independent per team.** | Per-team run times and days, ignore list and stop words (§3). |
| A6 | Ivanti lookup finds no one | **Save, and notify that the user can't be found.** | §4. |
| A7 | Run now | **All roles.** | — |
| A8 | Two teams' rules both match | **The team listed first in the developer's `TEAMS` config.** | Then mailbox priority within that team. |
| A9 | No rule match, but a follow-up of another team's ticket | **It joins the earlier ticket's team** and goes to the earlier owner. | §6 step 4. |
| A10 | Who handles tickets that no team can place | **Option B: all teams see them.** The ticket information shown is **set in the config by a developer later**. | Shared queue (§7). |

---

## 1. Unreadable Cancel button in modals

**Cause (reproduced):** in dark mode, the browser draws the dialog black with white text. The plain button keeps its white background but inherits the white text, so Cancel shows as a blank white box.

**Fix:**
- Pin the page to its light palette (`color-scheme: light`), so dialogs, dropdowns and date pickers never switch to dark.
- Give dialogs an explicit white background and dark text.
- Give the plain button an explicit dark text colour.

**Check:** screenshots of every dialog with dark mode forced, and button text contrast of at least WCAG AA (4.5:1).

---

## 2. Schedule someone for a week or longer in one go

A **Schedule a range** button on the Weekly schedule (managers and admins) opens a dialog:

| Field | Default |
|---|---|
| Employee | — (the team's roster only) |
| Mailbox | — (the team's mailboxes only; pre-filled if opened from a mailbox row) |
| From / To | Monday–Friday of the week on screen |
| Days | Mon–Fri ticked; Sat and Sun can be ticked too |
| Action | **Add**, or **Remove** to clear someone from a mailbox over a range |

- **Shortcuts:** "This week", "Next week", "Next 2 weeks", "Rest of month".
- **Live preview:** *"Adds Ana Ruiz to Refunds on 10 days. 2 are already scheduled and will be skipped. Ana is also on General billing on Tue 17."*
- **Saved in one step:** either every day is added or none are. Days already scheduled are skipped, and double-clicks are protected.
- **Limits:** at most 92 days per range.
- **Change history:** one entry per day, all sharing one request ID.

---

## 3. Settings

### Backend, developer-only (`QueryConfig.gs`)

```js
const DEVELOPER_SETTINGS = {
  SUBJECT_MATCH_THRESHOLD: 0.75,   // follow-up threshold
  SUBJECT_MIN_WORDS: 3,            // minimum meaningful words for a follow-up
  RUN_NOW_COOLDOWN_MIN: 2,
  WRITEBACK_MAX_ATTEMPTS: 5,       // Ivanti update retries
  VERTEX_MIN_CONFIDENCE: 0.7,
};
```

The setup check validates these and stops runs if one is invalid.

### Removed from the app

- the settings table for the values above;
- **Refresh after manual Sheet edit**, and the server functions behind it.

### Team settings page (per team)

| Item | Who can edit |
|---|---|
| Automatic run times and days for this team | Managers, Admins |
| Subjects that are never follow-ups (ignore list) | Managers, Admins |
| Stop words | Managers, Admins |
| **Admins of this team** | **Managers only** (admins see the list) |
| Test a subject | Read-only tool; shows the developer-set threshold |
| Change history (this team only) | View only |

**Run times per team:** each team has its own run times and days (default 06:00 and 13:00, Mon–Fri). The 10-minute ticker checks every team's slots and runs the teams that are due, each slot once per day.

---

## 4. Ivanti ID lookup by email (admins never see IDs)

**The developer's drop-in point** (in `Ivanti.gs`):

```js
/**
 * TODO(Ivanti-lookup): paste or call the existing function here.
 * @param {string} email  employee email
 * @return {Object|string} the Ivanti API's JSON for that employee (an object or a JSON string),
 *                         or null if no employee was found
 */
function lookupIvantiEmployee_(email) {
  return null;
}
```

**Config:** `ivanti.employeeLookup.idPath` names where the ID sits in the returned JSON (e.g. `'RecId'` or `'value.0.RecId'`). The app accepts an object or a JSON string, and records the result as `found`, `not_found` or `error`. Errors and timeouts never break a save or a run.

**When the lookup runs:**
- **When an employee is added, or their email changes.** It runs *before* the save's lock, so a slow Ivanti call never blocks others.
- **At the start of each run**, for active team members who aren't linked yet.
- **Check again** button on the Roster.

**Notifications when someone can't be found:**
- **When saving:** the employee is saved, and a notice stays until dismissed: *"Saved. Ivanti has no employee with the email ana.ruiz@yourco.com. Ana can be scheduled but won't receive tickets until Ivanti finds her."* If Ivanti couldn't be reached: *"Saved. Ivanti couldn't be reached to link Ana. The app will try again at the next run."*
- **On the Roster:** a banner while anyone is unlinked, plus each person's status (*Linked* / *Not found in Ivanti* / *Couldn't reach Ivanti*) and **Check again**.
- **On the schedule:** their name tags read **Not linked to Ivanti**.
- **On the Run assignment page:** *"2 scheduled people were skipped because they aren't linked to Ivanti."*

**Roster form:** Name and Email only. **The ID never leaves the server**, and a test checks this for every role.

**Sheet impact:** the developer adds `ivanti_lookup_status` and `ivanti_checked_at` columns to **Employees**.

---

## 5. Managers, Admins and Employees, with separate teams

**Model:** each manager runs a **team** with its own roster, admins, mailboxes and rules, schedule, run times, ignore list, stop words and assignment history. **One team per person.**

**Backend configuration** (developer-only). Team order matters: the first listed team wins when two teams' rules both match (A8).

```js
const TEAMS = [
  { id: 'billing',  name: 'Billing Support', managers: ['pat.manager@yourco.com'] },  // id is permanent
  { id: 'payments', name: 'Payments',        managers: ['kim.manager@yourco.com'] },
];
```

**Permissions:**

| | Manager | Admin | Employee |
|---|---|---|---|
| View the team's schedule, mailboxes and rules | ✓ | ✓ | ✓ |
| Run now (their team) | ✓ | ✓ | ✓ |
| Edit the schedule (including ranges), mailboxes, rules, roster | ✓ | ✓ | — |
| Assignment log, reassign, dry run | ✓ | ✓ | — |
| **Team queue** (their team's unassigned tickets) | ✓ | ✓ | — |
| **Shared queue** (tickets no team could place; §7) | ✓ | ✓ | — |
| Team settings (run times, ignore list, stop words) | ✓ | ✓ | — |
| **Add or remove the team's admins** | **✓** | — | — |
| Change history (team only) | ✓ | ✓ | — |

- **Anyone not on a team is refused:** *"You're not on a team in this app yet. Ask your manager to add you."*

**One team per person**, checked inside the save lock:
- Adding someone already on another team is refused: *"ana.ruiz@yourco.com is already on the Payments team. Ask that team's manager to remove them first."*
- The same person can be an admin and a rostered employee **within one team**.
- The setup check flags a manager listed under two teams.

**Enforced on the server:** every request is checked against the caller's team. Reads are filtered to that team, and writes are refused if anything they reference belongs to another team. The one deliberate exception is the shared queue (§7). Tests cover the full role × team matrix.

**Data changes (made by a developer; the app never alters tables or tabs):**

| Where | Change |
|---|---|
| Sheet tabs Mailboxes, Rules, Employees, Schedule, Admins, Settings, SubjectIgnoreList, StopWords, AuditLog | Add a `team_id` column (Settings becomes per-team) |
| BigQuery `assignments`, `runs` | Add `team_id STRING NOT NULL` |
| BigQuery `vertex_queue` | Add `team_id STRING` (NULLABLE; empty = shared queue) and `claimed_by_team STRING` |

The BigQuery tables haven't been created yet, so this only updates the DDL in `docs/SCHEMA.md`. **No new tables.** *(Approved 2026-11-17; the REQUIRED TABLE notes in the code and `docs/SCHEMA.md` are updated.)*

---

## 6. Routing with teams and Vertex

All teams' tickets come from the one Ivanti filter set by the developer.

**For each new ticket:**
1. **Rules.** Check the mailboxes that **have rules**, team by team in `TEAMS` order (A8), then by mailbox priority. The first match gives the team and mailbox.
2. **Follow-up, within that team (A4).** Compare against **that team's** history. On a match with an active owner, the ticket goes to that owner (whether or not they're scheduled today), not counted toward the split.
3. **Otherwise, balance** among the team's people scheduled today (±1).
4. **No rule matched → follow-up check across all teams.** A match **joins the earlier ticket's team** and goes to its owner (A9).
5. **Still nothing → Vertex.** Vertex chooses only among **rule-less mailboxes** (A3), across all teams. Its answer sets the team and mailbox, then step 3 balances.
6. **Vertex can't decide** (always, until a developer adds it), or there are no rule-less mailboxes → the **shared queue** (§7).

**Vertex handoff changes (`docs/VERTEX_INTEGRATION.md`):**
- `candidate_mailboxes` lists only rule-less mailboxes, each with `team_id` and `team_name`.
- No candidates → Vertex isn't called.
- Until Vertex exists, rule-less mailboxes get tickets only through follow-ups or from the queues. The Mailboxes page labels them *"No rules: tickets reach this mailbox through Vertex"*.

**Runs with per-team times:**
- A team's run fetches new tickets and routes all of them as above, so precedence is the same whichever team runs. It assigns only the tickets that land in the teams being run.
- Tickets for other teams wait in Ivanti for those teams' runs. They aren't placed in any queue.
- **Run now** runs the clicking person's team. One run at a time across the app.

---

## 7. Unrouted tickets: team queues and the shared queue

**When a ticket ends up unrouted:**

| Situation | Team known? | Goes to |
|---|---|---|
| A mailbox was matched, but **nobody on that team is scheduled** on it today | Yes | **That team's queue** |
| A mailbox was matched, but **everyone scheduled can't receive tickets** (not linked to Ivanti) | Yes | **That team's queue** |
| **No rule matched, not a follow-up, and Vertex couldn't place it.** Today that's every such ticket. After Vertex exists: no answer, an error, low confidence, or no rule-less mailboxes. | No | **Shared queue** |

**Team queue:** visible only to that team's managers and admins. They fix the schedule or assign someone by hand, as today.

**Shared queue (A10, option B):**
- **Every team's managers and admins see it** on the Unrouted queue page, in its own section: *"Tickets no team's rules could place"*.
- Any of them can **pull a ticket into one of their own team's mailboxes**. The app then balances it among that team's scheduled people (or a chosen team member) and sets the Owner in Ivanti.
- **Two teams pulling the same ticket at once:** the first wins. The second sees *"Payments already took this ticket."* This uses the existing per-ticket version check, so a ticket can never be assigned twice.
- When a ticket is pulled, the queue records which team took it (`claimed_by_team`), and the change history notes who pulled it.
- **Employees don't see either queue**, as today.

**What ticket information is shown (set by a developer later):**

```js
// QueryConfig.gs — TODO(dev): choose which ticket fields every team may see in the shared queue.
sharedQueue: {
  visibleFields: ['ticketId', 'createdAt'],   // placeholder until the developer decides
},
```

- Only the listed fields are sent to the browser. **The server strips everything else**, so the full ticket never reaches other teams.
- The placeholder shows just the **ticket number and when it arrived**. Teams can still open the ticket in Ivanti by its number.
- The developer can add, for example, `'subject'`, `'category'` or any field from `ivanti.selectFields`.
- A test checks that no other fields reach the browser.

---

## 8. Order of work

1. **Modal fix** (§1).
2. **Developer settings** (§3).
3. **Teams, roles and one-team-per-person** (§5), with per-team settings and run times.
4. **Routing, Vertex candidates, team queues and the shared queue** (§6, §7).
5. **Ivanti lookup and notifications** (§4).
6. **Range scheduling** (§2).
7. **Tests, docs, single-file build and demo.**
   - The demo gains Manager / Admin / Employee views across **two teams**, a rule-less "Vertex" mailbox, an unlinked employee, and shared-queue tickets that either team can pull.

All seven steps are done.
