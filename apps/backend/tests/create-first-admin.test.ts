import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  BOOTSTRAP_AUDIT_ACTION,
  BOOTSTRAP_LOCK_SQL,
  bootstrapAdmin,
  databaseTargetFromUrl,
  identityProblem,
  migrationDirectories,
  migrationProblems,
  parseMode,
  roleEnumProblem,
  type BootstrapClient,
  type BootstrapTx,
  type MigrationRow,
} from '../scripts/create-first-admin'

/**
 * Database-free: the script's decision logic is pure and exported, the write path runs against an in-memory fake, and importing the
 * script loads neither Prisma nor `.env`. The script itself is never executed here.
 */

const done = (name: string): MigrationRow => ({ migration_name: name, finished_at: new Date(), rolled_back_at: null })
const expected = ['20260929000000_init', '20261016090000_reconcile', '20261016090100_phone']
const scriptPath = path.join(__dirname, '..', 'scripts', 'create-first-admin.ts')
const source = fs.readFileSync(scriptPath, 'utf8')
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
const input = { email: 'admin@example.invalid', name: 'Test Admin', passwordHash: 'hash-placeholder' }

describe('create-first-admin: migration gate', () => {
  it('passes only when every shipped migration is finished and nothing else is recorded', () => {
    assert.deepEqual(migrationProblems(expected, expected.map(done)), [])
  })

  it('reports a migration that was never applied', () => {
    assert.deepEqual(migrationProblems(expected, expected.slice(0, 2).map(done)), ['not applied: 20261016090100_phone'])
  })

  it('reports a failed / unfinished migration and does not count it as applied', () => {
    const rows = [done(expected[0]), done(expected[1]), { migration_name: expected[2], finished_at: null, rolled_back_at: null }]
    const problems = migrationProblems(expected, rows)
    assert.ok(problems.some((p) => p.startsWith('FAILED or unfinished')))
    assert.ok(problems.some((p) => p.startsWith('not applied')))
  })

  it('reports a rolled-back migration', () => {
    const rows = [...expected.map(done), { migration_name: expected[1], finished_at: new Date(), rolled_back_at: new Date() }]
    assert.ok(migrationProblems(expected, rows).some((p) => p.startsWith('rolled back')))
  })

  it('reports a database that is ahead of / different from this code', () => {
    assert.deepEqual(migrationProblems(expected, [...expected.map(done), done('20270101000000_from_another_release')]), ['unknown to this code: 20270101000000_from_another_release'])
  })

  it('an empty migration table is a problem for every shipped migration', () => {
    assert.equal(migrationProblems(expected, []).length, expected.length)
  })

  it('reads the real migration directories shipped in the repository', () => {
    const dirs = migrationDirectories(path.join(__dirname, '..', 'prisma', 'migrations'))
    assert.ok(dirs.length >= 7)
    assert.deepEqual(dirs, [...dirs].sort())
  })
})

describe('create-first-admin: role enum gate', () => {
  it('accepts exactly (ADMIN, SELLER)', () => {
    assert.equal(roleEnumProblem(['ADMIN', 'SELLER']), null)
  })
  it('rejects the legacy five-role enum, a missing enum, and a reordered one', () => {
    assert.match(roleEnumProblem(['SUPER_ADMIN', 'ADMIN', 'FINANCE', 'RESELLER_ADMIN', 'RESELLER_AGENT'])!, /reconciliation migration has not run/)
    assert.match(roleEnumProblem([])!, /missing/)
    assert.ok(roleEnumProblem(['SELLER', 'ADMIN']))
  })
})

describe('create-first-admin: database identity (host AND name, fail closed)', () => {
  const ok = { host: 'db', db: 'hexalyte_reseller' }

  it('passes only when expected and actual host and database name all match', () => {
    assert.equal(identityProblem(ok, ok), null)
  })

  it('fails when EXPECT_DB_NAME is missing or empty', () => {
    assert.match(identityProblem({ host: 'db' }, ok)!, /EXPECT_DB_NAME is required/)
    assert.match(identityProblem({ host: 'db', db: '' }, ok)!, /EXPECT_DB_NAME is required/)
  })

  it('fails when EXPECT_DB_HOST is missing', () => {
    assert.match(identityProblem({ db: 'hexalyte_reseller' }, ok)!, /EXPECT_DB_HOST is required/)
  })

  it('fails on a different database name, naming both names', () => {
    const p = identityProblem(ok, { host: 'db', db: 'postgres' })!
    assert.match(p, /database name is "postgres", expected "hexalyte_reseller"/)
  })

  it('fails on a different host', () => {
    assert.match(identityProblem(ok, { host: 'other', db: 'hexalyte_reseller' })!, /database host is "other", expected "db"/)
  })

  it('fails closed when the actual host or database name cannot be determined', () => {
    assert.ok(identityProblem(ok, { db: 'hexalyte_reseller' }))
    assert.ok(identityProblem(ok, { host: 'db' }))
    assert.ok(identityProblem(ok, { host: 'db', db: '' }))
  })

  it('reads host and database name from the URL', () => {
    assert.deepEqual(databaseTargetFromUrl('postgresql://user:p%40ss@db:5432/hexalyte_reseller?schema=public'), { host: 'db', db: 'hexalyte_reseller' })
  })

  it('never echoes the URL or its password in an error', () => {
    for (const bad of [undefined, '', 'not a url with SuperSecret123', 'postgresql://u:SuperSecret123@/%E0%A4%A']) {
      try {
        const t = databaseTargetFromUrl(bad)
        // A parseable URL must still not leak anything through the identity message.
        const message = identityProblem({ host: 'x', db: 'y' }, t) ?? ''
        assert.ok(!message.includes('SuperSecret123'), message)
      } catch (err) {
        assert.ok(!String((err as Error).message).includes('SuperSecret123'), (err as Error).message)
      }
    }
    assert.throws(() => databaseTargetFromUrl('not a url with SuperSecret123'), (e: Error) => !e.message.includes('SuperSecret123'))
  })

  it('compares current_database() after connecting, before any other query, and uses names only in messages', () => {
    const connect = source.indexOf('new PrismaClient()')
    const identityQuery = source.indexOf('SELECT current_database()')
    const nextQuery = source.indexOf("to_regclass('public._prisma_migrations')")
    assert.ok(connect > 0 && identityQuery > connect && identityQuery < nextQuery, 'current_database() is the first statement on the connection')
    assert.ok(!/process\.env\.DATABASE_URL[^\n]*(console|Error)|(console|Error)[^\n]*process\.env\.DATABASE_URL/.test(code), 'the URL is never printed')
  })
})

describe('create-first-admin: writes only with the explicit --apply flag', () => {
  it('defaults to check-only', () => {
    assert.equal(parseMode([]), 'check')
  })

  it('applies only for --apply', () => {
    assert.equal(parseMode(['--apply']), 'apply')
  })

  it('rejects every other argument, including the old --dry-run and typos, without echoing it', () => {
    for (const bad of [['--dry-run'], ['--aply'], ['apply'], ['--apply', '--force'], ['--password=Sup3rSecretValue']]) {
      assert.throws(() => parseMode(bad), (e: Error) => /unknown argument/.test(e.message) && !e.message.includes('Sup3rSecretValue'), JSON.stringify(bad))
    }
  })

  it('is not influenced by environment variables, whatever they say', () => {
    const keys = ['ADMIN_DRY_RUN', 'ADMIN_APPLY', 'APPLY', 'DRY_RUN', 'ADMIN_MODE', 'CONFIRM', 'FORCE']
    const saved = keys.map((k) => process.env[k])
    try {
      for (const value of ['0', '1', 'true', 'false', 'apply', 'yes', '']) {
        for (const k of keys) process.env[k] = value
        assert.equal(parseMode([]), 'check', `env value ${JSON.stringify(value)}`)
      }
    } finally {
      keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])))
    }
  })

  it('reads no mode-related environment variable at all', () => {
    assert.ok(!/ADMIN_DRY_RUN|ADMIN_APPLY|process\.env\.[A-Z_]*(APPLY|DRY|MODE|CONFIRM|FORCE)/.test(code))
  })

  it('reaches the only write path (bootstrapAdmin) after the check-only return', () => {
    const mainBody = source.slice(source.indexOf('async function main()'))
    const gate = mainBody.indexOf("if (mode !== 'apply')")
    const call = mainBody.indexOf('bootstrapAdmin(')
    assert.ok(gate > 0 && call > gate, 'the check-only return comes before bootstrapAdmin')
    assert.equal(mainBody.split('bootstrapAdmin(').length - 1, 1, 'bootstrapAdmin is called exactly once')
    assert.ok(mainBody.indexOf('hashPassword(password)') > gate, 'nothing is hashed in check mode')
  })

  it('has no other write in main (no create / update / delete / upsert / execute outside bootstrapAdmin)', () => {
    const mainBody = code.slice(code.indexOf('async function main()'))
    assert.ok(!/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw/.test(mainBody))
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// In-memory stand-in for PostgreSQL's transaction + advisory-lock semantics (READ COMMITTED). No database is involved.
// ---------------------------------------------------------------------------------------------------------------------
function fakeDb(opts: { failAudit?: boolean; existingUsers?: number } = {}) {
  const committed = { users: Array.from({ length: opts.existingUsers ?? 0 }, (_, i) => ({ id: `pre-${i}` })) as { id: string }[], audits: [] as Record<string, unknown>[] }
  const log: string[] = []
  let lockTail: Promise<void> = Promise.resolve()
  const tick = () => new Promise<void>((r) => setImmediate(r))

  const client: BootstrapClient = {
    async $transaction(fn) {
      const pendingUsers: { id: string }[] = []
      const pendingAudits: Record<string, unknown>[] = []
      let release: (() => void) | undefined
      const tx: BootstrapTx = {
        async $executeRawUnsafe(sql) {
          assert.equal(sql, BOOTSTRAP_LOCK_SQL)
          log.push('lock')
          const previous = lockTail
          lockTail = new Promise<void>((r) => (release = r))
          await previous // blocks until the holder has committed or rolled back
        },
        user: {
          async count() {
            log.push('count')
            await tick()
            return committed.users.length + pendingUsers.length // READ COMMITTED: sees everything committed so far
          },
          async create(args) {
            log.push('create')
            await tick()
            const row = { id: `u-${committed.users.length + pendingUsers.length + 1}-${Math.random().toString(36).slice(2, 7)}` }
            pendingUsers.push(row)
            return { id: row.id, role: args.data.role, status: args.data.status }
          },
        },
        auditLog: {
          async create(args) {
            log.push('audit')
            await tick()
            if (opts.failAudit) throw new Error('audit insert failed')
            pendingAudits.push({ ...args.data })
            return {}
          },
        },
      }
      try {
        const result = await fn(tx)
        committed.users.push(...pendingUsers)
        committed.audits.push(...pendingAudits)
        return result
      } finally {
        release?.() // xact-level advisory lock: released at COMMIT or ROLLBACK
      }
    },
  }
  return { client, committed, log }
}

describe('create-first-admin: concurrent-bootstrap protection', () => {
  it('two concurrent runs create exactly one admin and one audit row; the other is refused', async () => {
    const db = fakeDb()
    const results = await Promise.allSettled([bootstrapAdmin(db.client, input), bootstrapAdmin(db.client, { ...input, email: 'second@example.invalid' })])
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    assert.match(String(rejected.reason.message), /already has 1 row\(s\)/)
    assert.equal(db.committed.users.length, 1)
    assert.equal(db.committed.audits.length, 1)
  })

  it('many simultaneous runs still create exactly one', async () => {
    const db = fakeDb()
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => bootstrapAdmin(db.client, { ...input, email: `a${i}@example.invalid` })))
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
    assert.equal(db.committed.users.length, 1)
  })

  it('control: the same fake WOULD let both through if the check were not serialised by the lock', async () => {
    const db = fakeDb()
    const racy = () =>
      db.client.$transaction(async (tx) => {
        const n = await tx.user.count() // check without taking the lock
        if (n > 0) throw new Error('exists')
        const u = await tx.user.create({ data: { ...input, role: 'ADMIN', status: 'ACTIVE' }, select: { id: true, role: true, status: true } })
        await tx.auditLog.create({ data: { actorType: 'SYSTEM', action: 'X', entityType: 'User', entityId: u.id, metadata: {} } })
      })
    await Promise.all([racy(), racy()])
    assert.equal(db.committed.users.length, 2, 'proves the fake interleaves, so the protection above is genuinely exercised')
  })

  it('takes the lock first, then re-counts, then creates, then writes the audit row, all in one transaction', async () => {
    const db = fakeDb()
    await bootstrapAdmin(db.client, input)
    assert.deepEqual(db.log, ['lock', 'count', 'create', 'audit'])
  })

  it('refuses without creating anything when a user already exists inside the transaction', async () => {
    const db = fakeDb({ existingUsers: 1 })
    await assert.rejects(bootstrapAdmin(db.client, input), /already has 1 row\(s\)/)
    assert.deepEqual(db.log, ['lock', 'count'])
    assert.equal(db.committed.users.length, 1)
    assert.equal(db.committed.audits.length, 0)
  })

  it('a failing audit insert rolls the user back (no user without its audit entry)', async () => {
    const db = fakeDb({ failAudit: true })
    await assert.rejects(bootstrapAdmin(db.client, input), /audit insert failed/)
    assert.equal(db.committed.users.length, 0)
    assert.equal(db.committed.audits.length, 0)
  })

  it('a failed run releases the lock so a later run can still bootstrap', async () => {
    const failing = fakeDb({ failAudit: true })
    await assert.rejects(bootstrapAdmin(failing.client, input))
    const next = await Promise.race([bootstrapAdmin(failing.client, input).catch((e: Error) => e.message), new Promise((r) => setTimeout(() => r('DEADLOCK'), 2000))])
    assert.notEqual(next, 'DEADLOCK')
  })

  it('uses a transaction-level advisory lock that differs from the SMS-cap lock (7305001)', () => {
    assert.match(BOOTSTRAP_LOCK_SQL, /^SELECT pg_advisory_xact_lock\(\d+\)$/)
    assert.ok(!BOOTSTRAP_LOCK_SQL.includes('7305001'))
  })
})

describe('create-first-admin: audit event', () => {
  it('uses the AUTH_ADMIN_BOOTSTRAPPED action, following the existing AUTH_* naming', async () => {
    assert.equal(BOOTSTRAP_AUDIT_ACTION, 'AUTH_ADMIN_BOOTSTRAPPED')
    const db = fakeDb()
    const user = await bootstrapAdmin(db.client, input)
    assert.equal(db.committed.audits.length, 1)
    const audit = db.committed.audits[0]
    assert.equal(audit.action, 'AUTH_ADMIN_BOOTSTRAPPED')
    assert.equal(audit.actorType, 'SYSTEM')
    assert.equal(audit.entityType, 'User')
    assert.equal(audit.entityId, user.id)
    assert.ok(!/hash|password|email/i.test(JSON.stringify(audit)), 'the audit row carries no secret or personal data')
  })

  it('never uses the old un-prefixed action name anywhere in the script or the docs', () => {
    const doc = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'docs', 'FIRST_ADMIN_PROVISIONING.md'), 'utf8')
    for (const text of [source, doc]) assert.ok(!/(?<!AUTH_)ADMIN_BOOTSTRAPPED/.test(text))
  })
})

describe('create-first-admin: static safety properties of the script source', () => {
  it('never reads .env and never uses the seed', () => {
    assert.ok(!/dotenv|config\/env|prisma\/seed|readFile\w*\([^)]*\.env/.test(code), 'no dotenv / env config / seed import in code')
  })

  it('hardcodes no email address, password or secret', () => {
    assert.ok(!/@hexalyte\.com/i.test(code))
    assert.ok(!/password\s*[:=]\s*['"`][^'"`]+['"`]/i.test(code))
  })

  it('never logs the password, its hash, the email or the connection URL', () => {
    const logs = source
      .split('\n')
      .filter((l) => /console\.(log|error|warn)/.test(l))
      .join('\n')
      .replace(/the password file was read and validated/, '')
      .replace(/change the password immediately/, '')
    assert.ok(!/password|hash|email|process\.env|DATABASE_URL|\burl\b/i.test(logs), logs)
  })

  it('creates a plain ADMIN inside the single transaction that also writes the audit row', () => {
    const boot = source.slice(source.indexOf('export async function bootstrapAdmin'), source.indexOf('async function main()'))
    assert.match(boot, /role: 'ADMIN', status: 'ACTIVE'/)
    assert.match(boot, /\$transaction/)
    assert.ok(boot.indexOf('BOOTSTRAP_LOCK_SQL') < boot.indexOf('tx.user.count()'))
    assert.ok(boot.indexOf('tx.user.count()') < boot.indexOf('tx.user.create'))
    assert.ok(boot.indexOf('tx.user.create') < boot.indexOf('tx.auditLog.create'))
  })

  it('checks identity, migrations, enum and the empty users table before the check-only return', () => {
    const gate = source.indexOf("if (mode !== 'apply')")
    for (const marker of ['identityProblem(expected, target)', 'identityProblem(expected, { host: target.host', 'migrationProblems(migrations', 'roleEnumProblem(labels)', 'prisma.user.count()']) {
      const at = source.indexOf(marker)
      assert.ok(at > 0 && at < gate, marker)
    }
  })
})
