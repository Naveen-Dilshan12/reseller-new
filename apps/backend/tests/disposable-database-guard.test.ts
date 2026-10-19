import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OVERRIDE_VALUE, OVERRIDE_VARIABLE, disposableDatabaseUrl, isLoopbackHost } from './helpers/disposable-database'

/**
 * The guard that keeps the DB-backed suites and scripts/e2e-flow.ts away from any database that is not local and disposable
 * (tests/helpers/disposable-database.ts). Database-free; nothing here connects to anything. Every URL below is a throwaway.
 */

const SECRET = 'PwThatMustNeverBePrinted'
const url = (host: string, extra = '') => `postgresql://someuser:${SECRET}@${host}:5432/somedb${extra}`
const guard = (env: Record<string, string | undefined>, options?: Parameters<typeof disposableDatabaseUrl>[1]) => disposableDatabaseUrl(env as NodeJS.ProcessEnv, options)

describe('isLoopbackHost', () => {
  it('accepts exactly 127.0.0.0/8, localhost and ::1', () => {
    for (const host of ['127.0.0.1', '127.255.255.254', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]']) assert.equal(isLoopbackHost(host), true, host)
  })

  it('rejects everything else, including look-alikes', () => {
    for (const host of ['db.example.com', '10.0.0.5', '192.168.1.10', '0.0.0.0', '128.0.0.1', '127.0.0.256', '127.0.0.1.evil.com', 'localhost.evil.com', 'evil-localhost', '::ffff:127.0.0.1', '', '1270.0.0.1'])
      assert.equal(isLoopbackHost(host), false, JSON.stringify(host))
  })
})

describe('disposableDatabaseUrl', () => {
  it('returns undefined when nothing is configured, so the suites skip themselves', () => {
    assert.equal(guard({}), undefined)
    assert.equal(guard({ E2E_DATABASE_URL: '' }), undefined)
  })

  it('accepts a loopback database and returns the URL unchanged', () => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]', '127.0.0.5']) {
      const u = url(host)
      assert.equal(guard({ E2E_DATABASE_URL: u }), u, host)
      assert.equal(guard({ E2E_DATABASE_URL: u, DATABASE_URL: u }), u, `${host} with the same DATABASE_URL`)
    }
    const socket = 'postgresql://someuser@localhost/somedb?host=/var/run/postgresql'
    assert.equal(guard({ E2E_DATABASE_URL: socket }), socket, 'a local unix-socket directory')
  })

  it('rejects a non-loopback host by default, in every spelling, without echoing any part of the URL', () => {
    const remote = [url('db.example.com'), url('10.1.2.3'), url('0.0.0.0'), url('127.0.0.1.evil.com'), url('localhost.evil.com'), `postgresql://u:${SECRET}@127.0.0.1@evil.example.net:5432/d`, `postgres://u:${SECRET}@h.example.org/d?host=db.example.org`, `postgresql://u:${SECRET}@localhost/d?host=db.example.org`, `postgresql://u:${SECRET}@127.0.0.1/d?hostaddr=10.0.0.5`]
    for (const E2E_DATABASE_URL of remote) {
      assert.throws(() => guard({ E2E_DATABASE_URL }), (err: Error) => {
        assert.match(err.message, /not on this machine/)
        for (const leaked of [SECRET, 'someuser', 'example.com', 'example.net', 'example.org', 'evil', 'somedb', '10.1.2.3']) assert.ok(!err.message.includes(leaked), `leaked ${leaked}`)
        return true
      }, E2E_DATABASE_URL.replace(SECRET, '***'))
    }
  })

  it('needs the exact, clearly named confirmation to allow a remote host, and nothing weaker', () => {
    const E2E_DATABASE_URL = url('db.example.com')
    assert.equal(guard({ E2E_DATABASE_URL, [OVERRIDE_VARIABLE]: OVERRIDE_VALUE }), E2E_DATABASE_URL)
    for (const weak of ['1', 'true', 'yes', 'I-KNOW', OVERRIDE_VALUE.toLowerCase(), `${OVERRIDE_VALUE} `]) assert.throws(() => guard({ E2E_DATABASE_URL, [OVERRIDE_VARIABLE]: weak }), /not on this machine/, weak)
    assert.match(OVERRIDE_VARIABLE, /^E2E_ALLOW_NON_LOOPBACK_DATABASE$/)
  })

  it('rejects values that are not a postgres URL, without showing them', () => {
    for (const E2E_DATABASE_URL of ['not a url', 'mysql://u:pw@127.0.0.1/d', 'http://127.0.0.1/d', `//${SECRET}`]) {
      assert.throws(() => guard({ E2E_DATABASE_URL }), (err: Error) => !err.message.includes(SECRET) && /E2E_DATABASE_URL/.test(err.message))
    }
  })

  it('refuses a DATABASE_URL that differs (for example one supplied by .env), unless told it is overwritten anyway', () => {
    const E2E_DATABASE_URL = url('127.0.0.1')
    const DATABASE_URL = url('db.example.com')
    assert.throws(() => guard({ E2E_DATABASE_URL, DATABASE_URL }), (err: Error) => /different value/.test(err.message) && !err.message.includes(SECRET) && !err.message.includes('example.com'))
    assert.equal(guard({ E2E_DATABASE_URL, DATABASE_URL }, { requireSameDatabaseUrl: false }), E2E_DATABASE_URL)
    assert.equal(guard({ E2E_DATABASE_URL }), E2E_DATABASE_URL, 'an unset DATABASE_URL is fine')
  })
})

describe('every database-writing entry point uses the guard', () => {
  const backend = path.resolve(__dirname, '..')
  const read = (file: string) => fs.readFileSync(path.join(backend, file), 'utf8')
  const entryPoints = ['tests/reseller-approval-flow.test.ts', 'tests/reseller-registration-security.test.ts', 'tests/demo-requests.test.ts', 'scripts/e2e-flow.ts']

  it('reads E2E_DATABASE_URL only through disposableDatabaseUrl()', () => {
    for (const file of entryPoints) {
      const source = read(file)
      assert.match(source, /disposableDatabaseUrl\(/, `${file} calls the guard`)
      assert.ok(!/=\s*process\.env\.E2E_DATABASE_URL\b/.test(source), `${file} still reads E2E_DATABASE_URL directly`)
    }
  })

  it('scripts/e2e-flow.ts refuses a remote database before it connects to or imports anything, and never prints the URL', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-guard-'))
    try {
      const run = spawnSync(process.execPath, [require.resolve('tsx/cli'), path.join(backend, 'scripts/e2e-flow.ts')], {
        cwd,
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          PATH: process.env.PATH ?? '',
          SystemRoot: process.env.SystemRoot ?? '',
          E2E_DATABASE_URL: url('db.example.com'),
          DEMO_ADMIN_EMAIL: 'admin@test.invalid',
          DEMO_ADMIN_PASSWORD: 'not-a-real-password',
        },
      })
      assert.equal(run.status, 2, `${run.stdout}${run.stderr}`)
      const output = `${run.stdout}${run.stderr}`
      assert.match(output, /not on this machine/)
      for (const leaked of [SECRET, 'someuser', 'db.example.com']) assert.ok(!output.includes(leaked), `output leaked ${leaked}`)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })
})
