# Decision Log (ADRs)

Material engineering and product decisions for the Chat360 Project Operations Platform, recorded by Claude Code.

Rules:

- Every material decision gets an `ADR-NNN` entry with the actual date.
- Accepted decisions are never silently rewritten. To change one, mark it **Superseded** and add a new ADR that references it.
- "Validation" lists only what was actually executed. External approvals (Chat360 IT, Microsoft tenant admins) are listed as **pending** until they really happen; none have happened yet.

| ID      | Title                                                                               | Status                 |
| ------- | ----------------------------------------------------------------------------------- | ---------------------- |
| ADR-001 | TypeScript monorepo: core domain + API Worker + React SPA                           | Accepted               |
| ADR-002 | Cloudflare Pages for the SPA, Worker for the API, same origin via service binding   | Accepted               |
| ADR-003 | OneDrive as system of record; Durable Object for coordination state only            | Accepted               |
| ADR-004 | Optimistic concurrency with OneDrive eTags; idempotency keys                        | Accepted               |
| ADR-005 | Generate `.xlsx` with an in-house OOXML writer                                      | Accepted               |
| ADR-006 | Excel synchronisation: keyed, non-destructive, conflict-detecting, one-way          | Accepted               |
| ADR-007 | Transfer execution as recorded, resumable steps                                     | Accepted               |
| ADR-008 | Provisional tracker schema and project templates                                    | Accepted (provisional) |
| ADR-009 | Authentication: Entra ID OIDC, server-side sessions, least-privilege Graph scopes   | Accepted               |
| ADR-010 | Authorisation: global roles + per-project access ladder; admins get no project data | Accepted               |
| ADR-011 | Scheduling with Cron Triggers, leases and idempotent jobs; admin kill switch        | Accepted               |
| ADR-012 | Notifications are at-most-once with visible outcomes                                | Accepted               |
| ADR-013 | Analytics: first-party product events + computed, rule-based delivery metrics       | Accepted               |
| ADR-014 | Monitoring and crash reporting without a paid vendor                                | Accepted               |
| ADR-015 | No paywall, purchases or "Restore Purchases"                                        | Accepted               |
| ADR-016 | Web-only distribution; no app-store submission                                      | Accepted               |
| ADR-017 | Account deactivation semantics                                                      | Accepted               |
| ADR-018 | In-memory adapters and developer sign-in for local development only                 | Accepted               |
| ADR-019 | Project finance: app record + seventh "Finance" tracker sheet                       | Accepted               |
| ADR-020 | Single-Worker deployment option (Workers static assets) for Git-connected builds    | Accepted               |

---

## ADR-001 — TypeScript monorepo: core domain + API Worker + React SPA

- **Date:** 2026-10-19
- **Status:** Accepted
- **Context:** The repository was empty (no commits, no code, no templates). A stack had to be chosen that runs on Cloudflare Workers/Pages, talks to Microsoft Graph, and is maintainable by a small internal team.
- **Requirements/constraints:** Serverless, low cost, strict typing, testable business rules, no self-hosted servers.
- **Alternatives considered:**
  1. Next.js on Cloudflare (via OpenNext) — heavier, SSR not needed for an authenticated internal tool, more moving parts on Workers.
  2. Separate repos for front and back end — duplicated types and rules.
  3. **pnpm workspace with `packages/core` (pure domain), `apps/api` (Hono Worker), `apps/web` (React + Vite SPA).**
- **Decision:** Option 3. TypeScript strict mode everywhere. `@chat360/core` has no I/O and holds every business rule (permissions, task/transfer state machines, escalation policy, Excel schema), so rules are unit-tested once and shared by API and UI.
- **Reasoning:** Business rules are the riskiest part; isolating them makes them easy to test and reason about. Hono is small and Workers-native. Vite builds a static SPA that Pages serves for free.
- **Trade-offs/risks:** The web bundle includes zod via core (~120 KB gzipped total JS). Acceptable for an internal tool; route splitting is a follow-up.
- **Rejected:** Next.js (complexity without benefit here); separate repos (drift).
- **Affected:** all packages; `docs/infrastructure.md`, `CLAUDE.md`.
- **Implementation:** `package.json`, `pnpm-workspace.yaml`, `packages/core`, `apps/api`, `apps/web`.
- **Validation performed:** `pnpm typecheck`, `pnpm lint`, unit/integration/e2e suites (see `docs/deployment.md` §Testing).
- **Follow-up:** Code-split the web bundle by route if load time matters on mobile networks.

## ADR-002 — Cloudflare Pages for the SPA, Worker for the API, same origin via service binding

- **Date:** 2026-10-19
- **Status:** Accepted
- **Context:** The brief requires Pages for the frontend and Workers for the backend. Session cookies should be `SameSite=Strict` and we want no CORS surface.
- **Alternatives:** (1) API on a separate hostname with CORS and `SameSite=None` cookies; (2) Worker routes on the Pages custom domain; (3) **a Pages Function at `functions/api/[[path]].ts` that forwards `/api/*` to the API Worker through a service binding.**
- **Decision:** Option 3.
- **Reasoning:** Same-origin requests keep cookies Strict and eliminate CORS; service bindings add no public endpoint; works for preview and production Pages environments via `apps/web/wrangler.toml`.
- **Trade-offs:** One extra (free-tier counted) Function invocation per API call. The Worker itself is deployed with `workers_dev = false` so it is reachable only through the binding (and any route Chat360 deliberately adds).
- **Affected:** `apps/web/functions`, `apps/web/wrangler.toml`, `apps/api/wrangler.toml`, `docs/deployment.md`.
- **Validation:** Function compiles (`tsc -p apps/web/functions`). **Pending:** a real Pages deployment with the binding (no Cloudflare account available in this session).

## ADR-003 — OneDrive as system of record; Durable Object for coordination state only

- **Date:** 2026-10-19
- **Status:** Accepted
- **Context:** The brief forbids a database by default and requires OneDrive/Excel as primary storage. The application still needs sessions (with encrypted Microsoft tokens), rate limits, leases to stop concurrent jobs, and short-lived idempotency memos. Background jobs must run without any user's browser or delegated token.
- **Alternatives considered:**
  1. Everything in Excel — Excel is not transactional; storing transfers/audit/history in cells is fragile.
  2. D1/PostgreSQL as primary store — violates the OneDrive-first requirement.
  3. Workers KV for sessions — eventually consistent; revocation could lag up to ~60 s.
  4. **Business records as JSON documents in OneDrive (one `project.json` per project folder, plus `_system/*.json`), the Excel tracker generated and kept in sync from them, and a single SQLite-backed Durable Object (`Coordinator`) holding only coordination state.**
- **Decision:** Option 4.
- **Reasoning:** OneDrive stays the authoritative, human-auditable store; files are visible to Chat360 in their own tenant. JSON documents give stable IDs and structure that Excel cannot. The Durable Object is strongly consistent, cheap, and its loss only signs users out and resets counters — no business data is at risk.
- **Data in OneDrive (system of record):** projects (tasks, revisions, confirmations, escalations, transfers, team history, communications refs, project audit), the employee directory and roles, org configuration, support requests, account requests, monthly org audit logs, `.xlsx` trackers.
- **Data in the Coordinator (not a system of record):** session hashes + AES-GCM-encrypted delegated tokens, rate-limit counters, leases, idempotency memos (≤24 h), last 500 job runs.
- **Storage location:** a dedicated SharePoint document library (or service-account OneDrive) granted to the app with **`Sites.Selected`**, addressed by `GRAPH_DRIVE_ID` + `ONEDRIVE_ROOT_PATH`. Which one Chat360 uses is an open question for IT (**pending**).
- **Trade-offs/risks:** Each document read costs two Graph calls (metadata + download); list views use a cached project index (`_system/projects-index.json`, 30 s per-isolate cache). Graph throttling limits throughput — fine for an internal population, documented in `docs/infrastructure.md`. Workers **Paid** plan is recommended for subrequest headroom.
- **Rejected:** Excel-as-database (no transactions, easy to corrupt); a SQL database (not requested, adds cost and a second source of truth).
- **Affected:** `apps/api/src/store`, `apps/api/src/graph/drive-store.ts`, `apps/api/src/do/coordinator.ts`.
- **Validation:** Repository layer tested with a memory store that emulates eTags/412; Coordinator exercised in `workerd` via `wrangler dev` (sessions, rate limits, leases, memo, job ledger — correct results). **Pending:** live Graph tests against a Chat360 test library.

## ADR-004 — Optimistic concurrency with OneDrive eTags; idempotency keys

- **Date:** 2026-10-19
- **Status:** Accepted
- **Context:** Several people and scheduled jobs can update the same project concurrently; OneDrive has no transactions.
- **Decision:** Every write is read-modify-write with `If-Match: <eTag>` (`PUT …:/content`); OneDrive returns 412 on a lost race and we retry the pure mutation against fresh data (up to 6 times with jittered backoff). Creates use `@microsoft.graph.conflictBehavior=fail`. Writes are skipped when nothing changed. Creation endpoints require an `Idempotency-Key`; project-level keys are recorded in the document (`appliedOperations`, bounded) and project creation keys in the Coordinator. Task edits can carry `expectedUpdatedAt` for user-visible stale-edit detection.
- **Alternatives:** locking via the Durable Object (adds a single point of coordination for every write and still needs crash recovery); last-write-wins (data loss).
- **Trade-offs:** Mutations must be deterministic functions of the document (they re-run on retry); this is enforced by keeping them in `@chat360/core`.
- **Affected:** `apps/api/src/store/repos.ts`, `apps/api/src/routes/project-helpers.ts`, `packages/core/src/context.ts`.
- **Validation:** Integration test injects two 412s and verifies the update lands without overwriting; stale `expectedUpdatedAt` returns 409; idempotent project creation tested. Graph contract test verifies `If-Match` and 412 mapping.

## ADR-005 — Generate `.xlsx` with an in-house OOXML writer

- **Date:** 2026-10-19
- **Status:** Accepted
- **Context:** The tracker needs tables, filters, formulas, date formats, data validation, conditional formatting and freeze panes, generated inside a Worker.
- **Alternatives:** SheetJS Community Edition (cannot write data validation or conditional formatting); ExcelJS (Node streams/Buffer, poor fit for Workers, large); Graph "create workbook then build it cell by cell" (dozens of throttled calls).
- **Decision:** A ~300-line SpreadsheetML writer (`packages/core/src/workbook/xlsx.ts`) using `fflate` for zipping. It writes shared strings, fixed styles, tables with calculated columns, list validation, formula conditional formatting, widths and freeze panes, in schema order.
- **Trade-offs:** We own the format code. Mitigated by tests that parse the output and by external validation.
- **Validation performed:** unit tests (sheet order, tables, formulas, validation, freeze panes, XML escaping); a generate → read-back → sync-plan round trip yields zero changes; `scripts/validate_workbook.py` opened the sample with **openpyxl** and **LibreOffice** (LibreOffice recalculated the structured-reference and `NETWORKDAYS.INTL` formulas correctly). **Pending:** open a generated file in desktop Excel and Excel for the web inside the Chat360 tenant.

## ADR-006 — Excel synchronisation: keyed, non-destructive, conflict-detecting, one-way

- **Date:** 2026-10-19
- **Status:** Accepted
- **Context:** Excel must remain the official tracker, people may edit it directly, and the brief forbids blind overwrites.
- **Decision:** After each project change the API syncs in the background (and hourly/daily jobs retry). Sync reads each Excel table once (one `$batch`, inside a workbook session) and computes a plan in `@chat360/core` (`planTableSync`):
  - rows are matched by stable key columns (Task ID, API ID, Escalation ID, Week Of + Task ID), never by position;
  - only app-managed columns are written; formula columns and user-added columns are written back exactly as read;
  - rows without an app key are never touched; blank rows may be reused; nothing is ever deleted;
  - each written row's managed values are hashed; if Excel's current values differ from both the app's desired values **and** the last hash, someone edited it in Excel → the row is reported as a **conflict** and left untouched until a manager chooses "Overwrite Excel with app values";
  - if a managed column is renamed/removed, that table is not written and a schema error is shown;
  - text columns are formatted as Text so values like WBS `1.10` are not turned into numbers.
- **Direction:** One-way (app → Excel) with conflict detection. Importing Excel edits back into the app is **not implemented** (see limitations).
- **Alternatives:** regenerate the whole file on each change (destroys user formatting/notes); two-way merge (ambiguous ownership, high risk without a clear rule set from Chat360).
- **Trade-offs:** A human edit made between our read and write (a few seconds) can still be overwritten for that one row; documented as residual risk.
- **Affected:** `packages/core/src/workbook/sync.ts`, `apps/api/src/services/workbook.ts`, `apps/api/src/graph/workbook.ts`.
- **Validation:** core tests (append, keyed patch preserving user columns/formulas, conflict, force, foreign rows, schema error); API tests (sync after confirmation, conflict then overwrite, failed writes then retry); Graph contract tests for batch/session request shapes. **Pending:** live Graph workbook API test.

## ADR-007 — Transfer execution as recorded, resumable steps

- **Date:** 2026-10-19
- **Status:** Accepted
- **Context:** A PM change touches the project document, the project index, the Excel tracker and notifications — no multi-document transaction exists.
- **Decision:** Both paths (PM request → Delivery Head approval; Delivery Head direct reassignment with explicit confirmation) produce a `TransferRequest` with a stable `TR-…` id **persisted before any execution**. Execution runs ordered, idempotent steps recorded on the transfer: `assign_pm` (required, inside the project document's CAS write), `update_index` (required), `sync_workbook` (tracked), `notify` (tracked). The transfer is `completed` only when required steps succeed; tracked steps show their own status. Interrupted executions stay `approved` with `lastError` and are resumed by the hourly job or "Retry execution". Future effective dates execute on that date.
- **Policy choices (need Chat360 confirmation):** the previous PM keeps read-only access for `formerPmAccessDays` (default 30) unless they still hold another role or own tasks; task owners never change automatically; a direct reassignment cancels any pending PM request with a note.
- **Affected:** `packages/core/src/transfer.ts`, `apps/api/src/services/transfers.ts`, `apps/api/src/routes/transfers.ts`.
- **Validation:** core tests (state machine, permissions, history preservation, idempotent re-execution, effective dates); API tests (request/approve/reject/direct, injected index failure resumed by job, no duplicate history); e2e (both paths through the UI).

## ADR-008 — Provisional tracker schema and project templates

- **Date:** 2026-10-19
- **Status:** Accepted (provisional)
- **Context:** The brief says to inspect existing tracker templates; none exist in the repository and none were provided.
- **Decision:** Implement the six sheets from the brief's column lists (`docs/product.md` §Excel tracker) and three starter plans (standard bot, integration, blank). Tables: `tblGantt`, `tblWBS`, `tblAPIs`, `tblEscalationMatrix` + `tblEscalationLog` (same sheet), `tblLastWeek`, `tblThisWeek`.
- **Risk:** Columns may not match how Chat360 teams work today.
- **Follow-up:** When Chat360 supplies its current tracker, adjust `trackerTables()` and templates in one place; existing workbooks with renamed columns surface schema errors instead of being corrupted.

## ADR-009 — Authentication: Entra ID OIDC, server-side sessions, least-privilege Graph scopes

- **Date:** 2026-10-19
- **Status:** Accepted
- **Decision:**
  - Authorization-code flow with PKCE against the Chat360 tenant authority (single tenant). The Worker is a confidential client; the ID token is verified (signature via tenant JWKS, issuer, audience, nonce, `tid`).
  - At sign-in the app calls `/me` and refuses guests (`userType != Member`, `#EXT#` UPNs) and disabled accounts; the email domain must be in `ALLOWED_EMAIL_DOMAINS` as a consistency check only — **never** as authorisation. Recommended in addition: Entra "assignment required" for the enterprise app.
  - Users are keyed by Entra object id (`oid`); name/email changes are appended to identity history.
  - Sessions: random 256-bit cookie (`__Host-…`, HttpOnly, Secure, SameSite=Strict, 12 h absolute / 8 h idle); only its SHA-256 is stored. Microsoft tokens are AES-256-GCM encrypted in the Coordinator and never reach the browser.
  - Delegated scopes at sign-in: `openid profile email offline_access User.Read`. `Mail.Send` and `Calendars.ReadWrite` are requested **incrementally** when a user first connects Outlook.
  - App-only (background) permissions: `Sites.Selected` (write on the single approved site) and `Mail.Send` restricted by an Exchange **application access policy** to one notification mailbox. Both require admin approval (**pending**).
  - First administrators are named by object id in `BOOTSTRAP_ADMIN_OIDS`.
- **Rejected:** a separate username/password system (forbidden); `Files.ReadWrite.All`/`Mail.Send` without restriction (over-privileged); trusting email from the browser.
- **Validation:** unit tests for ID-token validation (good/bad tenant, audience, issuer, nonce), employee policy, open-redirect protection, cookie flags, session hashing, revocation; production config refuses dev sign-in. **Pending:** live sign-in against the Chat360 tenant.

## ADR-010 — Authorisation: global roles + per-project access ladder; admins get no project data

- **Date:** 2026-10-19
- **Status:** Accepted
- **Decision:** Global roles (`admin`, `delivery_head`, `pm`, `tech`, `fde`, `sales_poc`, `csm`) are assigned by administrators. Per project, access is computed server-side on every request: `portfolio` (Delivery Head role) > `manager` (current PM or assigned Delivery Head) > `contributor` (team member or task owner) > `read` (former PM within the window) > `none`. Actions map to minimum levels in `packages/core/src/rbac.ts`. Administrators manage configuration and roles but get **no implicit project access**. Projects the caller cannot see return 404.
- **Validation:** core RBAC tests; API tests for 404 on hidden projects, forbidden actions, admin endpoints.

## ADR-011 — Scheduling with Cron Triggers, leases and idempotent jobs; admin kill switch

- **Date:** 2026-10-19
- **Status:** Accepted
- **Decision:** Three UTC crons (defaults assume IST): 03:30 morning reminders + weekly roll-over sync + index reconciliation; 13:30 end-of-day confirmation check and escalations; hourly maintenance (SLA ladder, notification retries, sync retries, pending transfers, purge). Each job holds a Coordinator lease; every per-project step is idempotent (escalation dedupe keys, "already marked today" checks, reminder memo per owner per day). Admins can disable any job instantly through `disabledJobs` in the org config. Scheduled execution is **not** assumed to be exactly-once.
- **Trade-offs:** Changing the org timezone does not move cron times; update `wrangler.toml` too (documented).
- **Validation:** API tests: re-running the daily job creates no duplicates; kill switch; overlap lease; reconcile restores a lost index entry; reminder dedupe.

## ADR-012 — Notifications are at-most-once with visible outcomes

- **Date:** 2026-10-19
- **Status:** Accepted
- **Decision:** Graph `sendMail` is not idempotent. Each notification is marked `sending` in the project document before the call, then `sent` (Graph returned 202 — _accepted_, not delivered), `failed` (retryable failures retried up to 5 times by the hourly job) or `not_configured`. A notification stuck in `sending` for 15 minutes becomes `unknown` and is shown, not silently resent. Email bodies are not stored.
- **Validation:** API tests for sent, failed (503) and not-configured paths.

## ADR-013 — Analytics: first-party product events + computed, rule-based delivery metrics

- **Date:** 2026-10-19
- **Status:** Accepted
- **Decision:** Product events go to **Workers Analytics Engine** (event name, role, project id, outcome, salted HMAC of the user id; no content). Client events are allow-listed. Delivery metrics are computed on request from project documents with documented definitions (`docs/prd.md` PRD-ANALYTICS-\*); ratios show `n/a` when the denominator is zero. Project health is an explicit rule set, not a score.
- **Rejected:** third-party product analytics SaaS (cost, data leaving the tenant).
- **Validation:** core tests of metric calculations; API scope tests (portfolio vs. own projects).

## ADR-014 — Monitoring and crash reporting without a paid vendor

- **Date:** 2026-10-19
- **Status:** Accepted
- **Decision:** Workers Logs (`[observability] enabled`) receive structured JSON logs with request/correlation ids, error ids, and deep redaction (tokens, cookies, bodies, notes; email local parts masked). The SPA reports `error`, `unhandledrejection` and React error-boundary crashes to `/api/client-errors` (rate limited, redacted). Admins see job runs and a health page. Alerting on log patterns is configured in the Cloudflare dashboard (**pending**: needs the account).
- **Validation:** tests for redaction and client-error endpoint; error responses carry `errorId`.

## ADR-015 — No paywall, purchases or "Restore Purchases"

- **Date:** 2026-10-19
- **Status:** Accepted
- **Context:** Internal business platform; no billing requirement was given.
- **Decision:** Do not implement a paywall, plans, purchase flows or a non-functional "Restore Purchases" button. Access is controlled by Entra sign-in and administrator-assigned roles.
- **Revisit if:** Chat360 explicitly approves a billing requirement and provider.

## ADR-016 — Web-only distribution; no app-store submission

- **Date:** 2026-10-19
- **Status:** Accepted
- **Decision:** Ship as a responsive web app. Screenshots in `docs/screenshots/` were produced from the real UI by the automated browser suite with fictional demo data (desktop and an emulated phone viewport). No native app, no store assets, nothing has been published to any app store.

## ADR-017 — Account deactivation semantics

- **Date:** 2026-10-19
- **Status:** Accepted
- **Decision:** Employees can _request_ deactivation of their access to this app (recent sign-in ≤15 min and typed email confirmation required). If they are PM of active projects the request waits in `pending_transfers`, the Delivery Head is emailed, and approval is blocked until projects are transferred. On admin approval: sessions revoked, directory status `deactivated`. Nothing else is deleted: workbooks, client documents, project history and audit are retained, and the Microsoft identity is untouched (the app has no permission to delete it, and that is HR/IT's process).
- **Validation:** API and e2e tests.

## ADR-018 — In-memory adapters and developer sign-in for local development only

- **Date:** 2026-10-19
- **Status:** Accepted
- **Decision:** `apps/api/dev/server.ts` runs the real Hono app with in-memory adapters (OneDrive store emulating eTags, workbook gateway reading our own `.xlsx`, recording mailer/fake Outlook) and a developer sign-in listing **fictional** demo users. `loadConfig` refuses `DEV_AUTH=enabled` or `STORAGE_BACKEND=memory` outside `ENVIRONMENT=development`; the dev routes are not even registered otherwise; the production Worker refuses non-Graph storage.
- **Risk:** Passing tests against in-memory adapters does **not** verify Microsoft integration. All docs state this.
- **Validation:** tests prove dev sign-in is absent when disabled and that production config rejects it; Worker booted in `workerd` fails closed (503) without configuration.

## ADR-019 — Project finance: app record + seventh "Finance" tracker sheet

- **Date:** 2026-10-21
- **Status:** Accepted. Extends ADR-008 (the six delivery sheets are unchanged).
- **Context:** Chat360 asked for project finance in the tracker with four columns: _Amount Raised and Overdue (for Go-Live)_, _Amount that can be raised on immediate basis_, _Total_, _Amount to be raised_.
- **Decision:**
  - One finance record per project in `project.json` (`finance`: currency, the three entered amounts, remarks, updated at/by). Column names are used verbatim in the UI and Excel.
  - **Total = Amount Raised and Overdue (for Go-Live) + Amount that can be raised on immediate basis**, computed in the app and as an Excel table formula; never entered. This is our reading of the column order (Total sits between the two "now" amounts and the future amount) — **to be confirmed by Chat360**; changing it is a one-line change in `financeTotal` and the `tblFinance` formula.
  - A seventh sheet **Finance** with table `tblFinance`, synchronised with the same keyed, non-destructive rules as the other tables (ADR-006).
  - Permissions: edit = PM, project Delivery Head, Delivery Head role, Sales POC; view = those plus the CSM. Tech Team, FDE, former PMs and administrators do not see figures in the app; amounts are also stripped from audit entries and transfer snapshots for them.
  - Workbooks generated before this change have no Finance table: sync skips it, reports a schema notice, and keeps updating the other sheets.
- **Alternatives considered:** per-invoice billing lines (more detail than requested; can be added later as another table); storing Total (risk of inconsistency); a separate finance workbook with tighter OneDrive permissions (stronger confidentiality, but the request was to add finance to the project tracker).
- **Trade-offs/risks:** The tracker is readable by everyone with access to the project folder, so **the Finance sheet is visible to anyone who can open the workbook**, including technical staff. If that is not acceptable, the follow-up is to write finance to a separate restricted workbook (PRD-FIN-007). Excel sheet protection is not a confidentiality control and was not used.
- **Affected:** `packages/core/src/finance.ts`, `rbac.ts`, `schemas.ts`, `analytics.ts`, `transfer.ts`, `workbook/*`; `apps/api/src/routes/projects.ts`, `routes/project-helpers.ts`, `services/workbook.ts`, `graph/workbook.ts`; `apps/web/src/components/FinanceTab.tsx`; `docs/prd.md` (PRD-FIN-\*), `docs/product.md`, `docs/api_guidelines.md`, `docs/security.md`.
- **Validation performed:** core tests (totals, permissions, validation, stale edits, Excel row and formula, handover); API tests (edit rights, 422/403, redaction for tech staff incl. audit and transfer snapshot, analytics per currency, Excel sync, old workbook without Finance); Graph contract test (missing table 404 skipped, 500 still fails); Playwright e2e (Sales POC edits, Tech cannot see the tab); sample workbook opened in openpyxl and LibreOffice, which computed Total correctly. **Pending:** Excel for the web in the Chat360 tenant; Chat360 confirmation of the Total definition and of who may see finance.

## ADR-020 — Single-Worker deployment option (Workers static assets) for Git-connected builds

- **Date:** 2026-10-21
- **Status:** Accepted. Adds a deployment option; does not supersede ADR-002 (the Pages + Worker setup still works).
- **Context:** Chat360 connected the repository to a Cloudflare **Worker** with Workers Builds (root directory `/`, deploy command `npx wrangler deploy`). The repo had no root Wrangler config, so the build's deploy step failed.
- **Decision:** Add a root `wrangler.toml` defining one Worker, `chat360pm`, that serves the built web app as **static assets** (`apps/web/dist`, single-page-application fallback, `_headers` honoured) and runs the API only for `/api/*` (`run_worker_first`). A `[build]` command builds the web app before each deploy, so the dashboard build command can stay empty. Only fail-closed constants are in `[vars]`; tenant values and secrets are set in the dashboard and preserved by `keep_vars = true`.
- **Reasoning:** Matches how the project was connected in Cloudflare; one link and one deployment; same origin without a Pages Function; Cloudflare recommends static assets on Workers for new projects.
- **Alternatives:** change the dashboard to deploy only `apps/api` (website would still need a separate Pages project); keep Pages only (requires a second Cloudflare project and a service binding).
- **Trade-offs/risks:** The Worker name in `wrangler.toml` must match the Worker connected in the dashboard (`chat360pm`). Two configs (root and `apps/api`) define the same Worker code; keep their bindings and crons in step.
- **Bug found and fixed while validating:** the API reused one Durable Object stub, one in-flight token fetch and one remote JWKS loader across requests. Workers reject I/O objects created during a different request, so **every sign-in failed** with a 500 in `workerd`. Stubs are now obtained per call, the app-token cache stores only the token string, and the JWKS loader is created per verification.
- **Validation:** `wrangler deploy --dry-run` with the custom build; `wrangler dev` of the root config: `/`, deep links and `/login` serve the app with the CSP header; `/api/health` returns 503 `service_misconfigured` without settings and 200 with settings; repeated `/api/auth/login` requests redirect to Microsoft (previously 500); client error reporting works. **Pending:** the real Workers Build in Chat360's Cloudflare account.
