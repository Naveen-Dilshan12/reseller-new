import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Express } from 'express'

const ENV_FILE = /(^|[\\/])\.env(\.[^\\/]*)?$/

/**
 * Makes every `.env*` file look like it does not exist. Two things read one on import and neither can be
 * told otherwise: `src/config/env.ts` (`dotenv.config()`) and the generated `@prisma/client` (its import-time
 * env-conflict check reads apps/backend/.env). The guard sits in front of the sync fs calls they use.
 */
function hideEnvFiles() {
  const target = fs as unknown as Record<string, (...args: unknown[]) => unknown>
  const isEnvFile = (p: unknown) => typeof p === 'string' && ENV_FILE.test(p)

  const exists = target.existsSync
  target.existsSync = (p) => (isEnvFile(p) ? false : exists(p))

  for (const name of ['readFileSync', 'openSync', 'statSync', 'lstatSync', 'accessSync', 'createReadStream']) {
    const original = target[name]
    target[name] = (p, ...rest) => {
      if (isEnvFile(p)) throw Object.assign(new Error(`ENOENT: no such file or directory, ${name} '${String(p)}'`), { code: 'ENOENT' })
      return original(p, ...rest)
    }
  }
}

/**
 * Lets a test import real backend modules with no database and no `.env` file:
 *  - `.env*` files are hidden from the process (see `hideEnvFiles`);
 *  - the settings `env.ts` requires get throwaway values (they override anything already in the shell);
 *  - `src/config/database` is replaced by `fakePrisma`, so no PrismaClient is ever created.
 *
 * Call it before the first `await import('../src/...')`. Node runs each test file in its own process, so the
 * changes do not leak into other files.
 */
export function installHermeticBackend(fakePrisma: object) {
  hideEnvFiles()
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://hermetic.invalid:5432/never-connected',
    JWT_ACCESS_SECRET: crypto.randomBytes(32).toString('hex'),
    ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
    UPLOAD_DIR: path.join(os.tmpdir(), 'hxr-hermetic-uploads'),
    CORS_ORIGINS: 'http://localhost:3000',
  })

  const databaseModule = require.resolve('../../src/config/database')
  const unavailable = async () => {
    throw new Error('Database access is not available in a hermetic test')
  }
  require.cache[databaseModule] = {
    id: databaseModule,
    filename: databaseModule,
    loaded: true,
    exports: { prisma: fakePrisma, disconnectDatabase: unavailable, checkDatabaseHealth: unavailable },
  } as unknown as NodeModule
}

/**
 * Wraps a (nested) fake so that touching anything it does not define fails loudly instead of
 * returning `undefined`: a code path the test did not anticipate becomes a clear error.
 */
export function strictFake<T extends object>(label: string, impl: T): T {
  return new Proxy(impl, {
    get(target, prop, receiver) {
      if (prop in target || typeof prop === 'symbol' || prop === 'then') {
        const value = Reflect.get(target, prop, receiver)
        return value && typeof value === 'object' && !(value instanceof Date) ? strictFake(`${label}.${String(prop)}`, value) : value
      }
      throw new Error(`Unexpected use of ${label}.${String(prop)} in a database-free test`)
    },
  })
}

/** Serves `app` on an ephemeral loopback port and returns a tiny JSON client for it. */
export async function serve(app: Express) {
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    /** `rawBody` is sent as-is (for malformed JSON); otherwise `body` is JSON-encoded. */
    async call(method: string, urlPath: string, opts: { token?: string; body?: unknown; rawBody?: string } = {}) {
      const payload = opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body))
      const res = await fetch(`${baseUrl}${urlPath}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
        ...(payload === undefined ? {} : { body: payload }),
      })
      return { status: res.status, headers: res.headers, json: (await res.json().catch(() => null)) as any }
    },
  }
}
