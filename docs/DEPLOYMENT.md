# Hexalyte Reseller Platform: production deployment runbook (PROPOSAL)

**Status: proposal. Nothing here has been executed, built, or validated against a server.** Do not treat any step as approved
until you have explicitly approved it. This document never contains real values: only variable names and placeholders.

Confirmed so far: production domain `partner.hexalyte.com`; a **fresh** PostgreSQL database on the **same VPS**; a CDN/proxy is in
front. Unknown (recorded in section 2, not guessed): reverse-proxy type, number of proxy hops, API hostname, origin protection,
off-server backup.

---

## 1. Architecture

```
 Browser ──HTTPS──> CDN ──?──> [existing reverse proxy on the VPS: type unknown] ──> 127.0.0.1:<web port>   (Next.js)
                                                                              └──> 127.0.0.1:<api port>   (Express)
                                         Docker project "hexalyte-reseller" (deploy/docker-compose.prod.yml)
        networks:  internal (no outbound route) : db <-> backend, migrate, admin-init
                   edge     (normal bridge)     : backend (SMSlenz, SMTP), web
        db        postgres:16, NO published port, volume hexalyte_reseller_pgdata (external), secret db_password
        backend   no migration on start (the Prisma CLI is present in node_modules but never run), volume hexalyte_reseller_uploads (external), read-only root fs
        web       next start, API URL baked in at build
        tools     migrate / admin-init: profile "tools", only run explicitly, never started by `up`
```

- Other applications on the VPS are not touched: separate project name, networks and volumes. Never attach these services to
  another application's network, and never run `docker compose down -v` or `docker volume rm` here.
- PostgreSQL is reachable only by containers on the `internal` network. There is no `ports:` entry for it anywhere.
- Backend and web publish only to `BACKEND_BIND` / `WEB_BIND` (default loopback, placeholder ports that must be confirmed free).

## 2. Confirmed facts, and unresolved prerequisites

| Item | State | Needed to finalize |
|---|---|---|
| Domain `partner.hexalyte.com` | confirmed | n/a |
| Database | fresh, same VPS (dedicated container proposed) | confirm the existing remote database is **not** to be migrated (assumed: nothing carried over) |
| API hostname / path | **unresolved** | Option A: same host, `/api/` routed to the backend, everything else to the web app (single origin, simplest CORS and CSP). Option B: separate API hostname (extra DNS record, certificate, CORS entry). Decide before building the web image. |
| Reverse proxy on the VPS | **unknown** | type (nginx / Caddy / Traefik / none), where it runs (host or container), whether it already serves `partner.hexalyte.com` |
| CDN | **unknown vendor** | vendor, TLS mode to origin, how to restrict the origin to CDN traffic, request-size and timeout limits, caching rules, WAF |
| Proxy hops to the backend | **unknown** | exact chain between client and backend; sets `TRUST_PROXY_HOPS` (patch P1 applied; default 1 = previous behaviour) |
| Origin IP / firewall | **unknown** | whether ports 80/443 are open to the world; whether the CDN's address ranges can be allow-listed |
| Free host ports | **unknown** | confirm `14100` and `13000` (placeholders) are free from the VPS inspection output |
| VPS RAM/CPU headroom | **unknown** | size `*_MEM_LIMIT`, `PG_SHARED_BUFFERS` |
| Off-server backup | **unknown** | destination, credentials handled by you, retention, who can restore |
| SMTP provider | **unknown** | host, port, sender (password reset depends on it) |
| Verification cutoff | **not set (placeholder)** | your confirmed timestamp; see 6.3 |
| Production reference data | **unresolved** | are the 4 products / 5 commission levels in `prisma/seed.ts` the real ones? prices? |
| DB role model | open | one owner role for migrate + runtime (proposed default) vs separate migration / runtime roles |
| First admin identity | open | email and display name |

## 3. Files

New (this proposal): `deploy/docker-compose.prod.yml`, `deploy/Dockerfile.backend`, `deploy/Dockerfile.web`,
`deploy/backend-entrypoint.sh`, `deploy/compose.env.example`, `deploy/env.production.example`, `deploy/backup.sh`,
`deploy/restore-test.sh`, `deploy/.gitignore`, `.dockerignore`, `.gitattributes` (repository root),
`apps/backend/scripts/create-first-admin.ts`, `docs/DEPLOYMENT.md`.

Existing files changed for production readiness (see `docs/PRODUCTION_READINESS.md` for the full list and rehearsal results): P1 `TRUST_PROXY_HOPS`
(`apps/backend/src/config/env.ts`, `src/app.ts`, `.env.example`), P2 loopback ports + "DEVELOPMENT ONLY" header in `docker-compose.yml`, P3 header in
`apps/backend/Dockerfile`, and a checksum/cleanup fix in `deploy/backup.sh`. P4 (seed script) is deliberately **not** applied.

## 4. CDN and reverse-proxy requirements

The proxy type is not assumed, so these are requirements to satisfy in whatever you run, not configuration to paste.

1. **HTTPS end to end.** HTTP redirects to HTTPS at the CDN. CDN-to-origin must be encrypted **with certificate validation**
   (not "flexible"/unencrypted). The origin certificate (or CDN origin certificate) must cover `partner.hexalyte.com` (and the
   API hostname under Option B).
2. **Routing.** Option A: `/api/v1/*` to the backend port, everything else to the web port. Under Option B: the API host to the
   backend port. `/health` is an internal probe; do not expose it publicly unless you want to.
3. **Forwarded headers.** The proxy sets `Host` (unchanged), `X-Forwarded-For` (append), and `X-Forwarded-Proto: https`. It must
   **overwrite** a client-supplied `X-Forwarded-Proto` / not trust a client-supplied `X-Forwarded-For` from outside the CDN.
   The backend redirects any request it believes is HTTP when `FORCE_HTTPS=true`, so a wrong or missing `X-Forwarded-Proto`
   causes redirect loops. If you cannot guarantee it, set `FORCE_HTTPS=false` and enforce HTTPS only at the CDN/proxy.
   The redirect target is never taken from the request: set `ALLOWED_HOSTS` to the public hostnames (comma-separated, no scheme or
   port). A plain-HTTP request for any other `Host`, or any plain-HTTP request while the list is empty, gets a 400 and no redirect.
   The CDN/proxy should still restrict accepted hosts and redirect HTTP itself; this is the backend's second line of defence.
4. **Hop count (`TRUST_PROXY_HOPS`).** Count every proxy between the client and the backend (for example CDN = 1, VPS proxy = 2).
   The code defaults to 1 when the variable is unset; set it in `deploy/env.production` only once the chain is confirmed. Wrong value consequences: too low means the rate limiters (per client IP) see the CDN/proxy address,
   so a handful of users exhaust everyone's login and registration budget; too high lets a client choose its own IP and bypass
   limits. Verify after go-live that the access log shows real client addresses (section 7, Gate D).
5. **Request size: at least 6 MB at every layer.** The application accepts 5 MB bank slips (`MAX_UPLOAD_MB=5`) plus multipart
   overhead. Check the CDN limit, the proxy limit (nginx's default of 1 MB would return 413), and any WAF rule.
6. **Timeouts.** Read/send timeouts of at least 30 s (the backend waits up to 15 s on partner integrations and 10 s on SMSlenz).
7. **Caching.** Never cache `/api/*` (the backend already sends `Cache-Control: no-store`). Static assets of the web app may be
   cached. Make sure the CDN honours origin cache headers for the API.
8. **Origin protection.** Only the CDN should be able to reach ports 80/443 on the VPS (firewall allow-list of the CDN's ranges, or
   authenticated origin pulls / a shared secret header at the CDN). Otherwise the CDN and its protections can be bypassed by calling
   the origin IP directly, and forwarded-header trust becomes unsafe.
9. **CORS.** `CORS_ORIGINS` must be the exact browser origin(s) (scheme + host, no trailing slash), e.g. the `partner.hexalyte.com`
   origin. Requests without an `Origin` header (curl, server-to-server) pass; browsers from any other origin are refused.
10. **Content-Security-Policy (web).** Generated in `apps/web/next.config.mjs` from `NEXT_PUBLIC_API_URL`: `connect-src 'self'
    <API origin>`. Under Option A the API origin equals the page origin, so nothing extra is needed. Under Option B the API origin
    is added automatically at build time. The policy also allows Google Fonts (`fonts.googleapis.com` for styles,
    `fonts.gstatic.com` for font files) and `data:`/`blob:` images; there is no third-party image host (`img-src 'self' blob:
    data:`), and no picture ships with the app other than the company logo (`apps/web/public/hexalytelogo.jpeg`). Check the
    browser console for violations after deployment, including through the CDN (some CDNs inject scripts that a strict
    `script-src` blocks).
11. **WAF / bot rules.** Test registration, login, password reset and the bank-slip upload through the CDN; managed WAF rules often
    block legitimate JSON or multipart bodies.

## 5. Environment and secrets

- Compose interpolation values (non-secret): `deploy/compose.env` from `compose.env.example`.
- Backend runtime configuration: `deploy/env.production` from `env.production.example` (names and placeholders). Created on the
  server only, mode 600, never committed (`deploy/.gitignore`), never pasted into chat.
- Database password: file `deploy/secrets/db_password`, generated on the server with a hex/alphanumeric generator (no URL-special
  characters, because `backend-entrypoint.sh` places it in a connection URL). Directory mode 700 and the file owned by uid 1000
  (the `node` user in the images) with mode 400: Compose file-secrets keep host ownership and permissions, the backend and tools
  containers run as uid 1000, and the PostgreSQL entrypoint reads it as root. `DATABASE_URL` is built at container start and is not
  stored anywhere.
- `JWT_ACCESS_SECRET` and `ENCRYPTION_KEY` are 32 random bytes each. **Back up `ENCRYPTION_KEY` separately from the database
  backups.** Losing it makes bank details, bank slips and the SMS gateway credentials unrecoverable. Never rotate it casually.
- SMSlenz credentials are **not** environment variables. They are entered in Admin, Settings, SMS Gateway and stored AES-256-GCM
  encrypted with `ENCRYPTION_KEY`. The API never returns the key to the browser (a masked form with the last four characters is the
  current behaviour; removing those four characters is audit item 9, not applied).
- `OTP_DEBUG_MODE` must be unset. `/auth/dev-otp` answers 404 in production regardless.

## 6. Fresh-database initialization

### 6.1 Order of operations (each production step needs your approval)
1. Create the two external volumes (`hexalyte_reseller_pgdata`, `hexalyte_reseller_uploads`) and the secrets/env files.
2. Start **only** the database: `up -d db`. Confirm it is healthy and not reachable from outside the VPS.
3. Run `run --rm migrate` (default command: `prisma migrate status`, read-only). Expect all migrations pending.
4. Apply: `run --rm migrate npx prisma migrate deploy`. This applies all 7 migration directories to the empty database for the
   first time anywhere: **the from-zero path has not been rehearsed yet** (Gate A).
5. Create the first admin (6.2).
6. Decide and apply production reference data (products, prices, commission levels): **unresolved**; do not run `prisma/seed.ts`.
7. Start `backend` and `web`. Log in as the admin, configure and **test** SMSlenz (needs your approval for a real SMS), then enable it.

Until the gateway is configured and enabled, `POST /auth/register` returns 503 (`SMS_UNAVAILABLE`) by design.

### 6.2 First admin
Full procedure, checks and command sequence: **`docs/FIRST_ADMIN_PROVISIONING.md`**. In short: a dry run first, then one real run
that refuses unless the database matches this release's migrations exactly, the role enum is `(ADMIN, SELLER)` and the users table
is empty; the password is a fresh server-generated value read from a temporary file, never typed into chat.

### 6.3 Account-verification cutoff on a fresh database
`ACCOUNT_VERIFICATION_REQUIRED_FROM` still must be set for the build to pass. On a fresh database there are no legacy users, so
the consequences differ from an upgrade, but the value is still yours to confirm:
- Accounts created **before** the cutoff skip SMS/email verification ("legacy access"). A cutoff in the future would therefore let
  early registrations skip verification.
- A cutoff in the past locks out nothing on an empty system (the admin is a platform role and always passes), but the build will
  warn "in the PAST", and any non-admin test account created before the real launch would be treated as needing verification.
- Choose a timestamp at or just before the moment public registration opens, after any internal test accounts are removed.

**How to select it safely (nothing below has been decided or applied; the repository still holds the placeholder):**
1. The value is a source constant compiled into the backend image (`apps/backend/src/config/account-verification.config.ts`). It is not an
   environment variable, so it cannot be changed without rebuilding and redeploying the backend image. Pick it before the release build.
2. Decide the actual public launch moment T (the instant `POST /auth/register` becomes reachable by real users, including the CDN
   switch). Use ISO-8601 with an explicit offset, e.g. a value in the form `YYYY-MM-DDTHH:MM:SS+05:30`.
3. Rule: cutoff <= T. Anyone who registers at or after the cutoff must verify. A cutoff later than T lets early public sign-ups skip
   verification (the build prints a "days away" warning above 60 days; shorter gaps are NOT warned about).
4. Fresh database (the approved plan): the cutoff locks nobody out because no legacy users exist; the admin is a platform role and always
   passes. Test accounts created before the cutoff keep legacy access, so delete them before launch.
5. Upgrading an EXISTING database instead: run section 5a/5b of `apps/backend/prisma/precheck-account-verification.sql` against the approved
   database with `-v cutoff='<value>'`. Expect `needs_verification_users = 0` and `cutoff_after_newest_user = true`, and re-run it
   immediately before go-live. The cutoff must be AFTER the newest real account that should keep access.
6. Record the chosen value, who approved it, and the image tag (`APP_VERSION`) it was built into.
- The legacy-ADMIN guard in the role migration (`ACK_LEGACY_ADMIN_FULL_ACCESS`) passes trivially on an empty `users` table; no
  acknowledgement row is needed or should be inserted.

## 7. Gates

### Gate A: before anything touches the server (local; each marked step needs approval)
- [ ] Working tree reviewed; proposed patches P1 to P4 approved or rejected individually.
- [ ] `prisma generate` (approval) then backend and web type checks pass. *Currently blocked by the stale client.*
- [ ] Hermetic tests pass (the full DB-free set, once their safety is confirmed).
- [ ] Migration rehearsal **from an empty scratch database on 127.0.0.1:5433** (never the remote database named in `.env`):
      apply all 7 migrations, then `prisma migrate diff` against `schema.prisma` shows no drift. `DATABASE_URL` must be overridden
      inline on every Prisma command.
- [ ] Rehearse migration A on seeded legacy-style rows to see the guard behave (abort without the ACK, succeed after).
- [ ] Images build locally (this exercises `prisma generate`, `npm ci`, the cutoff guard); verify no `.env` or secret is in any
      layer (`docker history`, file listing).
- [ ] `docker compose config` renders with only placeholders; no `ports:` on `db`.
- [ ] Cutoff confirmed by you and set (scratch/commit only with approval).
- [ ] Backup and restore scripts rehearsed against the local scratch database.
- [ ] Information in section 2 completed.

### Gate B: server preparation (each operation needs separate approval)
- [ ] Read-only inspection output reviewed (containers, ports, proxy, firewall, disk, RAM, existing backups).
- [ ] Free host ports confirmed; sizes chosen; no conflict with other applications' names or networks.
- [ ] Volumes and secrets created; database container started; `ss -tlnp` and an external probe confirm port 5432 is not reachable.
- [ ] Off-server backup destination working; first backup taken **and restored into a scratch database**.
- [ ] CDN/proxy configuration prepared and reviewed before it is applied (section 4); staging hostname first if possible.
- [ ] Rollback plan below read and accepted.

### Gate C: deployment (maintenance window)
- [ ] Fresh verified backup (dump + uploads + `ENCRYPTION_KEY` held separately) recorded with its timestamp.
- [ ] Images for one immutable `APP_VERSION` transferred; previous images (if any) kept.
- [ ] `migrate status` shows exactly the expected pending list; `migrate deploy` run once; on any error **stop** (no automatic
      `migrate resolve`, no retry loop).
- [ ] Admin created; backend and web started and healthy; proxy/CDN switched last.

### Gate D: verification (real SMS / email only with explicit approval)
- [ ] `docker compose ps` all healthy; backend logs show no startup errors (review logs for sensitive content before sharing).
- [ ] `GET /health` through the internal path returns 200 `{"status":"ok"}`.
- [ ] HTTPS valid, HTTP redirects, no redirect loop, HSTS present, CSP has no violations in the browser console.
- [ ] Access log shows real client IPs (proves the hop count); rate limit buckets are per client, not per CDN address.
- [ ] Admin login; password reset (uses real email: approval); an unauthenticated request is refused (401).
- [ ] SMS gateway: key masked in every response, test SMS (approval), enable; registration with real OTP (approval): expiry
      (10 min), resend cooldown (60 s), attempt limit (5), per-account/per-number cap (5/hour), daily cap (default 500).
- [ ] Bank-slip upload of a ~5 MB file succeeds through CDN and proxy; a ~6 MB file is rejected by the app, not by a middlebox.
- [ ] Existing flows: WhatsApp number save/remove, reseller application, approval, notifications.
- [ ] From outside the VPS: port 5432 and the backend/web host ports are unreachable; only the CDN path works.

### Gate E: rollback
- **Before any migration is applied:** stop the new containers and remove the proxy/CDN routing. No data exists to lose. Keep the
  empty database volume; do not delete it without a fresh approval.
- **After migrations, before real users:** the database holds only the admin and reference data. Preferred: fix forward. If a
  migration failed midway, the migrations are separate transactions, so some may be applied: do not run `migrate resolve`
  automatically; restore the pre-deployment dump into a **new** database, point the app at it, and keep the failed one for analysis.
- **After real users exist:** the role migration cannot be reversed in place and the old application cannot run against the new
  schema. Rolling back means restoring the last good dump plus the previous image, losing everything written since. Decide the
  point of no return explicitly before opening registration, and keep backups frequent.
- Never delete a volume as part of a rollback. Never run `down -v`.

## 8. Backups

- `deploy/backup.sh`: `pg_dump -Fc` inside the container, verified with `pg_restore --list`, SHA-256 recorded, uploads volume
  archived, optional `OFFSITE_COMMAND`, optional explicit `RETENTION_DAYS`. It warns loudly when nothing leaves the server.
- `deploy/restore-test.sh`: restores into a throwaway database, prints counts only, drops only that database. Run it after every
  backup method change and on a schedule.
- Required before go-live: at least one off-server copy, a documented restore owner, a restore test that has actually passed,
  and `ENCRYPTION_KEY` stored apart from the backups.

## 9. Production actions that need explicit approval (none are done)

Connecting to the VPS; any inspection command; creating volumes, directories, secrets or env files; pulling or transferring images;
starting, stopping or restarting any container; running `migrate deploy` or `migrate status`; creating the admin; inserting any
database row; changing the proxy, CDN, DNS or firewall; installing the backup job; the restore test; sending any SMS or email;
committing or pushing code.
