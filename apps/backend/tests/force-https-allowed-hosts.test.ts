import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createEnforceHttps, normalizeHostHeader, parseAllowedHosts } from '../src/middleware/enforce-https.middleware'

/**
 * FORCE_HTTPS redirect: the target host must come from ALLOWED_HOSTS, never from the request. No database: the middleware
 * is exercised on throwaway Express apps, and env.ts is evaluated in a child process with a throwaway environment.
 */

const servers: Server[] = []
after(() => servers.forEach((s) => s.close()))

async function start(options: { enabled: boolean; allowedHosts: string[] }, trustProxy = 1) {
  const app = express()
  app.set('trust proxy', trustProxy)
  app.use(createEnforceHttps(options))
  app.get('/health', (_req, res) => res.json({ status: 'ok' }))
  app.get('/some/path', (_req, res) => res.json({ ok: true }))
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  servers.push(server)
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/** `fetch` refuses to set Host, so use a raw request for forged Host headers. */
function rawGet(base: string, pathAndQuery: string, headers: Record<string, string>) {
  const { hostname, port } = new URL(base)
  return new Promise<{ status: number; location?: string; body: string }>((resolve, reject) => {
    const req = require('node:http').request(
      { hostname, port, path: pathAndQuery, method: 'GET', headers },
      (res: import('node:http').IncomingMessage) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, body }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

describe('parseAllowedHosts / normalizeHostHeader', () => {
  it('lower-cases, trims and ignores empty entries', () => {
    assert.deepEqual(parseAllowedHosts(' Partner.Example.com , api.example.com,, ').hosts, ['partner.example.com', 'api.example.com'])
    assert.deepEqual(parseAllowedHosts('').hosts, [])
  })

  it('reports schemes, ports, paths, wildcards and underscores as invalid instead of dropping them silently', () => {
    const { hosts, invalid } = parseAllowedHosts('https://a.example.com,b.example.com:443,c.example.com/x,*.example.com,d_e.example.com,ok.example.com')
    assert.deepEqual(hosts, ['ok.example.com'])
    assert.equal(invalid.length, 5)
  })

  it('reduces a Host header to a bare hostname and rejects anything that is not hostname[:port]', () => {
    assert.equal(normalizeHostHeader('Partner.Example.com:8443'), 'partner.example.com')
    assert.equal(normalizeHostHeader('partner.example.com.'), 'partner.example.com')
    assert.equal(normalizeHostHeader(undefined), null)
    for (const bad of ['evil.com/path', 'a.com@evil.com', 'a.com, evil.com', 'a.com\r\nx: y', '[::1]:80', 'a b.com', '']) {
      assert.equal(normalizeHostHeader(bad), null, bad)
    }
  })
})

describe('createEnforceHttps', () => {
  it('is a no-op when disabled', async () => {
    const base = await start({ enabled: false, allowedHosts: [] })
    const res = await fetch(`${base}/some/path`, { redirect: 'manual' })
    assert.equal(res.status, 200)
  })

  it('lets requests through that the trusted proxy reports as https, with any Host (container health check included)', async () => {
    const base = await start({ enabled: true, allowedHosts: [] })
    const res = await fetch(`${base}/health`, { redirect: 'manual', headers: { 'x-forwarded-proto': 'https' } })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { status: 'ok' })
  })

  it('redirects plain HTTP to https for an allowed host, keeping path and query', async () => {
    const base = await start({ enabled: true, allowedHosts: ['partner.example.com'] })
    const res = await rawGet(base, '/some/path?a=1', { host: 'Partner.Example.com' })
    assert.equal(res.status, 301)
    assert.equal(res.location, 'https://partner.example.com/some/path?a=1')
  })

  it('drops a non-default port from the redirect target (https default is 443)', async () => {
    const base = await start({ enabled: true, allowedHosts: ['partner.example.com'] })
    const res = await rawGet(base, '/some/path', { host: 'partner.example.com:8080' })
    assert.equal(res.location, 'https://partner.example.com/some/path')
  })

  it('does NOT redirect a forged Host: 400, no Location header', async () => {
    const base = await start({ enabled: true, allowedHosts: ['partner.example.com'] })
    for (const host of ['evil.example.net', 'partner.example.com.evil.net', 'evil.net/partner.example.com', 'partner.example.com@evil.net']) {
      const res = await rawGet(base, '/some/path', { host })
      assert.equal(res.status, 400, host)
      assert.equal(res.location, undefined, host)
      assert.match(res.body, /HTTPS is required/)
    }
  })

  it('never redirects when the allow-list is empty (fail closed), but https traffic still works', async () => {
    const base = await start({ enabled: true, allowedHosts: [] })
    const plain = await rawGet(base, '/some/path', { host: 'partner.example.com' })
    assert.equal(plain.status, 400)
    assert.equal(plain.location, undefined)
    const proxied = await fetch(`${base}/some/path`, { headers: { 'x-forwarded-proto': 'https' } })
    assert.equal(proxied.status, 200)
  })

  it('ignores X-Forwarded-Proto when no proxy is trusted (trust proxy 0)', async () => {
    const base = await start({ enabled: true, allowedHosts: ['partner.example.com'] }, 0)
    const res = await rawGet(base, '/some/path', { host: 'partner.example.com', 'x-forwarded-proto': 'https' })
    assert.equal(res.status, 301)
  })
})

describe('ALLOWED_HOSTS in env.ts and app wiring', () => {
  const envModule = path.join(__dirname, '..', 'src', 'config', 'env.ts')
  const tsxCli = require.resolve('tsx/cli')
  const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-allowed-hosts-'))
  after(() => fs.rmSync(scratchCwd, { recursive: true, force: true }))

  function readHosts(extra: Record<string, string>) {
    const r = spawnSync(
      process.execPath,
      [tsxCli, '-e', `import { allowedHosts } from ${JSON.stringify(envModule)}; console.log('HOSTS=' + JSON.stringify(allowedHosts))`],
      {
        cwd: scratchCwd,
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

  it('defaults to an empty list', () => {
    const r = readHosts({})
    assert.equal(r.status, 0, r.err)
    assert.match(r.out, /HOSTS=\[\]/)
  })

  it('parses a valid list and refuses to start on an invalid one', () => {
    const ok = readHosts({ ALLOWED_HOSTS: 'Partner.example.com, api.example.com' })
    assert.equal(ok.status, 0, ok.err)
    assert.match(ok.out, /HOSTS=\["partner\.example\.com","api\.example\.com"\]/)
    assert.notEqual(readHosts({ ALLOWED_HOSTS: 'https://partner.example.com' }).status, 0)
  })

  it('app.ts uses the allow-list middleware and no longer builds a redirect from the raw Host header', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.ts'), 'utf8')
    assert.match(src, /createEnforceHttps\(\{ enabled: true, allowedHosts \}\)/)
    assert.doesNotMatch(src, /res\.redirect/)
  })
})
