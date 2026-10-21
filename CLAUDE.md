# CLAUDE.md — instructions for future Claude Code sessions

## Read first

Before changing anything, read the docs that apply to your change:

- `docs/decision.md` — accepted architecture decisions (ADRs). Do not contradict an accepted ADR silently.
- `docs/prd.md` — requirements with IDs and current status.
- `docs/infrastructure.md`, `docs/security.md`, `docs/api_guidelines.md`, `docs/design_system.md`, `docs/deployment.md`, `docs/product.md`.

## Non-negotiable architecture

- **OneDrive-first.** Business records live as JSON documents and `.xlsx` trackers in the approved OneDrive/SharePoint library via Microsoft Graph (ADR-003). Do not add a database, VPS or object store. The `Coordinator` Durable Object holds coordination state only — never business records.
- **Excel is the official tracker** and is a keyed, non-destructive projection of `project.json` (ADR-005/006). Never regenerate or blindly overwrite an existing workbook; never delete rows.
- **Every write is eTag compare-and-swap** through `Repos.update` / `mutateProject` (ADR-004). Mutations must be deterministic functions of the document because they re-run on 412.
- **Business rules live in `packages/core`** (no I/O). The API composes them; the UI never re-implements authorisation.
- **Authorisation is server-side** on every request (`packages/core/src/rbac.ts`). Never grant roles or access from an email domain. Admins get no implicit project access.
- **Least-privilege Graph** (ADR-009). Do not add broader permissions without a new ADR and Chat360 approval. Never expose Microsoft tokens to the browser.
- **Honesty:** never report success before the server/Graph confirms; record notification outcomes truthfully; do not claim live Microsoft/Cloudflare verification or real-device testing that did not happen.

## Repository layout

```
packages/core   domain types, schemas, rbac, tasks, escalation, transfer, analytics, workbook (xlsx writer, tracker schema, sync planner)
apps/api        Hono Worker: routes, auth (Entra OIDC), Graph adapters, Coordinator DO, services, cron jobs; dev/ = in-memory dev server + seed
apps/web        React SPA (Vite), Pages Function proxy in functions/, Playwright e2e in e2e/
docs            the eight mandatory documents + screenshots
scripts         workbook validation (Python/openpyxl/LibreOffice)
wrangler.toml   single-Worker deployment (website as static assets + API), used by Workers Builds (ADR-020)
```

## Commands

`pnpm install`, `pnpm dev`, `pnpm typecheck`, `pnpm lint`, `pnpm format`, `pnpm test`, `pnpm build`, `pnpm e2e`, `pnpm validate:workbook`. Run typecheck, lint, test and build before committing; run e2e for UI or workflow changes.

## Conventions

- TypeScript strict; match the existing style (Prettier: 100 cols, single quotes). Keep comments sparse and explain _why_.
- New inputs get a zod schema in `packages/core/src/schemas.ts`; new endpoints go in `docs/api_guidelines.md`.
- Creates take an `Idempotency-Key`; state-changing requests need `X-Requested-With: chat360` (the web `api()` helper does this).
- Every UI data view needs loading, empty, error and permission-aware states (`docs/design_system.md`).
- Tests: domain rules in `packages/core/test`; HTTP behaviour in `apps/api/test` using `dev/memory-deps.ts`; Graph request shapes in `apps/api/test/graph.test.ts`. In-memory tests do not verify Microsoft integration — say so.
- Worker code must not reuse request-scoped I/O across requests (Durable Object stubs, in-flight fetch promises): Workers reject it. Verify runtime changes with `wrangler dev`, not only Node tests.
- Never commit secrets, `.dev.vars`, or real employee/client names or emails. Demo data must stay fictional.

## Maintaining docs and decisions

- Update the affected docs in the same change as the code (status labels in `docs/prd.md` and `docs/product.md` must match reality).
- Record material decisions in `docs/decision.md` as a new `ADR-NNN` with the real date; to change an accepted decision, mark it **Superseded** and add a replacement — never rewrite history.
