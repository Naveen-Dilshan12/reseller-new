/**
 * Creates the FIRST platform ADMIN on a fresh, fully migrated database. PROPOSED: not yet run, not yet approved for production.
 * Full procedure: docs/FIRST_ADMIN_PROVISIONING.md.
 *
 * Why not prisma/seed.ts: the seed loads `.env` (dotenv/config), needs DEMO_ADMIN_* variables, prints the admin email, and
 * inserts demo products and prices. This script has one job and handles the password as a FILE.
 *
 * MODES. With no arguments the script is CHECK-ONLY: it runs every check and validates the password file, and writes nothing.
 * The ONLY thing that can enable writes is the command-line flag `--apply`. No environment variable is consulted for the mode, and
 * any other argument is an error, so a typo cannot silently turn into a write or be mistaken for one.
 *
 * Inputs (all explicit, no default can point at the wrong place):
 *   ADMIN_EMAIL          the admin's email address
 *   ADMIN_NAME           optional display name
 *   ADMIN_PASSWORD_FILE  file holding the password (default /run/secrets/admin_password); must satisfy the app's password rules
 *   EXPECT_DB_HOST       the database host you intend to write to
 *   EXPECT_DB_NAME       the database name you intend to write to (compared with the URL and with PostgreSQL's current_database())
 *   DATABASE_URL         supplied by deploy/backend-entrypoint.sh inside the tools container (never printed)
 *
 * It refuses to proceed unless ALL of these hold:
 *   1. EXPECT_DB_HOST and EXPECT_DB_NAME are both set and match DATABASE_URL, and after connecting, current_database() matches
 *      EXPECT_DB_NAME (fail closed on anything missing or different);
 *   2. every migration directory shipped in this image is recorded as finished, none failed / unfinished / rolled back, and the
 *      database knows no migration that is not shipped;
 *   3. the "UserRole" enum is exactly (ADMIN, SELLER), i.e. the role reconciliation migration really ran;
 *   4. the users table is EMPTY. With --apply this is checked AGAIN inside the creating transaction, under a lock (see
 *      bootstrapAdmin), so two concurrent runs can never both create an admin.
 * The account is a plain ADMIN: the platform's only staff role, with every permission the code grants it (including users:manage,
 * resellers:bank-reveal, integrations:manage and settings:manage; there is no narrower staff role, and this script changes no
 * authentication logic, roles or permissions). It never prints the password, its hash, the email or the connection URL; it does
 * not import src/config/env, so it never reads `.env`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { hashPassword, passwordSchema } from '../src/utils/password'
import { PERMISSIONS, permissionsFor } from '../src/rbac/permissions'

export type Mode = 'check' | 'apply'

/** `--apply` is the only accepted argument and the only way to enable writes. Environment variables are never consulted. */
export function parseMode(args: string[]): Mode {
  const unknown = args.filter((a) => a !== '--apply')
  // Only the COUNT is reported: an argument might be a password typed by mistake.
  if (unknown.length) throw new Error(`Refusing: ${unknown.length} unknown argument(s). The only accepted flag is --apply; with no arguments the script only checks.`)
  return args.includes('--apply') ? 'apply' : 'check'
}

export interface DatabaseTarget {
  host?: string
  db?: string
}

/** Host and database name from a connection URL. Never echoes the URL (it contains the password) in any error. */
export function databaseTargetFromUrl(url: string | undefined): { host: string; db: string } {
  if (!url) throw new Error('DATABASE_URL is not set')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('DATABASE_URL is not a valid URL')
  }
  let db: string
  try {
    db = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
  } catch {
    throw new Error('DATABASE_URL has an unreadable database name')
  }
  return { host: parsed.hostname, db }
}

/** Fail closed: a missing expectation, a missing actual value, or any difference is a problem. Names only, never credentials. */
export function identityProblem(expected: DatabaseTarget, actual: DatabaseTarget): string | null {
  if (!expected.host) return 'EXPECT_DB_HOST is required (the database host you intend to write to)'
  if (!expected.db) return 'EXPECT_DB_NAME is required (the database name you intend to write to)'
  if (!actual.host) return 'could not determine the database host'
  if (actual.host !== expected.host) return `database host is "${actual.host}", expected "${expected.host}"`
  if (!actual.db) return 'could not determine the database name'
  if (actual.db !== expected.db) return `database name is "${actual.db}", expected "${expected.db}"`
  return null
}

export interface MigrationRow {
  migration_name: string
  finished_at: Date | null
  rolled_back_at: Date | null
}

/** Problems (empty = the database matches the migrations shipped with this code exactly). Pure, so it is unit-tested. */
export function migrationProblems(expected: string[], rows: MigrationRow[]): string[] {
  const problems: string[] = []
  const done = new Set(rows.filter((r) => r.finished_at && !r.rolled_back_at).map((r) => r.migration_name))
  const known = new Set(expected)
  for (const name of expected) if (!done.has(name)) problems.push(`not applied: ${name}`)
  for (const r of rows) {
    if (!r.finished_at) problems.push(`FAILED or unfinished: ${r.migration_name}`)
    else if (r.rolled_back_at) problems.push(`rolled back: ${r.migration_name}`)
    if (!known.has(r.migration_name)) problems.push(`unknown to this code: ${r.migration_name}`)
  }
  return problems
}

export function roleEnumProblem(labels: string[]): string | null {
  const ok = labels.length === 2 && labels[0] === 'ADMIN' && labels[1] === 'SELLER'
  return ok ? null : `UserRole enum is (${labels.join(', ') || 'missing'}), expected (ADMIN, SELLER): the role reconciliation migration has not run`
}

export function migrationDirectories(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{14}_/.test(d.name))
    .map((d) => d.name)
    .sort()
}

/**
 * Transaction-level advisory lock that serialises every bootstrap attempt. It must differ from the other advisory lock the app uses
 * (7305001, the SMS daily-cap lock in modules/auth/verification.service.ts). It is released automatically at COMMIT or ROLLBACK.
 */
export const BOOTSTRAP_LOCK_SQL = 'SELECT pg_advisory_xact_lock(7305002)'
export const BOOTSTRAP_AUDIT_ACTION = 'AUTH_ADMIN_BOOTSTRAPPED'

/** The slice of a Prisma transaction client that bootstrapAdmin uses (kept narrow so it can be tested with a fake). */
export interface BootstrapTx {
  $executeRawUnsafe(sql: string): Promise<unknown>
  user: {
    count(): Promise<number>
    create(args: { data: { email: string; name: string; passwordHash: string; role: 'ADMIN'; status: 'ACTIVE' }; select: { id: true; role: true; status: true } }): Promise<{ id: string; role: string; status: string }>
  }
  auditLog: {
    create(args: { data: { actorType: 'SYSTEM'; action: string; entityType: string; entityId: string; metadata: Record<string, string> } }): Promise<unknown>
  }
}
export interface BootstrapClient {
  $transaction<T>(fn: (tx: BootstrapTx) => Promise<T>, options?: { timeout?: number }): Promise<T>
}

/**
 * The ONLY write path. One transaction does, in this order:
 *   1. take the advisory lock (a second concurrent run blocks here until the first commits or rolls back);
 *   2. re-count the users table and refuse if it is not empty (a READ COMMITTED statement, so after the lock it sees the first
 *      run's committed row; this is what makes "check, then create" race-free);
 *   3. create the ADMIN;
 *   4. insert the audit row.
 * Any failure, including the audit insert, rolls back everything, so there is never a user without its audit entry, and never two
 * bootstrapped admins. The password is already hashed by the caller (bcrypt must not run inside a timed transaction).
 */
export async function bootstrapAdmin(client: BootstrapClient, input: { email: string; name: string; passwordHash: string }) {
  return client.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(BOOTSTRAP_LOCK_SQL)
      const existing = await tx.user.count()
      if (existing > 0) throw new Error(`Refusing: the users table already has ${existing} row(s). This script only bootstraps an empty system.`)
      // ADMIN is a platform role, so it needs neither emailVerified nor phoneVerifiedAt (see config/account-verification.ts).
      const user = await tx.user.create({
        data: { email: input.email, name: input.name, passwordHash: input.passwordHash, role: 'ADMIN', status: 'ACTIVE' },
        select: { id: true, role: true, status: true },
      })
      await tx.auditLog.create({
        data: { actorType: 'SYSTEM', action: BOOTSTRAP_AUDIT_ACTION, entityType: 'User', entityId: user.id, metadata: { method: 'scripts/create-first-admin.ts' } },
      })
      return user
    },
    { timeout: 15_000 },
  )
}

async function main() {
  const mode = parseMode(process.argv.slice(2))

  const expected: DatabaseTarget = { host: process.env.EXPECT_DB_HOST, db: process.env.EXPECT_DB_NAME }
  const target = databaseTargetFromUrl(process.env.DATABASE_URL)
  const early = identityProblem(expected, target)
  if (early) throw new Error(`Refusing: ${early}`)

  const email = z.string().trim().toLowerCase().email().max(150).parse(process.env.ADMIN_EMAIL ?? '')
  const name = (process.env.ADMIN_NAME ?? 'Hexalyte Admin').trim().slice(0, 150) || 'Hexalyte Admin'
  const passwordFile = process.env.ADMIN_PASSWORD_FILE ?? '/run/secrets/admin_password'
  const password = passwordSchema.parse(fs.readFileSync(passwordFile, 'utf8').replace(/\r?\n$/, ''))

  // Lazy import: the generated client is only loaded when the script actually runs.
  const { PrismaClient } = await import('@prisma/client')
  const prisma = new PrismaClient()
  try {
    // First statement on the connection: what the server itself says it is, not what the URL claims.
    const [{ name: actualDb }] = await prisma.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`
    const late = identityProblem(expected, { host: target.host, db: actualDb })
    if (late) throw new Error(`Refusing: ${late}`)

    const [{ present }] = await prisma.$queryRaw<{ present: boolean }[]>`SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS present`
    if (!present) throw new Error('Refusing: the database has no migration history. Run the migrations first.')

    const rows = await prisma.$queryRaw<MigrationRow[]>`SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"`
    const migrations = migrationDirectories(path.resolve(__dirname, '..', 'prisma', 'migrations'))
    if (migrations.length === 0) throw new Error('Refusing: no migration directories found next to this script.')
    const problems = migrationProblems(migrations, rows)
    if (problems.length) throw new Error(`Refusing: the database does not match this release's migrations:\n  - ${problems.join('\n  - ')}`)

    const labels = (
      await prisma.$queryRaw<{ enumlabel: string }[]>`SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'UserRole' ORDER BY e.enumsortorder`
    ).map((r) => r.enumlabel)
    const enumProblem = roleEnumProblem(labels)
    if (enumProblem) throw new Error(`Refusing: ${enumProblem}`)

    const existing = await prisma.user.count()
    if (existing > 0) throw new Error(`Refusing: the users table already has ${existing} row(s). This script only bootstraps an empty system.`)

    const granted = permissionsFor('ADMIN')
    console.log(`Checks passed on database "${actualDb}" at host ${target.host}: ${migrations.length} migrations applied and matching, role enum correct, users table empty.`)
    console.log(`ADMIN holds ${granted.length} of ${PERMISSIONS.length} defined permissions (the platform has no narrower staff role).`)
    if (mode !== 'apply') {
      console.log('CHECK ONLY (no --apply): the password file was read and validated; nothing was written. Re-run with --apply to create the account.')
      return
    }

    const passwordHash = await hashPassword(password)
    const created = await bootstrapAdmin(prisma as unknown as BootstrapClient, { email, name, passwordHash })
    if (created.role !== 'ADMIN' || created.status !== 'ACTIVE') throw new Error('Created account does not have role ADMIN / status ACTIVE')
    console.log(`Created ADMIN user ${created.id} on database "${actualDb}" at host ${target.host}. Sign in, then change the password immediately.`)
  } finally {
    await prisma.$disconnect()
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
