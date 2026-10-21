# Infrastructure

**Implemented** = code and configuration exist in this repository. **Provisioned** = actually created in Chat360's Cloudflare/Microsoft accounts. **Nothing is provisioned yet**: no Cloudflare account or Microsoft tenant access was available while building.

## Architecture

```
Browser (React SPA)
   │  same origin: https://<app>/...
   ▼
Cloudflare Pages ── static SPA (apps/web/dist) + _headers (CSP, HSTS)
   │  /api/*  → Pages Function (functions/api/[[path]].ts)
   │            service binding "API"
   ▼
API Worker (apps/api, Hono) ──────────────┬─► Coordinator Durable Object (SQLite)
   │  fetch() + scheduled() (Cron)         │     sessions, rate limits, leases,
   │                                       │     idempotency memos, job ledger
   │                                       └─► Workers Analytics Engine (product events)
   ▼
Microsoft Graph
   ├─ app-only:  Sites.Selected → SharePoint/OneDrive library (project.json, _system/*.json, *.xlsx, workbook API)
   │             Mail.Send (restricted) → notification mailbox
   └─ delegated: User.Read (sign-in), Mail.Send + Calendars.ReadWrite (as the user, on consent)
```

No VPS, container, database server, object storage or paid third-party service is used.

**Deployment shapes (ADR-020):** the diagram shows the two-project setup (Pages + API Worker). Alternatively the root `wrangler.toml` deploys a single Worker, `chat360pm`, that serves the same SPA as static assets and runs the same API code for `/api/*`; this is what a Git-connected Workers Build uses.

## Components

| Component         | Implementation                                                                                     | Status                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------- |
| SPA hosting       | Cloudflare Pages project `chat360-ops-web` (`apps/web/wrangler.toml`)                              | Implemented, not provisioned                                    |
| API proxy         | Pages Function → service binding `API` (preview → staging Worker, production → production Worker)  | Implemented                                                     |
| API               | Worker `chat360-ops-api[-staging                                                                   | -production]` (`apps/api/wrangler.toml`), `workers_dev = false` | Implemented; bundles (`wrangler deploy --dry-run`) and boots in `workerd` |
| Scheduling        | Cron Triggers `30 3 * * *`, `30 13 * * *`, `15 * * * *` (UTC)                                      | Implemented                                                     |
| Coordination      | Durable Object `Coordinator` (SQLite backend, migration `v1`), single named instance `global`      | Implemented; exercised in `workerd`                             |
| Product analytics | Analytics Engine dataset `chat360_ops_events`                                                      | Implemented (falls back to logs if unbound)                     |
| Logs              | Workers Logs (`[observability] enabled`, 100% head sampling)                                       | Implemented                                                     |
| Storage           | SharePoint/OneDrive drive `GRAPH_DRIVE_ID` under `ONEDRIVE_ROOT_PATH`                              | Implemented; **site/library to be chosen by IT**                |
| Identity          | Entra ID app registration (single tenant, confidential, redirect `<APP_ORIGIN>/api/auth/callback`) | Pending                                                         |
| CI/CD             | GitHub Actions `ci.yml` (checks) and `deploy.yml` (manual, gated)                                  | Implemented; deploy needs secrets                               |

## Data ownership and layout

All business data is owned by Chat360 and stored in its tenant:

```
<ONEDRIVE_ROOT_PATH>/
  _system/
    directory.json            employees (by Entra oid), roles, status, onboarding, identity history
    config.json               timezone, working days, holidays, delay reasons, escalation levels/SLAs,
                              destinations, support contact, disabledJobs
    projects-index.json       one summary per project (for lists, access checks, portfolio views)
    support.json              support requests
    account-requests.json     deactivation requests
    audit/YYYY-MM.json        organisation audit log
  <destination path, e.g. Projects>/
    <PRJ-ID> <Client> - <Project>/
      project.json            system of record for the project
      <Client> - <Project> - Tracker.xlsx   official Excel tracker (kept in sync)
      (SOW, BRD, bot flows… managed by people; linked from the app)
```

`project.json` holds team and team history, finance figures, tasks (with revisions, confirmations, comments, history), API dependencies, escalations (with level history and notification records), transfers (with snapshot, execution steps and history), document links, communication references, workbook sync state, project audit and idempotency keys.

The Coordinator holds **no business records** (ADR-003). Losing it signs everyone out and resets counters.

## Consistency model

- Each document write is a compare-and-swap on the OneDrive eTag (ADR-004). Multi-document operations (project + index, transfers) are ordered, recorded and idempotent; the daily `reconcile` job rebuilds index entries from project documents and recovers projects missing from the index.
- Excel is a projection of `project.json`, synchronised one-way with conflict detection (ADR-006). `workbook.syncedRevision` vs. `revision` tells whether Excel is behind.
- Read-mostly system documents (directory, config, index) are cached per Worker isolate for 30 s.

## Scheduled processing

| Cron (UTC)    | Default local time (IST) | Jobs                                                                                                                   |
| ------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `30 3 * * *`  | 09:00                    | `morning_reminders` (digest per owner, once per day), weekly sheet roll-over sync for all active projects, `reconcile` |
| `30 13 * * *` | 19:00                    | `daily_confirmation` (no-response marks, escalations, notifications, sync) — working days only                         |
| `15 * * * *`  | hourly                   | `maintenance` (SLA escalation ladder, notification retries, workbook sync retries, due transfers, Coordinator purge)   |

Jobs run under a 15-minute lease, record a run in the job ledger (Admin → Scheduled jobs) and can be disabled via `disabledJobs` without a deploy. If Chat360 changes the org timezone, update the cron times in `apps/api/wrangler.toml`.

## Capacity and limits

- Graph: each document read is 2 requests; a full sync ~5 requests (session, read batch, write batch(es), close) plus the document writes. Graph throttles bursts; the client honours `Retry-After` and jobs process 4 projects concurrently.
- Workers: the free plan's 50 subrequests per invocation is too low for scheduled jobs over many projects; use **Workers Paid** (higher subrequest and CPU limits). Analytics reads at most 300 project documents per request.
- Durable Object: one instance comfortably serves an internal employee population; shard by user if this ever changes.

## Secrets and configuration

See `docs/deployment.md` for every variable. Secrets: `ENTRA_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`, `COOKIE_SECRET` (Worker secrets). Non-secret vars in `wrangler.toml` per environment.

## Monitoring and recovery

- Logs: JSON lines with `requestId`, `errorId`, `job`, `projectId`; redacted (see `docs/security.md`). Useful queries: `msg = "request_error"`, `msg = "job_finished" AND level = "error"`, `msg = "workbook_sync_failed"`, `msg = "graph_retry"` (throttling), `msg = "notification_failures"`, `msg = "client_error"`, `msg = "configuration_error"`.
- **Pending:** Cloudflare notifications/alerts on Worker error rate and on these log patterns, and an uptime check on `/api/health`.
- Recovery playbooks: `docs/security.md` §Incident response and `docs/deployment.md` §Rollback and troubleshooting.

## External dependencies

Microsoft Entra ID and Graph (identity, storage, mail, calendar); Cloudflare Pages, Workers, Durable Objects, Cron Triggers, Analytics Engine; GitHub (source, Actions). npm runtime dependencies: `hono`, `jose`, `zod`, `fflate`, `react`, `react-dom`, `react-router`.

## Known limitations

1. Excel edits are not imported back into the app (conflicts are surfaced instead).
2. Folder sharing/permissions are not managed by the app; the library's permissions apply.
3. Email attachments are not supported (a tracker link can be included).
4. No live verification against Microsoft Graph or Cloudflare has been performed yet.
