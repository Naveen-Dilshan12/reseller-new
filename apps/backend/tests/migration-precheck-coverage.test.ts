import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Static only (reads files, no database): keeps prisma/precheck-account-verification.sql honest about which migrations
 * exist. It compares the migration DIRECTORIES on disk with the names the pre-check SQL lists, and says nothing about
 * what any database has applied.
 */

const prismaDir = path.join(__dirname, '..', 'prisma')
const sql = fs.readFileSync(path.join(prismaDir, 'precheck-account-verification.sql'), 'utf8')
const onDisk = fs
  .readdirSync(path.join(prismaDir, 'migrations'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\d{14}_/.test(d.name))
  .map((d) => d.name)
  .sort()

const quotedNames = [...sql.matchAll(/'(\d{14}_[A-Za-z0-9_]+)'/g)].map((m) => m[1])

describe('pre-check SQL migration coverage', () => {
  it('has at least the two initial migrations plus the five that may be pending', () => {
    assert.ok(onDisk.length >= 7, onDisk.join(', '))
  })

  it('lists exactly the migration directories that exist on disk (no missing, no stale name)', () => {
    assert.deepEqual([...new Set(quotedNames)].sort(), onDisk)
  })

  it('lists every directory once in each of the three expected-list queries (3a, 3b, 3c)', () => {
    for (const name of onDisk) {
      assert.equal(quotedNames.filter((n) => n === name).length, 3, `${name} must appear in 3a, 3b and 3c`)
    }
  })

  it('numbers the expected list in migration order', () => {
    const first = sql.slice(sql.indexOf('WITH expected'), sql.indexOf('FROM expected e LEFT JOIN'))
    const pairs = [...first.matchAll(/\((\d+),\s*'(\d{14}_[A-Za-z0-9_]+)'\)/g)].map((m) => [Number(m[1]), m[2]] as const)
    assert.deepEqual(pairs.map((p) => p[1]), onDisk)
    assert.deepEqual(pairs.map((p) => p[0]), onDisk.map((_, i) => i + 1))
  })

  it('does not assume production state: flags unapplied, failed, rolled-back, unknown and out-of-order migrations', () => {
    for (const marker of ['NOT APPLIED', 'ROLLED BACK - STOP', 'FAILED OR UNFINISHED - STOP', 'NOT IN (', 'missing_but_later_ones_applied']) {
      assert.ok(sql.includes(marker), marker)
    }
  })

  it('checks the verification cutoff against data without hardcoding a cutoff value', () => {
    assert.ok(sql.includes(":'cutoff'"), 'the cutoff must be supplied as a psql variable')
    assert.ok(sql.includes('needs_verification_users') && sql.includes('cutoff_after_newest_user'))
    assert.ok(!/UNCONFIRMED|ACCOUNT_VERIFICATION_REQUIRED_FROM\s*=/.test(sql.replace(/--.*$/gm, '')), 'no value is embedded in the executable SQL')
  })

  it('contains no statement that writes (INSERT only appears inside a comment)', () => {
    const executable = sql.replace(/--.*$/gm, '')
    assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT)\b/i.test(executable))
  })
})
