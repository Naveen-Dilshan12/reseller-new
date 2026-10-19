import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * trialInclude is returned to resellers unchanged, so it must never select the partner API base URL
 * (found by the DB-backed e2e leak check). Source-level guard; no database needed.
 */
describe('trial responses do not expose the integration base URL', () => {
  it('trialInclude selects only the provider from the product integration', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'trials', 'trial.service.ts'), 'utf8')
    const block = /const trialInclude = \{[\s\S]*?\} satisfies Prisma\.TrialRequestInclude/.exec(src)?.[0]
    assert.ok(block, 'trialInclude not found')
    assert.doesNotMatch(block, /baseUrl/)
    assert.match(block, /integration: \{ select: \{ provider: true \} \}/)
  })
})
