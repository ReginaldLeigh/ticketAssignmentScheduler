# Ticket Assignment Scheduler

A Google Apps Script web app that schedules employees onto support mailboxes for the week and assigns
Ivanti tickets to them automatically. Several teams can use it side by side, each seeing only its own
people, mailboxes and schedule.

- **Teams and roles:** a developer lists each team and its managers in `src/QueryConfig.gs`.
  - **Managers** do everything admins can, and are the only ones who can add or remove admins.
  - **Admins** edit their team's schedule, mailboxes, rules, roster and team settings.
  - **Employees** view their team's schedule and mailboxes.
  - A person is on one team at a time, and every role can click **Run now** for their own team.
- **Weekly schedule:** place people on mailboxes day by day, or use **Schedule a range** to add or
  remove someone for a week or more at once (up to 92 days), with a preview first.
- **Mailboxes & rules:** each team names its mailboxes and sets the conditions that route a ticket to
  each one (for example *Category equals Billing and IncidentNumber is between 4000 and 5000*). Teams
  are checked in the order they're listed; the first matching rule wins. A mailbox with no rules is
  one Vertex AI can choose.
- **Roster:** admins enter only a name and work email. The app finds the person's Ivanti ID with the
  developer's lookup function, flags anyone it can't find, and never shows the ID in the browser.
- **Automatic assignment:** each team runs at its own times (default 6:00 AM and 1:00 PM on weekdays).
  - Follow-ups (subjects that closely match an earlier ticket) go back to the earlier owner, even if
    they aren't scheduled that day. A follow-up that matches no rule joins the earlier ticket's team.
  - New tickets go to a random scheduled person linked to Ivanti, keeping everyone in the mailbox
    within ±1. Follow-ups don't count toward this.
  - The Owner is set in Ivanti.
  - A ticket whose mailbox has nobody linked scheduled waits in that **team's queue**. A ticket no
    team could place goes to Vertex (added later by a developer), then to the **shared queue**, which
    every team can see; the first team to take a ticket gets it.
- **Safe for simultaneous use:** short locks, version checks with "someone else changed this" prompts,
  duplicate-proof schedule edits, a full audit trail, and pages that refresh on their own.
- **Never creates tables:** a developer creates every BigQuery table and Sheet tab (see
  [docs/SCHEMA.md](docs/SCHEMA.md)). This is enforced at runtime and by the unit tests.

## Start here

| If you are… | Read |
|---|---|
| The developer setting it up | [docs/DEVELOPER_SETUP.md](docs/DEVELOPER_SETUP.md) → [docs/SCHEMA.md](docs/SCHEMA.md) |
| The plan and the latest change request | [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md), [docs/CHANGE_REQUEST_2026-11-16.md](docs/CHANGE_REQUEST_2026-11-16.md) |
| Adding the Ivanti employee lookup or more Ivanti fields | [docs/IVANTI_INTEGRATION.md](docs/IVANTI_INTEGRATION.md) |
| Adding Vertex AI | [docs/VERTEX_INTEGRATION.md](docs/VERTEX_INTEGRATION.md) |
| Just looking at the app | Open `preview/demo.html` (build it with `npm run demo`) |

## Layout

```
src/                  Apps Script project (clasp rootDir)
  QueryConfig.gs      TEAMS, DEVELOPER_SETTINGS, all Ivanti/BigQuery settings, SQL, REQUIRED TABLE notes
  BigQuery.gs         Only BigQuery caller: SELECT/INSERT/MERGE only, blocks table creation
  Store.gs            Only Sheet caller: locks, versions, ids, request ids, team scoping, audit
  SchemaCheck.gs      Read-only check that the developer-created tables exist
  Pipeline.gs         One team's assignment run + manual reassign / queue resolve
  Rules.gs  Subject.gs  FollowUp.gs  Balancer.gs  Ivanti.gs  Writeback.gs  Vertex.gs
  Triggers.gs  Lease.gs  Config.gs  WebApp.gs  Errors.gs
  html/               Index, Styles, App (single-page UI)
tests/                node:test suites with Apps Script mocks (npm test)
tools/                condense.py (single-file build in dist/), build_demo.py (preview/demo.html)
docs/                 Setup, schema and handoff guides
```

## Tests

```bash
npm test            # source files
npm run test:dist   # the single-file build
```

There are 95 tests, and they need no dependencies (Node 18+). They cover table-creation enforcement,
team isolation and roles, the Ivanti lookup (including that IDs never reach the browser), rules and
routing order, subject matching, the ±1 balancer, the team and shared queues, simultaneous edits, the
run lease and schedule, and end-to-end runs.
