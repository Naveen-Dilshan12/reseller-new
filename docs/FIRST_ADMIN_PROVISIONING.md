# First-admin provisioning (PROPOSAL, nothing here has been run)

Target: the fresh PostgreSQL database on the production VPS, for `https://partner.hexalyte.com`.
Admin email: `adminpartner@hexalyte.com`. The email is not a secret; **the password appears nowhere in this repository.**

Every step marked **[APPROVAL]** is a production operation and needs your explicit go-ahead at the time. None has been done.

## 1. What the account is

- Role `ADMIN`, status `ACTIVE`. It is the platform's **only** staff role, and **it receives the full permission set currently
  assigned to ADMIN** (`apps/backend/src/rbac/permissions.ts`: `ADMIN` is granted every defined permission; the script prints
  "ADMIN holds N of N"). That includes these powerful permissions:

  | Permission | What it allows |
  |---|---|
  | `users:manage` | manage platform user accounts |
  | `resellers:bank-reveal` | reveal partners' decrypted bank account details |
  | `integrations:manage` | configure partner integrations and their credentials |
  | `settings:manage` | change platform settings, including the SMS gateway credentials, commission levels and company bank details |

  There is no narrower staff role, and creating one would change roles and permissions, which is out of scope. "Required permissions
  only" therefore means: one ADMIN, created once, used only for administration, protected like a root account.
- It needs no `emailVerified` / `phoneVerifiedAt`: platform roles always pass the verification gate.
- No second factor exists in the application. Mitigate with: a long unique password, the existing lockout (5 failures locks the
  account for 15 minutes), the login rate limit, and, if your CDN supports it, an access rule on the admin routes.
- The mailbox `adminpartner@hexalyte.com` must exist and SMTP must work, because password reset is the only recovery path.

## 2. The script and what it refuses

`apps/backend/scripts/create-first-admin.ts`, run only inside the one-shot `admin-init` container (never as a service, never in the
runtime image). The existing seed (`prisma/seed.ts`) is **not** used: it loads `.env`, prints the admin email, and inserts demo
products with prices.

**Modes.** Run with no arguments the script is **check-only**: it runs every check below, reads and validates the password file, and
writes nothing. The **only** thing that enables writes is the command-line flag `--apply`. No environment variable is consulted for
the mode, and any other argument (including the old `--dry-run`, or a typo such as `--aply`) is an error. A mistake in an environment
variable can therefore never turn a check into a write.

It aborts, writing nothing, unless **all** of these are true:

| Check | Why |
|---|---|
| `EXPECT_DB_HOST` and `EXPECT_DB_NAME` are both set and equal the host and database name in `DATABASE_URL` | cannot be pointed at another database by a stray variable; missing means refuse |
| after connecting, PostgreSQL's own `current_database()` equals `EXPECT_DB_NAME` (first statement on the connection) | what the server says it is, not what the URL claims |
| `_prisma_migrations` exists and every migration directory shipped in the image is recorded as finished | the database is fully migrated |
| no row is unfinished, rolled back, or unknown to this release | no failed or foreign migration state; nothing is auto-resolved |
| enum `UserRole` is exactly `(ADMIN, SELLER)` | the role reconciliation migration really ran |
| the `users` table is empty | bootstrap only; it is not an account-recovery tool |
| the password file exists and satisfies the app's password rules (10 to 72 characters, lower, upper, digit) | no weak or missing secret |

`EXPECT_DB_NAME` is deliberately **not** in the Compose file: you pass it on the command line as your own statement of which
database you mean to change.

**Concurrency.** With `--apply` the empty-table check is repeated **inside the creating transaction**, after taking a
transaction-level PostgreSQL advisory lock (`pg_advisory_xact_lock(7305002)`; the only other lock the app uses is 7305001 for the SMS
cap). A second run started at the same moment blocks on that lock until the first one commits or rolls back, then re-counts the
users, sees the first run's row, and refuses. The lock is released automatically at COMMIT or ROLLBACK, so a crashed run cannot leave
it held. The unlocked "check, then create" pattern would let both through; a test with an in-memory stand-in demonstrates that the
unlocked version does and the locked version does not.

**Writes.** With `--apply` it creates the user and one `audit_logs` row (action `AUTH_ADMIN_BOOTSTRAPPED`, actor SYSTEM, entity
`User`) in a **single transaction**, after the lock and the re-check; if either insert fails, both roll back, so there is never a user
without its audit entry. It prints only the new user id, the database name and host. It never prints the password, hash, email or the
connection URL (the URL contains the database password and is never echoed, even in errors).

## 3. Password handling

Never reuse a password that was shared in chat. Generate a new one that has never been typed anywhere else:

- **Recommended (nothing is transmitted):** generate it on the VPS into a RAM-backed file, read it once in your own SSH session,
  store it in your password manager, then delete the file. See step 7 below.
- Alternative: generate it in your password manager and write it to the file on the VPS with a silent prompt
  (`read -rs`) so it never enters shell history or command lines.
- Never put it in an environment variable, a Compose file, `docker run -e`, CI logs, a ticket, an email or this repository.
- The first thing the admin does after the first login is **change it** (Profile, change password). That revokes all sessions and
  means the server-generated value stops being valid.

## 4. Prerequisites still outstanding

1. The VPS inspection output, and your approval for each server operation.
2. Volumes, `deploy/secrets/db_password`, `deploy/env.production`, `deploy/compose.env` created on the server (see DEPLOYMENT.md).
3. All 7 migrations applied to the fresh database, **after** a rehearsal of that from-zero path on a scratch database (not done).
4. Images built for one immutable `APP_VERSION`, with the verification cutoff set by you (the build fails without it).
5. Prisma client generation and the backend/web type checks (blocked on your approval; the new script's type-check status is unknown
   until then).
6. A working SMTP configuration and the mailbox above, so password reset and recovery work.
7. Decision on API hostname, proxy, CDN and hop count (DEPLOYMENT.md section 2).
8. A verified backup procedure with an off-server destination, taken **immediately after** the admin exists.
9. Your approval of the diffs for `create-first-admin.ts`, its test, the Compose change and the docs.

## 5. Command sequence for the approved go-live (not to be run now)

`C` is `docker compose -p hexalyte-reseller -f deploy/docker-compose.prod.yml --env-file deploy/compose.env`, run on the VPS from
the repository checkout.

```sh
# 1. [APPROVAL] Database only. Confirm healthy and not reachable from outside.
$C up -d db
$C ps db

# 2. [APPROVAL] Read-only: see what is pending. On a fresh database expect every migration to be pending.
$C run --rm migrate                                  # = prisma migrate status

# 3. [APPROVAL, separate] Apply the migrations. Stop on ANY error; never run `migrate resolve` automatically.
$C run --rm migrate npx prisma migrate deploy

# 4. [APPROVAL] Read-only: must report that the database schema is up to date.
$C run --rm migrate

# 5. [APPROVAL] Create the temporary password file (RAM-backed, readable only by the container user), then read it ONCE.
umask 077
PW=/dev/shm/hexalyte-admin-password
until [ -s "$PW" ] && grep -q '[a-z]' "$PW" && grep -q '[A-Z]' "$PW" && grep -q '[0-9]' "$PW"; do
  openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 24 > "$PW"
done
chown 1000:1000 "$PW" && chmod 400 "$PW"
cat "$PW"; echo         # copy into your password manager NOW, then: clear

# 6. [APPROVAL] CHECK-ONLY (no arguments = no writes): every check, password file validated, nothing written.
#    EXPECT_DB_NAME is YOUR statement of the database you mean to change; type it from your own record, do not copy it from a file.
$C run --rm -e ADMIN_EMAIL=adminpartner@hexalyte.com -e ADMIN_NAME='Hexalyte Admin' -e EXPECT_DB_NAME=hexalyte_reseller \
   -v "$PW":/run/secrets/admin_password:ro admin-init
#    Expect: "Checks passed on database ..." and "CHECK ONLY (no --apply) ... nothing was written".

# 7. [APPROVAL] The real run: identical, plus the explicit --apply flag (the only database write besides migrations).
$C run --rm -e ADMIN_EMAIL=adminpartner@hexalyte.com -e ADMIN_NAME='Hexalyte Admin' -e EXPECT_DB_NAME=hexalyte_reseller \
   -v "$PW":/run/secrets/admin_password:ro admin-init npx tsx scripts/create-first-admin.ts --apply

# 8. Remove the temporary password file immediately (RAM-backed; a reboot would also clear it).
rm -f "$PW"; unset PW; history -c 2>/dev/null || true

# 9. [APPROVAL] Start backend and web, then verify (below).
$C up -d backend web
```

## 6. Verification after the real run

- The script printed `Created ADMIN user <id> on database "<name>" at host db`; the file in step 8 no longer exists.
- Sign in at `https://partner.hexalyte.com` with the generated password; **change the password immediately** (Profile).
- The session shows role `ADMIN`; the admin screens load; a SELLER-only page does not apply.
- Admin, Audit logs shows one `AUTH_ADMIN_BOOTSTRAPPED` entry (actor SYSTEM) followed by the login and password-change events.
- Running the script a second time refuses (`users table already has 1 row(s)`): confirm this with the check-only invocation (no `--apply`) only.
- Log in with a wrong password five times is **not** part of the test (it locks the real admin for 15 minutes).
- Immediately take and restore-test a backup (DEPLOYMENT.md section 8).

## 7. If something goes wrong

- Any refusal from the script is information, not an error to bypass. Read the listed reason; do not edit the checks.
- A failed or partially applied migration: stop. Do not insert rows by hand and do not run `migrate resolve`. Restore the backup into a
  new database and keep the failed one for analysis.
- The password file was seen by anyone, or the script ran with the wrong password: change the password immediately after the
  first login; if login is impossible, use the password-reset email (SMTP must work).
- The admin is locked out and email is broken: this needs a deliberate, separately approved database operation; there is no
  built-in recovery command, by design.
