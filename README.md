# Ticket Assignment Scheduler

A Google Apps Script web app that schedules employees onto support mailboxes for the week and assigns
Ivanti tickets to them automatically.

- **Weekly schedule:** admins place people on mailboxes day by day; everyone in the organization can
  view who is where.
- **Mailboxes & rules:** admins name mailboxes and define the conditions that route a ticket to each
  one (for example *Category equals Billing and IncidentNumber is between 4000 and 5000*), checked in
  priority order.
- **Automatic assignment:** runs at 6:00 AM and 1:00 PM on weekdays, and anyone can click **Run now**.
  - Follow-ups (subjects that closely match an earlier ticket) go back to the earlier owner, even if
    they aren't scheduled that day.
  - New tickets go to a random scheduled person, keeping everyone in the mailbox within ±1. Follow-ups
    don't count toward this.
  - The Owner is set in Ivanti.
  - Tickets that match no rule wait in the **Unrouted queue**, with their data ready for Vertex AI,
    which a developer adds later.
- **Safe for simultaneous use:** short locks, version checks with "someone else changed this" prompts,
  duplicate-proof schedule edits, a full audit trail, and pages that refresh on their own.
- **Never creates tables:** a developer creates every BigQuery table and Sheet tab (see
  [docs/SCHEMA.md](docs/SCHEMA.md)). This is enforced at runtime and by the unit tests.

## Start here

| If you are… | Read |
|---|---|
| The developer setting it up | [docs/DEVELOPER_SETUP.md](docs/DEVELOPER_SETUP.md) → [docs/SCHEMA.md](docs/SCHEMA.md) |
| Adding Vertex AI | [docs/VERTEX_INTEGRATION.md](docs/VERTEX_INTEGRATION.md) |
| Adding Ivanti fields | [docs/IVANTI_INTEGRATION.md](docs/IVANTI_INTEGRATION.md) |

## Layout

```
src/                  Apps Script project (clasp rootDir)
  QueryConfig.gs      ALL Ivanti/BigQuery settings, SQL, table names, REQUIRED TABLE notes
  BigQuery.gs         Only BigQuery caller: SELECT/INSERT/MERGE only, blocks table creation
  Store.gs            Only Sheet caller: locks, versions, ids, request ids, audit
  SchemaCheck.gs      Read-only check that the developer-created tables exist
  Pipeline.gs         One assignment run + manual reassign / resolve
  Rules.gs  Subject.gs  FollowUp.gs  Balancer.gs  Ivanti.gs  Writeback.gs  Vertex.gs
  Triggers.gs  Lease.gs  Config.gs  Backfill.gs  WebApp.gs  Errors.gs
  html/               Index, Styles, App (single-page UI)
tests/                node:test suites with Apps Script mocks (npm test)
docs/                 Setup, schema and handoff guides
```

## Tests

```bash
npm test
```

There are 70 tests, and they need no dependencies (Node 18+). They cover table-creation enforcement,
rules, subject matching, the ±1 balancer, simultaneous edits, the run lease and schedule, end-to-end
runs, and permissions.
