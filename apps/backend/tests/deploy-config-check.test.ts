import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseVerificationCutoff } from '../src/config/account-verification.config'

/**
 * The build-time guard (scripts/check-deploy-config.cjs, first step of `npm run build`) rejects the unconfirmed
 * cutoff placeholder. These tests run it against throwaway config files so they keep passing after the real
 * timestamp has been confirmed and committed.
 */

const script = path.join(__dirname, '..', 'scripts', 'check-deploy-config.cjs')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxr-deploy-check-'))

function run(value: string) {
  const file = path.join(dir, `config-${Math.random().toString(36).slice(2)}.ts`)
  fs.writeFileSync(file, `export const ACCOUNT_VERIFICATION_REQUIRED_FROM = '${value}'\n`)
  return spawnSync(process.execPath, [script, file], { encoding: 'utf8' })
}

describe('build-time cutoff validation', () => {
  it('rejects the unconfirmed placeholder', () => {
    const r = run('UNCONFIRMED-SET-DEPLOYMENT-TIMESTAMP')
    assert.equal(r.status, 1)
    assert.match(r.stderr, /DEPLOY CONFIG ERROR/)
  })

  it('rejects values without an explicit UTC offset or that are not timestamps', () => {
    for (const bad of ['2026-11-02', '2026-11-02T00:00:00', '2026-13-45T99:00:00+05:30', '']) {
      assert.equal(run(bad).status, 1, bad)
    }
  })

  it('accepts a timestamp with an offset, in agreement with the runtime parser', () => {
    for (const good of ['2026-11-02T00:00:00+05:30', '2026-11-02T00:00Z', '2026-11-02T06:30:00+05:30']) {
      assert.equal(run(good).status, 0, good)
      assert.ok(parseVerificationCutoff(good), good)
    }
  })

  it('rejects values that look like timestamps but are not real instants', () => {
    for (const bad of [
      '2026-02-31T00:00:00+05:30', // no 31st of February
      '2027-02-29T00:00:00+05:30', // 2027 is not a leap year
      '2026-11-02T24:00:00+05:30',
      '2026-11-02T00:60:00+05:30',
      '2026-11-02T00:00:60+05:30',
      '2026-11-02T00:00:00+25:00',
      '2026-11-02T00:00:00+05:75',
      '2025-11-02T00:00:00+05:30', // before the supported range
      '2101-01-01T00:00:00Z',
    ]) {
      const r = run(bad)
      assert.equal(r.status, 1, bad)
      assert.match(r.stderr, /DEPLOY CONFIG ERROR/, bad)
    }
  })

  it('accepts a leap day', () => {
    assert.equal(run('2028-02-29T00:00:00+05:30').status, 0)
  })

  it('warns, without failing, about a cutoff in the past or far in the future, and never calls a valid one safe', () => {
    const past = run('2026-01-01T00:00:00+05:30')
    assert.equal(past.status, 0)
    assert.match(past.stderr, /in the PAST/)
    assert.match(past.stderr, /not proof of a safe one/)

    const far = run('2099-01-01T00:00:00+05:30')
    assert.equal(far.status, 0)
    assert.match(far.stderr, /days away/)
    assert.match(far.stderr, /precheck-account-verification\.sql/)
  })

  it('fails when the config file or constant is missing', () => {
    assert.equal(spawnSync(process.execPath, [script, path.join(dir, 'missing.ts')], { encoding: 'utf8' }).status, 1)
    const empty = path.join(dir, 'empty.ts')
    fs.writeFileSync(empty, 'export const OTHER = 1\n')
    assert.equal(spawnSync(process.execPath, [script, empty], { encoding: 'utf8' }).status, 1)
  })

  it('is wired into the production build and the Docker image', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
    assert.match(pkg.scripts.build, /^node scripts\/check-deploy-config\.cjs && tsc/)
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8'), /COPY scripts\/check-deploy-config\.cjs/)
  })
})
