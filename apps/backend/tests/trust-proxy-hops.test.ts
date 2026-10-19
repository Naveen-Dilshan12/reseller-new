import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * P1: TRUST_PROXY_HOPS. No database: env.ts is evaluated in a child process with a throwaway environment
 * (never inherits DATABASE_URL or the developer's .env: cwd is a temp location without one and every required
 * variable is supplied explicitly), and req.ip is checked on a throwaway Express app.
 */

const envModule = path.join(__dirname, '..', 'src', 'config', 'env.ts')
const tsxCli = require.resolve('tsx/cli')

function readHops(extra: Record<string, string>) {
  const r = spawnSync(
    process.execPath,
    [tsxCli, '-e', `import { env } from ${JSON.stringify(envModule)}; console.log('HOPS=' + env.TRUST_PROXY_HOPS)`],
    {
      cwd: require('node:os').tmpdir(),
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        SystemRoot: process.env.SystemRoot ?? '',
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://scratch:scratch@127.0.0.1:1/none',
        JWT_ACCESS_SECRET: 'x'.repeat(40),
        ENCRYPTION_KEY: 'a1'.repeat(32),
        ...extra,
      },
    },
  )
  return { status: r.status, out: r.stdout, err: r.stderr }
}

describe('TRUST_PROXY_HOPS', () => {
  it('defaults to 1 (previous behaviour)', () => {
    const r = readHops({})
    assert.equal(r.status, 0, r.err)
    assert.match(r.out, /HOPS=1/)
  })

  it('accepts an explicit value and rejects out-of-range or non-numeric values', () => {
    assert.match(readHops({ TRUST_PROXY_HOPS: '2' }).out, /HOPS=2/)
    assert.notEqual(readHops({ TRUST_PROXY_HOPS: '9' }).status, 0)
    assert.notEqual(readHops({ TRUST_PROXY_HOPS: 'many' }).status, 0)
  })

  let server: Server | undefined
  after(() => server?.close())

  it('with 2 hops req.ip is the second-from-right X-Forwarded-For entry, so a spoofed left entry is ignored', async () => {
    const app = express()
    app.set('trust proxy', 2)
    app.get('/ip', (req, res) => res.json({ ip: req.ip }))
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve())
    })
    const { port } = server!.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${port}/ip`, {
      headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.9, 198.51.100.1' },
    })
    assert.deepEqual(await res.json(), { ip: '203.0.113.9' })
  })
})
