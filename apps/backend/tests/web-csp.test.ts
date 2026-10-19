import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * The web app's Content-Security-Policy (apps/web/next.config.mjs), checked by loading the real config file and reading the
 * header it would send. The weather widget is gone, so its service must not be allowed any more; every other source stays.
 *
 * Database-free; nothing here reads `.env`, runs Prisma or opens a connection. The config is imported once per case with a
 * different query string, so each case sees the environment it sets (NODE_ENV and NEXT_PUBLIC_API_URL) and nothing leaks.
 */

const WEB = path.resolve(__dirname, '../../web')
const CONFIG = pathToFileURL(path.join(WEB, 'next.config.mjs')).href
// A native import: the config is a plain ES module, and a query string makes each import a fresh evaluation.
const nativeImport = new Function('url', 'return import(url)') as (url: string) => Promise<{ default: { headers(): Promise<Array<{ headers: Array<{ key: string; value: string }> }>> } }>

let imports = 0
async function policy(env: { NODE_ENV: string; NEXT_PUBLIC_API_URL?: string }) {
  const saved = { NODE_ENV: process.env.NODE_ENV, NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL }
  process.env.NODE_ENV = env.NODE_ENV
  if (env.NEXT_PUBLIC_API_URL === undefined) delete process.env.NEXT_PUBLIC_API_URL
  else process.env.NEXT_PUBLIC_API_URL = env.NEXT_PUBLIC_API_URL
  try {
    const config = (await nativeImport(`${CONFIG}?case=${++imports}`)).default
    const headers = (await config.headers()).flatMap((rule) => rule.headers)
    const value = headers.find((h) => h.key === 'Content-Security-Policy')?.value
    assert.ok(value, 'the config sends a Content-Security-Policy header')
    const directives = Object.fromEntries(value.split('; ').map((d) => [d.split(' ')[0], d.split(' ').slice(1)]))
    return { value, directives }
  } finally {
    for (const [key, previous] of Object.entries(saved)) {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    }
  }
}

/** Everything that is allowed today, apart from what the script-src / connect-src lines add per environment. */
const UNCHANGED = {
  'default-src': ["'self'"],
  'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  'img-src': ["'self'", 'blob:', 'data:'],
  'frame-src': ['blob:'],
  'font-src': ["'self'", 'https://fonts.gstatic.com'],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
}

describe('Content-Security-Policy', () => {
  it('no longer allows the weather service, in development or production', async () => {
    for (const NODE_ENV of ['development', 'production']) {
      const { value, directives } = await policy({ NODE_ENV })
      assert.ok(!/open-meteo/i.test(value), `${NODE_ENV}: ${value}`)
      assert.ok(!directives['connect-src'].some((source) => /open-meteo/i.test(source)))
    }
  })

  it('allows connections only to the app itself and the API origin (plus the dev server socket in development)', async () => {
    assert.deepEqual((await policy({ NODE_ENV: 'development' })).directives['connect-src'], ["'self'", 'http://localhost:4100', 'ws:'])
    assert.deepEqual((await policy({ NODE_ENV: 'production' })).directives['connect-src'], ["'self'", 'http://localhost:4100'])
  })

  it('uses the origin (not the path) of the configured API address', async () => {
    const { directives } = await policy({ NODE_ENV: 'production', NEXT_PUBLIC_API_URL: 'https://api.example.test/api/v1' })
    assert.deepEqual(directives['connect-src'], ["'self'", 'https://api.example.test'])
  })

  it('keeps every other source exactly as it was, including blob: images for the custom login picture', async () => {
    for (const NODE_ENV of ['development', 'production']) {
      const { directives } = await policy({ NODE_ENV })
      for (const [name, sources] of Object.entries(UNCHANGED)) assert.deepEqual(directives[name], sources, `${NODE_ENV} ${name}`)
      assert.deepEqual(directives['script-src'], NODE_ENV === 'development' ? ["'self'", "'unsafe-inline'", "'unsafe-eval'"] : ["'self'", "'unsafe-inline'"], `${NODE_ENV} script-src`)
      assert.deepEqual(Object.keys(directives).sort(), [...Object.keys(UNCHANGED), 'connect-src', 'script-src'].sort(), `${NODE_ENV}: no directive was added or removed`)
    }
  })

  it('allows images only from the app itself, blob: (custom pictures) and data:, with no third-party image host', async () => {
    for (const NODE_ENV of ['development', 'production']) {
      const { value, directives } = await policy({ NODE_ENV })
      assert.deepEqual(directives['img-src'], ["'self'", 'blob:', 'data:'], NODE_ENV)
      assert.ok(!/unsplash/i.test(value), `${NODE_ENV}: ${value}`)
    }
  })

  it('does not list a source that nothing uses: no file in the web app loads from the image host it used to allow', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.(tsx?|css|mjs|js|json)$/.test(entry.name) && /images\.unsplash\.com/i.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(WEB, full))
      }
    }
    walk(path.join(WEB, 'src'))
    assert.deepEqual(offenders, [])
  })

  it('is not asked for by any file in the web app: no source, style or config mentions the weather service', () => {
    const offenders: string[] = []
    const scan = (file: string) => {
      if (/open-meteo/i.test(fs.readFileSync(file, 'utf8'))) offenders.push(path.relative(WEB, file))
    }
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.(tsx?|css|mjs|js|json)$/.test(entry.name)) scan(full)
      }
    }
    walk(path.join(WEB, 'src'))
    scan(path.join(WEB, 'next.config.mjs'))
    assert.deepEqual(offenders, [])
  })
})
