import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { authLimiter, registrationLimiter } from '../src/config/rate-limit'

/**
 * Regression tests for H2.
 *
 * `authLimiter` and `registrationLimiter` used to skip rate limiting for any
 * request carrying `x-test-bypass: true`, in every environment including
 * production. These tests mount the *actual* exported limiter middleware
 * (not a reimplementation) on a throwaway Express app and prove:
 *
 *   1. The header no longer skips the limit outside the real test runner.
 *   2. The legitimate skip (the process's own NODE_ENV === 'test', which
 *      `scripts/e2e-flow.ts` relies on) still works.
 *
 * No database is required; this never imports the real app or Prisma.
 */

function startApp(limiter: express.RequestHandler): Promise<{ server: Server; baseUrl: string }> {
  const app = express()
  app.use(limiter)
  app.get('/probe', (_req, res) => res.status(200).json({ ok: true }))
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` })
    })
  })
}

async function hit(baseUrl: string, claimBypass: boolean): Promise<number> {
  const res = await fetch(`${baseUrl}/probe`, {
    headers: claimBypass ? { 'x-test-bypass': 'true' } : {},
  })
  // Drain the body so the connection closes cleanly between requests.
  await res.arrayBuffer().catch(() => undefined)
  return res.status
}

describe('Rate-limit bypass header (H2 regression)', () => {
  const originalNodeEnv = process.env.NODE_ENV

  after(() => {
    process.env.NODE_ENV = originalNodeEnv
  })

  it(
    'authLimiter: x-test-bypass no longer skips the limit outside NODE_ENV=test, and the real test-mode skip still works',
    async () => {
      process.env.NODE_ENV = 'production'
      const { server, baseUrl } = await startApp(authLimiter)
      try {
        const LIMIT = 20 // authLimiter's configured non-test limit (config/rate-limit.ts)
        for (let i = 0; i < LIMIT; i++) {
          const status = await hit(baseUrl, true)
          assert.equal(status, 200, `request ${i + 1}/${LIMIT} should still be under the limit`)
        }
        // One more request, still claiming the bypass header: must now be rejected.
        const blocked = await hit(baseUrl, true)
        assert.equal(blocked, 429, 'x-test-bypass must not bypass the limiter outside NODE_ENV=test')

        // The legitimate skip (the test runner's own NODE_ENV) must still work,
        // even though the limiter's internal counter is already past the limit:
        // express-rate-limit's `skip` short-circuits before touching the store.
        process.env.NODE_ENV = 'test'
        const allowed = await hit(baseUrl, false)
        assert.equal(allowed, 200, 'NODE_ENV=test must still legitimately skip the limiter')
      } finally {
        server.close()
      }
    },
  )

  it(
    'registrationLimiter: x-test-bypass no longer skips the limit outside NODE_ENV=test, and the real test-mode skip still works',
    async () => {
      process.env.NODE_ENV = 'production'
      const { server, baseUrl } = await startApp(registrationLimiter)
      try {
        const LIMIT = 30 // registrationLimiter's configured non-test limit (config/rate-limit.ts)
        for (let i = 0; i < LIMIT; i++) {
          const status = await hit(baseUrl, true)
          assert.equal(status, 200, `request ${i + 1}/${LIMIT} should still be under the limit`)
        }
        const blocked = await hit(baseUrl, true)
        assert.equal(blocked, 429, 'x-test-bypass must not bypass the limiter outside NODE_ENV=test')

        process.env.NODE_ENV = 'test'
        const allowed = await hit(baseUrl, false)
        assert.equal(allowed, 200, 'NODE_ENV=test must still legitimately skip the limiter')
      } finally {
        server.close()
      }
    },
  )
})
