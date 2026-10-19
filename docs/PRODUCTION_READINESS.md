# Production readiness report: partner.hexalyte.com

Branch: `prod-readiness-node24` (local; commits `5646d48`, `667fbf5` and `49e0c10` are made, nothing is pushed, tagged or deployed; commits 4 and 5 are pending). Validation: 2026-10-18/19; release-hygiene phase (section 9) and verification phase (section 10) on 2026-10-19.
All rehearsals used throwaway local resources (scratch PostgreSQL containers on loopback, scratch copies of the repository, scratch Compose
project `hx2scratch`). `DATABASE_URL` was overridden in every process that could have inherited `apps/backend/.env` (it points at a remote DB).
No production resource was contacted. `ACCOUNT_VERIFICATION_REQUIRED_FROM` is still the placeholder (see 4).

**Recommendation: NO-GO.** Code, images and procedures validated; the blockers are open decisions, the unset cutoff and the unfinished release commits (section 6).

## 1. Changes in this phase (on top of the earlier P1 to P3 and `backup.sh` fix)

| File | Change | Why |
|---|---|---|
| `.gitattributes` (new) | `* text=auto eol=lf`; `*.sh`, `Dockerfile*`, `*.yml`, `*.sql` forced LF; images binary | The working tree had ~116 CRLF files against an LF index; shell scripts with CRLF break in containers. |
| `.gitignore` | `screenshot.png` and the 10 database-connected diagnostic / manual-QA scripts | Keep them out of any release commit (`git add -A` would otherwise stage them). |
| `deploy/Dockerfile.backend`, `deploy/Dockerfile.web`, `apps/backend/Dockerfile` | `node:20-alpine` to `node:24-alpine` (Node 20 is end-of-life) | Section 3. |
| `deploy/Dockerfile.backend` | copies only `check-deploy-config.cjs` and `create-first-admin.ts` from `scripts/` | Diagnostic and QA scripts no longer enter the build or tools image. Tools image 2.5 GB to 2.05 GB. |
| `apps/web/package.json`, `apps/backend/package.json`, `package-lock.json` | `next` pinned to exactly 15.5.28; `source-map-js` 1.2.2 (lockfile); `@types/node` `^24.19.2` in both workspaces | Section 2. Lockfile delta limited to the Next family, `source-map-js` and `@types/node`. |
| `apps/backend/src/modules/trials/trial.service.ts` | `trialInclude` no longer selects `integration.baseUrl` | **Real defect found by the DB-backed E2E:** reseller trial responses included the partner SaaS API base URL. Nothing server-side used it. |
| `apps/backend/tests/reseller-trial-response-no-integration-url.test.ts` (new) | source-level guard for the above | Regression test, no DB needed. |
| `apps/backend/scripts/e2e-flow.ts` | updated stale expectations (login of unapproved reseller is allowed, seller routes are refused; removed the RESELLER_AGENT scenario, that role no longer exists); marks its own throwaway users verified | Script predated the approval-gate / role redesign and the verification gate; now independent of the cutoff. |
| `docs/PRODUCTION_READINESS.md` | this file | |

Not changed: the cutoff, `P4`, anything under `prisma/`.

## 2. npm advisories

| Package | Before | Now | Status |
|---|---|---|---|
| `next` | 15.5.26: two cache-poisoning advisories (SSG/ISR, moderate), patched in 15.5.27 | **15.5.28** (exact pin) | the two Next advisories are resolved; `npm audit` still lists `next` only because of the postcss dependency below |
| `source-map-js` | 1.2.1 (event-loop DoS, high) | **1.2.2** | resolved |
| `postcss` | 8.4.31 nested under Next, pinned exactly by every Next 15.x (4 advisories, high; fixed in >= 8.5.23) | unchanged | **unresolved, not forced** |

PostCSS override experiment (scratch copy only): `overrides` (global and scoped to `next`) are ignored by npm for Next's nested copy; deleting the
lock entry removed PostCSS entirely and `next build` then failed ("Cannot find module 'postcss'"); adding a direct `postcss@8.5.30` dependency
builds fine but leaves Next's own 8.4.31 in place, so the audit is unchanged. Not adopted. The remaining exposure is build-time CSS processing of
files that only the developers control; visitors cannot reach it. Revisit with a newer Next release.
`npm audit` now: 2 vulnerabilities (1 moderate `next` via postcss, 1 high `postcss`). `npm audit fix` was not run.

## 3. Node 24

Host Node 24.15 and all three images on `node:24-alpine` (Node v24.22.0 in the images): backend runtime, tools and web images build without any
workaround; backend and web run non-root; `next build` compiles and prerenders 38 pages; Prisma client, engine (Alpine OpenSSL), migrations,
`/health` through Prisma, restart, backup and restore all work on Node 24. The earlier Docker Desktop network stall did not recur.
Base images are still mutable tags (`node:24-alpine`, `postgres:16-alpine`); pinning by digest is optional.

## 4. Verification cutoff (not set)

The placeholder makes the production build fail by design. Scratch runs used a TEST value in scratch copies only. Behaviour verified in both
directions: with a cutoff in the future new accounts have legacy access; with a cutoff in the past a brand-new account is refused at login
(`EMAIL_NOT_VERIFIED`). Selection procedure: `docs/DEPLOYMENT.md` 6.3. Needs your launch time T.

## 5. Tests executed and actual results

| Check | Result |
|---|---|
| Backend and web `tsc --noEmit` (final tree) | passed |
| Backend suite, DB-free (dead DB URL, SMTP blanked) | 1554 tests: **1551 pass, 0 fail, 3 skipped** (the skips are the DB-backed suites below) |
| DB-backed suites (`reseller-approval-flow`, `reseller-registration-security`, `demo-requests`) on a migrated scratch DB, past cutoff | 40 / 40 pass. (With a future test cutoff 1 test fails, as designed: it asserts new accounts must verify.) |
| DB-backed `scripts/e2e-flow.ts` on a migrated, seeded scratch DB | **109 pass, 0 fail**, under both a past and a future cutoff. First run: 4 failures = 1 real defect (fixed, section 1) + 3 stale expectations (updated) |
| Image builds (Node 24): backend runtime, tools, web | built; placeholder cutoff still fails the backend build |
| Compose (`hx2scratch`): db, backend, web | all healthy; db has no published port; backend/web on 127.0.0.1 only |
| Migrations from empty DB via the tools image | all 7 applied, status up to date, `migrate diff` against `schema.prisma` empty (exit 0) |
| Role-migration guards | not re-run in this phase (the 7 migrations are unchanged since the previous phase, where FINANCE / RESELLER_AGENT / legacy-ADMIN-without-ACK aborted with the DB unchanged, and the ACK and SUPER_ADMIN + RESELLER_ADMIN cases succeeded) |
| `create-first-admin` on the scratch DB | check-only passed and wrote nothing; `--apply` created one ADMIN plus one audit row; a second `--apply` refused (users table not empty). Scratch only |
| Backup and restore (`backup.sh`, `restore-test.sh`) | dump verified, SHA-256 verifies from a different directory (earlier defect fixed), restore into scratch DB: 28 tables, 7/7 migrations, 0 failed, scratch DB dropped, uploads archive contains the test file |
| Crash restart | process exit restarts the container (`restarts=1`), healthy again, uploads file still present |
| Browser (headless Chrome) against the real stack | login page renders, admin login succeeds through the real API, `/admin`, `/admin/products`, `/admin/settings`, `/admin/resellers` and `/register` render; CORS works; **0 CSP violations**; only console message: `/favicon.ico` 404 (cosmetic) |
| Images | no `.env`, key, dump or password file in any image; no secret-like ENV/ARG in history; tools image holds only the two required scripts; all run as `node` |
| Release set review (`git ls-files -co --exclude-standard`, 351 files) | no screenshot, diagnostic script, env file or secret; only test constants in `verify-partner-api-contract.ts` |
| Earlier phase, still valid | secret scan of history (clean), `.dockerignore` keeps env files out of the real build context, encryption-key recovery (data unreadable with another key) |

Not run, so not claimed: anything through a real CDN or reverse proxy (HTTPS, forwarded headers, `TRUST_PROXY_HOPS` against real traffic,
6 MB upload limits), HSTS over real TLS, real SMTP or SMSlenz, a registration with a real OTP, Linux file-permission behaviour of the secret file
on the VPS, a browser check against the final production hostnames, the guard scenarios on this phase's images.
Test-environment note: in the scratch Windows setup the secret file is mounted from NTFS; on the VPS follow `docs/DEPLOYMENT.md` section 5.

## 6. Remaining blockers and risks

**Blockers**
1. Cutoff: needs your launch time T (public registration launch time is undecided); then rebuild the backend image (compiled constant). The placeholder stays until then.
2. **The release is not complete or tagged.** Committed so far on `prod-readiness-node24`: `5646d48` (repository and Docker hygiene rules), `667fbf5` (backend, schema and dependencies, 87 files) and `49e0c10` (web, 109 files, including the approved logo). Still uncommitted: commit 4 (deployment files, Dockerfiles, `.env.example`, docs; 15 paths) and commit 5 (tests; 84 paths), plus 14 unapproved images that stay out of the release. Nothing is pushed or tagged. Release images must be built from a clean checkout of the tagged revision.
3. PostCSS advisory: deferred by decision, to be revisited before release (section 2). Not resolved.
4. Open facts: API hostname and `NEXT_PUBLIC_API_URL`, proxy and CDN topology, hop count, SMTP, SMS, off-server backup and key escrow, free host ports, VPS resources, approved business data, first-admin owner (`docs/DEPLOYMENT.md` section 2).
5. `ALLOWED_HOSTS` must be set in `deploy/env.production` (section 9); without it plain-HTTP requests get a 400 instead of a redirect.
6. Image assets: resolved for the release (section 11). Only the company logo `apps/web/public/hexalytelogo.jpeg` ships (owned and authorised by the company); every other image stays out of the repository and out of the images. Build release images only from a clean checkout of the tag (section 11.4).
7. Intermittent test failure not explained (section 10).
8. Checks not yet run (section 10): real CDN/proxy/TLS path, real SMTP/SMS, production hostnames, backup/restore and role-migration guards on the final images, browser check on the final stack.
9. Base-image digests: pinning is optional and not applied; if applied, image checks must be repeated on those digests (section 9).

**Risks to accept or fix**
- `FORCE_HTTPS` redirect: fixed in the release-hygiene phase (section 9). It now needs `ALLOWED_HOSTS` set on the server, otherwise plain-HTTP requests get a 400. Still restrict hosts at the proxy/CDN.
- Prisma CLI is present in the runtime image (never run at startup).
- Rate limiting is in-memory (one backend container only) and depends on a correct `TRUST_PROXY_HOPS`.
- `start:prod` npm script runs migrations; do not use it on the server.
- After a failed migration Prisma needs a manual `migrate resolve --rolled-back`.
- Missing `favicon.ico`.
- `apps/backend/.env.example`: sanitised in section 9.
- `apps/backend/scripts/test-smtp.ts` (sends mail when run by hand) and `verify-partner-api-contract.ts` stay in the repository but never enter an image or run automatically (section 9).
- Scratch Docker resources remain (stopped, not removed): containers `hx2scratch-*`, volumes `hx_scratch_*`, `hx2_scratch_*`, local image tags. Remove them yourself when you wish.

## 7. Environment variables, decisions, procedures

Unchanged from `docs/DEPLOYMENT.md` (sections 2, 4, 5 and Gates A to E) and `docs/FIRST_ADMIN_PROVISIONING.md`; `TRUST_PROXY_HOPS` is now
effective (default 1, set only after the chain is confirmed). Every production step needs your explicit approval.

## 8. GO / NO-GO

**NO-GO** until the cutoff is set and the work is committed and tagged, after which the checks in section 5 are repeated on the final images,
plus a test through the real CDN / proxy path on a staging hostname, if possible.

## 9. Release-hygiene phase (2026-10-19, local only: nothing staged, committed, pushed or deployed)

| Item | Result |
|---|---|
| `FORCE_HTTPS` redirect | New `apps/backend/src/middleware/enforce-https.middleware.ts`. The redirect target comes from the new `ALLOWED_HOSTS` list, never from the request. An unlisted `Host`, or an empty list, gets a 400 with no `Location`. Requests the trusted proxy marks as HTTPS, including the container health check (it sends `x-forwarded-proto: https`), are untouched, so the existing proxy setup is unaffected. A non-default port is dropped from the target. An `ALLOWED_HOSTS` value with a scheme, port, path or wildcard stops the backend at startup. **Server action needed:** add `ALLOWED_HOSTS` to `deploy/env.production` (template and `docs/DEPLOYMENT.md` section 4 updated). |
| `.env.example` | The personal Gmail address, `hexalyte.com` seed emails and default seed/JWT/encryption values are replaced by neutral placeholders. The JWT and encryption placeholders fail validation until real values are generated. The file documented `SEED_SUPER_ADMIN_*`, but `prisma/seed.ts` reads `DEMO_ADMIN_*`; the example now uses the names the seed reads. `seed.ts` is unchanged (P4 still open; it prints the admin email). |
| `scripts/test-smtp.ts` | The hard-coded personal fallback recipient is removed. It now needs an argument or `SMTP_USER`. |
| Excluded from release | `AUDIT.md` (stale: cites 33 tests and 110 e2e checks, and its findings are fixed) and `deploy/proposed-patches/PROPOSED_CHANGES.md` (P1 to P3 applied; P4 is recorded in this file and `docs/DEPLOYMENT.md`). Both are added to `.gitignore`; the files stay on disk. |
| Stale headers | The "PROPOSED / NOT YET BUILT" comments in `deploy/Dockerfile.*`, `docker-compose.prod.yml`, `backup.sh` and `restore-test.sh` now state the real validation status (comment-only change). |
| Diagnostic scripts in images | Not copied. `deploy/Dockerfile.backend` copies only `check-deploy-config.cjs` and `create-first-admin.ts` from `scripts/`. `tsc` compiles `src/` only, and the runtime stage copies only `dist/`. `.dockerignore` excludes `**/tests` and `docs`. No package.json has `pre*`, `post*`, `install` or `prepare` lifecycle hooks. `test-smtp.ts` is reachable only through `npm run test:email`, which no Dockerfile, Compose file or entrypoint calls. This is a static review; images were not rebuilt in this phase. |
| Base-image digests | Not applied. Resolved from the public registry on 2026-10-19: `node:24-alpine` = `sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f`, `postgres:16-alpine` = `sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea` (multi-arch index digests, possibly newer than the layers validated earlier). If pinned, re-run the image checks on exactly those digests. |
| Image assets | Referenced: `hexalytelogo.jpeg`, `Nine Arches Bridge at Sunrise.png`, `srilanka-images/shutterstock-138036806_main_1473765413739.jpeg`, `srilanka-images/-FWEBP-S1536.webp`. Unreferenced in `public/`: `ninearch.avif`, `-FWEBP-S1536 (1).webp`, the `merlin_…superJumbo.avif`. Everything under `apps/web/src/assets/` is unreferenced (byte-identical copies of `public/` files, plus 3 extra images). **Licensing is unconfirmed:** there is no licence file, credit or embedded metadata, and two filenames look like stock or news-agency downloads. Nothing was removed or modified. |

Tests in this phase (DB-free, `DATABASE_URL` overridden with a dead URL, SMTP blanked): backend and web `tsc --noEmit` passed. The backend suite ran **1567 tests: 1564 pass, 0 fail, 3 skipped** (the same three DB-backed suites). 13 of them are new, in `tests/force-https-allowed-hosts.test.ts`. The DB-backed suites, `e2e-flow.ts`, the images and Compose were not re-run, because the change touches only the redirect middleware and env parsing. The cutoff is still the placeholder, and the PostCSS advisory is still deferred.

## 10. Verification phase (2026-10-19, scratch resources only; nothing staged, committed, pushed or deployed)

All database work used a throwaway Postgres on `127.0.0.1:55433` (tmpfs, removed later) with a literal URL on every command and a host guard run first. `apps/backend/.env` (remote DB) was never used for a DB connection, SMTP was blanked, and no production resource was contacted. The cutoff is still the placeholder; a TEST cutoff existed only in a scratch copy of the release set used to build images.

### 10.1 Docker Desktop data loss (not caused by a Docker command of ours)

Starting Docker Desktop made it auto-update from 4.94.0 to 4.95.0 (uninstall plus fresh install per its install logs). Afterwards the engine had 0 containers, 0 images and 0 volumes. Lost, all local and throwaway: the earlier scratch containers, volumes and image tags (`hx2scratch-*`, `hx2-pg`, `hx_scratch_*`, `hx2_scratch_*`, `hexalyte-scratch/*`, `hexalyte-localtest/*`, `hexalyte/*:n24`) and the dev-compose Postgres container and volume. You confirmed the dev database held nothing important; it was not recreated or seeded. Consequence: every image and Compose result below comes from a rebuild on the fresh engine, with `node:24-alpine` and `postgres:16-alpine` pulled again. Leftovers from this phase: volumes `hx3verify_pgdata`, `hx3verify_uploads` and images `hexalyte-verify/reseller-{backend,tools,web}:v3`; nothing was deleted.

### 10.2 Results

| Check | Result |
|---|---|
| Focused tests (allowed hosts, trust-proxy hops, deploy-config check, rate-limit bypass, web CSP) | 31 / 31 pass |
| Real `app.ts` probe, no DB, `FORCE_HTTPS=true`, `ALLOWED_HOSTS=partner.example.com` | Allowed host: 301 to `https://partner.example.com/...`. Forged Host, suffix trick, `@` trick, path trick, forged `X-Forwarded-Host`: 400, no `Location`. Empty list: every plain-HTTP request 400. `ALLOWED_HOSTS=https://...`: startup fails (exit 1). |
| Backend and web `tsc --noEmit` | pass |
| Full DB-free backend suite | 1567 tests, 1564 pass, 0 fail, 3 skipped in 3 of 4 runs (see 10.3) |
| Migrations on scratch DB | 7 / 7 applied; `migrate status` up to date; `migrate diff` against `schema.prisma` empty (exit 0) |
| DB-backed suites (`reseller-approval-flow`, `reseller-registration-security`, `demo-requests`), placeholder cutoff | 40 / 40 pass, 0 skipped |
| `scripts/e2e-flow.ts` on a migrated, seeded scratch DB, placeholder cutoff | 109 pass, 0 fail |
| Backend image from the real tree | fails at `check-deploy-config` while the placeholder is set, as designed |
| Images from a scratch copy with a TEST cutoff | backend runtime 459 MB, tools 2.05 GB, web 1.38 GB (38 pages prerendered); all run as `node` on Node v24.22.0 |
| Image contents | Tools image holds only `check-deploy-config.cjs` and `create-first-admin.ts` from `scripts/`. No `test-smtp`, `verify-partner-api`, `e2e-flow`, tests, `.env` or key files in any image; no secret-like values in image history. `enforce-https.middleware.js` is in `dist`. |
| Compose (original and a scratch-renamed copy) | `config` parses. Scratch project `hx3verify`: own volumes, loopback ports, DB with no published port on an `internal: true` network. |
| Running scratch stack | Migrate through the tools image applied cleanly; backend and web healthy. `/health` with `X-Forwarded-Proto: https`: 200 plus HSTS. In-container forged-Host results identical to the app probe above; the default `127.0.0.1` Host without the proxy header gets 400, which is why the health check sends the header. `/api/v1/products` unauthenticated: 401. Web `/login`: 200 with CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`. |
| Backend image with invalid `ALLOWED_HOSTS` | exits 1 with `Invalid environment variables` |
| `bash -n` on `backup.sh`, `restore-test.sh`, `backend-entrypoint.sh` | pass (syntax only; not executed) |

### 10.3 Unexplained intermittent failure

One full-suite run reported 1546 tests with 2 failing files: `tests/admin-product-update.test.ts` and `tests/rate-limit-bypass.test.ts` (1541 pass, 2 fail, 3 skipped). That run overlapped with Docker Desktop starting up on the same machine. Both files pass when run alone (23 / 23), and three further complete runs were clean (1567 / 1564 / 0 / 3). The failure output was not captured, so the cause is unknown; machine load causing a timeout is a guess, not a finding. It happened once in four full runs. Action: re-run the full suite on the release revision; if it recurs, capture the failing output before changing anything.

### 10.4 Not run, so not claimed

- Backup and restore scripts (syntax-checked only; their change this phase is comment-only) and the crash-restart test on the rebuilt images.
- Role-migration guard scenarios (FINANCE, RESELLER_AGENT, legacy ADMIN without acknowledgement) on the rebuilt images; migrations are unchanged since the earlier phase where they were run.
- `create-first-admin` on the rebuilt tools image.
- `e2e-flow.ts` and the DB-backed suites under a future cutoff (earlier phase only); this phase used the placeholder, which behaves like a past cutoff.
- Browser (headless Chrome) check against the rebuilt stack; only `curl` header checks were done.
- Anything through a real CDN or reverse proxy (HTTPS, forwarded headers, `TRUST_PROXY_HOPS` on real traffic, 6 MB uploads), HSTS over real TLS, real SMTP or SMSlenz, a registration with a real OTP, Linux secret-file permissions on the VPS, production hostnames.
- Images from a committed, tagged revision with the real cutoff.

### 10.5 Production blockers (all open)

Section 6 lists them. In short: launch time and cutoff; commits 4 and 5 not made and nothing tagged or pushed; PostCSS advisory deferred; open infrastructure and business facts; `ALLOWED_HOSTS` value; image licensing; the intermittent failure; the unrun checks above. Recommendation unchanged: **NO-GO**.

## 11. Web release decisions and verification (2026-10-19, scratch resources only; nothing staged, committed, pushed or deployed)

### 11.1 Decisions applied

| Item | Result |
|---|---|
| Company logo | `apps/web/public/hexalytelogo.jpeg` is owned and authorised by the company and ships unchanged (51,890 bytes, md5 `0238df0d2519097c5c486e230d29f68b`, identical before and after this phase and inside the built web image). It is referenced by `AuthLayout.tsx` (desktop and mobile brand rows) and `LoginThemeSettings.tsx` (preview). |
| Landscape pictures | No picture ships any more except the logo. The login panel, the dashboard and PageHero banners and the Admin Appearance previews use neutral gradients (`HERO_FALLBACK_DARK` / `HERO_FALLBACK_LIGHT` in `appearance-utils.ts` mirrored in the four hero rules of `globals.css`, and `LOGIN_FALLBACK_GRADIENT`). Nothing is downloaded for the default look. An Admin can still upload a hero, login or logo image (Admin > Settings > Appearance); a custom login picture that fails to load falls back to the gradient. The Admin previews show a gradient swatch instead of an `<img>` while nothing is uploaded, so there is no broken-image preview. Copy that said "built-in landscape" now says "default background". |
| Other images | `apps/web/public/` (6 other files) and `apps/web/src/assets/` (8 files) stay untracked, untouched and excluded from the release; nothing references them. |
| Content-Security-Policy | `img-src 'self' blob: data:` (the unused `https://images.unsplash.com` is removed); `style-src` / `font-src` still allow Google Fonts, which `globals.css` imports. `docs/DEPLOYMENT.md` section 4 item 10 now says so. |
| Test fixture | `reseller-error-states-ui.test.ts` uses neutral fixture data (Nimal Perera, Kandy Traders) instead of a personal name. |

### 11.2 Dockerfile.web requires `apps/web/public/`

`deploy/Dockerfile.web` runtime stage has `COPY --from=build /app/apps/web/public /app/apps/web/public`. Without a `public/` directory the web image build fails. Negative control on a scratch tree without it: `docker build` exit 1, `failed to calculate checksum ... "/app/apps/web/public": not found`, no image created. With the logo committed the directory exists and the build succeeds. Do not remove the logo from the web commit unless the Dockerfile is changed too.

### 11.3 Verification on the proposed release tree (HEAD `667fbf5` + commits 3 to 5 overlaid in a scratch directory)

| Check | Result |
|---|---|
| Path groups (from the working tree) | Commit 3 web: 109 paths (108 code + the logo); commit 4 deploy and docs: 15; commit 5 tests: 82; 14 images excluded. 109 + 15 + 82 + 14 = 220 pending files; no overlap, none unaccounted for. |
| `npm ci`, `prisma generate`, backend and web `tsc --noEmit` | pass, 0 errors |
| Appearance, login, CSP and error-state UI tests (14 files) | 345 / 345 pass |
| Full DB-free backend suite | 1570 tests: **1567 pass, 0 fail, 3 skipped** (the DB-backed suites: `reseller-approval-flow`, `reseller-registration-security`, `demo-requests`; not run in this phase) |
| `docker build -f deploy/Dockerfile.web` (scratch tag `hexalyte-verify/reseller-web:v4`, test API URL `https://api.scratch.invalid/api/v1`) | exit 0 in 101 s, 38 pages prerendered, image 1.37 GB, runs as `node` on Node v24.22.0; `public/` holds only the logo (md5 unchanged); no other pictures or `.env*` files in the image |
| Compose (`deploy/docker-compose.prod.yml`, scratch env and dummy secret file; no containers started) | `config` valid: backend and web published on 127.0.0.1 only, database on an `internal: true` network with no published port, `read_only`, `cap_drop`, `no-new-privileges` set, one-shot jobs behind the `tools` profile |
| Dockerfile COPY sources | every source of `Dockerfile.backend` and `Dockerfile.web` exists in the release tree and none is excluded by `.dockerignore` |

### 11.4 Release hazards

- Build release images from a clean checkout (or `git archive`) of the tagged commit, not from a developer working tree. The Docker context is the repository root and `COPY apps/web apps/web` copies everything under `apps/web/public/`: in the current working tree that includes six untracked, unapproved pictures, which would be baked into the image. A clean checkout contains only the logo. Working-tree files are also CRLF on this machine; a checkout is LF.
- The placeholder cutoff still makes the backend image build fail by design.
- `ALLOWED_HOSTS` must be set in `deploy/env.production`.

### 11.5 Still not verified

Backend runtime and tools images were not rebuilt in this phase (their inputs are unchanged since the earlier phases). Nothing has been run through the real CDN, proxy or TLS path, and no real email, SMS or OTP has been tested. A real browser has not yet looked at the gradient login page or dashboard. The recommendation remains **NO-GO** until the blockers in section 6 are closed.

## 12. Cutoff-independent tests and release state (2026-10-19, scratch resources only; nothing staged, committed, pushed or deployed)

### 12.1 Finding and fix

With a future launch cutoff compiled into `src/config/account-verification.config.ts` (which image builds need), 18 tests in `sms-gateway-otp.test.ts` failed and one DB-backed test in `reseller-registration-security.test.ts` failed: they exercise the real registration and login gate and assume a brand-new account must verify before login, which is false for a "legacy" account created before a future cutoff. With the placeholder they passed. Once the real launch time is committed, the suite would have been red.

Fix (tests only; the application source and the shipped placeholder are unchanged): `tests/helpers/verification-cutoff.ts` exports `TEST_VERIFICATION_CUTOFF` (`2026-01-01T00:00:00+05:30`, in the past) and `pinVerificationCutoff()`, which tells the test process's module cache that the compiled constant has that value. It throws if called after the verification module has loaded, so it can never silently do nothing. Both affected suites call it before importing the app. `tests/verification-cutoff-pin.test.ts` (3 tests) covers the helper, including that the test value is never written into `src/`. Tests of the pure legacy-access rules already passed their own cutoff and are untouched. The two trailing blank lines in `customer-account-actions.test.ts` and `new-trial-workflow.test.ts` are removed.

### 12.2 Results (scratch copy of the release tree; the scratch source carried the future TEST cutoff `2099-01-01T00:00:00+05:30`, the repository still carries the placeholder)

| Check | Result |
|---|---|
| `sms-gateway-otp` + `verification-cutoff-pin`, future TEST cutoff | 51 / 51 pass |
| Full DB-free suite, future TEST cutoff | 1573 tests: **1570 pass, 0 fail, 3 skipped** |
| Full DB-free suite, placeholder cutoff (as shipped) | 1573 tests: 1570 pass, 0 fail, 3 skipped |
| DB-backed suites (`reseller-approval-flow`, `reseller-registration-security`, `demo-requests`) on a throwaway Postgres (127.0.0.1:55436), future TEST cutoff | 40 / 40 pass |
| `scripts/e2e-flow.ts` on a seeded scratch clone, future TEST cutoff | 109 passed, 0 failed |
| Backend and web `tsc --noEmit` | 0 errors |

### 12.3 Release state

Commits made: `5646d48`, `667fbf5`, `49e0c10`. Pending: commit 4 (15 paths: `deploy/*` 9, `apps/backend/Dockerfile`, `docker-compose.yml`, `apps/backend/.env.example`, 3 docs) and commit 5 (84 test paths). Clean-checkout image builds from the tree after commit 3 plus the content of commits 4 and 5 (backend runtime, tools and web, scratch tags) all succeeded; the scratch stack came up healthy, forged `Host` headers were refused, and only the logo is served as a picture. The recommendation remains **NO-GO** until the section 6 blockers are closed.
