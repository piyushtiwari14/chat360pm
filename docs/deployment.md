# Deployment

This repository has **not been deployed** anywhere yet; the steps below are what an operator with Chat360 Cloudflare and Entra admin access needs to do. Never put real credentials in this file or in git.

## Prerequisites

- Node.js ≥ 22, pnpm 10 (`corepack enable`).
- Python 3 + `openpyxl` (optional, for `pnpm validate:workbook`); LibreOffice optional for formula recalculation checks.
- A Cloudflare account (Workers **Paid** plan recommended — see `docs/infrastructure.md` §Capacity).
- Microsoft Entra ID admin (or someone who can grant admin consent) and an Exchange admin for the mail restriction.

## Local development

```bash
pnpm install
pnpm dev            # API dev server on :8787 (in-memory, developer sign-in) + Vite on :5173
```

Open http://localhost:5173 and choose a fictional demo user. Nothing leaves your machine: OneDrive, Excel and Outlook are emulated in memory; emails and meetings are recorded, not sent. Data resets on restart.

To run the actual Worker locally against a **development** tenant and library: copy `apps/api/.dev.vars.example` to `apps/api/.dev.vars`, fill it in, set `APP_ORIGIN`/vars as needed, then `pnpm --filter @chat360/api dev:worker` and point Vite at it with `API_URL=http://localhost:8787 pnpm --filter @chat360/web dev`.

## Testing

```bash
pnpm typecheck          # tsc for core, api, web, Pages Function
pnpm lint               # eslint + prettier --check
pnpm test               # core (vitest), api integration + Graph contract tests, web jsdom tests
pnpm build              # wrangler dry-run bundle + vite build
pnpm e2e                # Playwright: dev API + production web build (desktop + emulated phone)
pnpm validate:workbook  # generate a sample tracker and validate with openpyxl/LibreOffice
SCREENSHOTS=1 pnpm e2e  # also refresh docs/screenshots
```

In environments with a pre-installed Chromium, set `PW_CHROMIUM_PATH` if the Playwright revision differs.

What the tests do **not** cover: live Microsoft Graph, live Entra sign-in, Cloudflare deployment, real devices. See the final section.

## Environment variables

API Worker (`apps/api/wrangler.toml` `[vars]` per environment, secrets via `wrangler secret put`):

| Name                    | Secret  | Example / notes                                                                                  |
| ----------------------- | ------- | ------------------------------------------------------------------------------------------------ |
| `ENVIRONMENT`           | no      | `staging` / `production`                                                                         |
| `APP_ORIGIN`            | no      | `https://ops.chat360.example` — must be the exact browser origin, `https://` outside development |
| `ENTRA_TENANT_ID`       | no      | Chat360 tenant GUID                                                                              |
| `ENTRA_CLIENT_ID`       | no      | App registration (client) id                                                                     |
| `ENTRA_CLIENT_SECRET`   | **yes** | Client secret (or rotate to a certificate later)                                                 |
| `ALLOWED_EMAIL_DOMAINS` | no      | `chat.io` (comma separated; consistency check only)                                              |
| `BOOTSTRAP_ADMIN_OIDS`  | no      | Entra object ids of the first administrators                                                     |
| `GRAPH_DRIVE_ID`        | no      | Drive id of the approved library                                                                 |
| `ONEDRIVE_ROOT_PATH`    | no      | Root folder inside the drive, e.g. `Chat360 Project Operations`                                  |
| `NOTIFICATION_MAILBOX`  | no      | Shared mailbox UPN for notifications; empty → notifications recorded as "not configured"         |
| `TOKEN_ENCRYPTION_KEY`  | **yes** | `openssl rand -base64 32`                                                                        |
| `COOKIE_SECRET`         | **yes** | `openssl rand -base64 32` (different from the above)                                             |
| `STORAGE_BACKEND`       | no      | `graph` (only allowed value outside development)                                                 |
| `DEV_AUTH`              | no      | `disabled` (refused outside development)                                                         |
| `RELEASE`               | no      | Set by CI to the git SHA                                                                         |

Web: `RELEASE` at build time (shown in crash reports). The Pages project needs the `API` service binding (declared in `apps/web/wrangler.toml`).

## Microsoft Entra ID setup (pending)

1. **App registration** → single tenant. Platform _Web_, redirect URI `https://<APP_ORIGIN host>/api/auth/callback` (add the staging origin separately). Front-channel logout URL `https://<host>/login?signedOut=1`.
2. **Certificates & secrets** → new client secret → store as `ENTRA_CLIENT_SECRET`.
3. **API permissions**:
   - Delegated: `openid`, `profile`, `email`, `offline_access`, `User.Read`, `Mail.Send`, `Calendars.ReadWrite`. Grant admin consent if users cannot consent themselves.
   - Application: `Sites.Selected`, `Mail.Send` → **Grant admin consent**.
4. **Enterprise application** → _Assignment required = Yes_ → assign the Chat360 employee group (recommended).
5. **Site grant** for `Sites.Selected` (an admin with `Sites.FullControl.All` runs once):
   ```http
   POST https://graph.microsoft.com/v1.0/sites/{site-id}/permissions
   { "roles": ["write"], "grantedToIdentities": [{ "application": { "id": "<client-id>", "displayName": "Chat360 Project Operations" } }] }
   ```
   Then find the drive id: `GET /sites/{site-id}/drives` → `GRAPH_DRIVE_ID`. Create the root folder (`ONEDRIVE_ROOT_PATH`) and the destination folder(s) (default `Projects`).
6. **Restrict app-only mail** to the notification mailbox (Exchange Online PowerShell):
   ```powershell
   New-ApplicationAccessPolicy -AppId <client-id> -PolicyScopeGroupId <mail-enabled-security-group-containing-the-mailbox> -AccessRight RestrictAccess -Description "Chat360 Ops notifications only"
   Test-ApplicationAccessPolicy -Identity <mailbox> -AppId <client-id>
   ```
7. Record the bootstrap admins' object ids in `BOOTSTRAP_ADMIN_OIDS`.

## Option A — one Worker connected to GitHub (Workers Builds)

This is the setup Chat360 started in the Cloudflare dashboard. The root `wrangler.toml` defines a Worker named **`chat360pm`** that serves the website and the API on one link (ADR-020).

1. **Workers & Pages → `chat360pm` → Settings → Build:**
   - Git repository: the repository and branch you deploy from (`main`).
   - Root directory: `/`.
   - Build command: leave empty (`wrangler.toml` builds the web app itself).
   - Deploy command: `npx wrangler deploy`.
2. **Settings → Variables and Secrets** (Production):

   | Name                   | Type       | Value                                                                                                             |
   | ---------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------- |
   | `APP_ORIGIN`           | Text       | Your Worker URL, e.g. `https://chat360pm.<your-subdomain>.workers.dev` (no trailing slash), or your custom domain |
   | `ENTRA_TENANT_ID`      | Text       | Tenant ID                                                                                                         |
   | `ENTRA_CLIENT_ID`      | Text       | App registration client ID                                                                                        |
   | `GRAPH_DRIVE_ID`       | Text       | Drive ID of the approved SharePoint library                                                                       |
   | `BOOTSTRAP_ADMIN_OIDS` | Text       | Object ID(s) of the first administrator(s)                                                                        |
   | `NOTIFICATION_MAILBOX` | Text       | Optional; shared mailbox address for notifications                                                                |
   | `ENTRA_CLIENT_SECRET`  | **Secret** | Client secret value                                                                                               |
   | `TOKEN_ENCRYPTION_KEY` | **Secret** | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`                                     |
   | `COOKIE_SECRET`        | **Secret** | Run the same command again (a different value)                                                                    |

   `keep_vars = true` in `wrangler.toml` keeps these when the next build deploys.

3. In Entra, the redirect URI must be `<APP_ORIGIN>/api/auth/callback`.
4. **Deployments → Retry build** (or push to `main`). Then open `<APP_ORIGIN>/api/health`: `{"status":"ok"}` means configured; `503 service_misconfigured` means a setting is missing. **Observability → Logs** shows a `configuration_error` line listing exactly which.

Until step 2 is done the site loads and its sign-in page says setup is incomplete; that is expected.

## Option B — separate API Worker and Pages project (pending)

```bash
cd apps/api
npx wrangler login
# per environment (staging shown):
npx wrangler secret put ENTRA_CLIENT_SECRET --env staging
npx wrangler secret put TOKEN_ENCRYPTION_KEY --env staging
npx wrangler secret put COOKIE_SECRET --env staging
# fill [env.staging.vars] in wrangler.toml (no secrets), then:
npx wrangler deploy --env staging

cd ../web
pnpm build
npx wrangler pages project create chat360-ops-web --production-branch main
npx wrangler pages deploy dist --project-name chat360-ops-web --branch staging
```

The Durable Object migration (`v1`, `new_sqlite_classes = ["Coordinator"]`) is applied on first deploy. Add the custom domain to the Pages project; `APP_ORIGIN` must match it.

## GitHub Actions

- `.github/workflows/ci.yml` — on pushes and pull requests: install, typecheck, lint, unit/integration tests, build, workbook validation, Playwright e2e, `pnpm audit --prod` (report only). No secrets required.
- `.github/workflows/deploy.yml` — **manual** (`workflow_dispatch`) with an environment input; uses GitHub _Environments_ (`staging`, `production`) so production can require reviewers. Secrets: `CLOUDFLARE_API_TOKEN` (Workers + Pages edit), `CLOUDFLARE_ACCOUNT_ID`. Worker secrets are set once with `wrangler secret put`, not from CI.

## Verification after deploy

1. `GET https://<host>/api/health` → `{"status":"ok","environment":"staging",…}`. A `503 service_misconfigured` means configuration is incomplete; the Worker log line `configuration_error` lists what is missing.
2. Sign in with a bootstrap admin; check Admin → Health (storage OK, mailbox configured).
3. Assign roles to a test PM, tech and Delivery Head.
4. Create a test project; open the tracker in Excel for the web; confirm the seven sheets (six delivery sheets + Finance), tables, dropdowns and formulas, and that Finance → Total equals the first two amounts.
5. Confirm a task as Not completed; check the escalation email arrives from the notification mailbox and the Excel row updates.
6. Edit a WBS cell in Excel, update the task in the app, and confirm a conflict is shown, then resolved by "Overwrite".
7. Run a transfer request → approve, and a direct reassignment; check history and tracker header.
8. Connect Outlook; send a preview-confirmed email to yourself; create and cancel a meeting.
9. Admin → Scheduled jobs → run `maintenance` and `reconcile`; check runs are OK.
10. Test on real phones and tablets (Safari iOS, Chrome Android) — record results in `docs/product.md`.

## Rollback

- Worker: `npx wrangler deployments list --env production` then `npx wrangler rollback <deployment-id> --env production`.
- Pages: Cloudflare dashboard → Deployments → previous production deployment → _Rollback_.
- Data: restore `project.json` / tracker / `_system/*.json` from OneDrive version history; run Admin → Scheduled jobs → `reconcile`.
- Emergency stop for scheduled work: add the job name to `disabledJobs` (Admin → Configuration). To stop all crons immediately, remove the `[triggers]` block for that environment and redeploy.

## Troubleshooting

| Symptom                                              | Likely cause / fix                                                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `/login?error=not_authorized`                        | Guest account, wrong domain, or user not assigned to the enterprise app                                                        |
| `/login?error=signin_expired`                        | Callback > 10 min after starting, or cookies blocked; retry                                                                    |
| `graph_permission_denied`                            | Admin consent missing, `Sites.Selected` site grant missing, or wrong `GRAPH_DRIVE_ID`                                          |
| Notifications show "not configured"                  | `NOTIFICATION_MAILBOX` empty                                                                                                   |
| Notifications "failed" with 403                      | Application access policy does not include the mailbox                                                                         |
| Workbook state "conflict"                            | Someone edited managed cells in Excel; resolve on the project page                                                             |
| Workbook state "failed", `EditModeCannotAcquireLock` | File locked by a desktop Excel session; sync retries hourly or use "Sync now" later                                            |
| `consent_required` on Email/Calendar                 | User has not connected Outlook, or tenant requires admin consent for delegated Mail/Calendar                                   |
| Jobs not running                                     | Check Admin → Scheduled jobs (`disabled`, `skippedOverlap`), Worker cron logs, and that `[triggers]` exist for the environment |

## Outstanding validation (not yet done)

- Live Entra sign-in, Graph storage, workbook API, mail and calendar against the Chat360 tenant.
- Opening generated trackers in desktop Excel and Excel for the web.
- Cloudflare deployment of Pages + Worker + DO + crons.
- Real-device testing (only browser emulation was run).
- Alerting configuration in Cloudflare.
