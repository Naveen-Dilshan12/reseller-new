import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { TEST_VERIFICATION_CUTOFF, pinVerificationCutoff } from './helpers/verification-cutoff'

/**
 * The deterministic test cutoff (tests/helpers/verification-cutoff.ts): it overrides the compiled-in launch constant for
 * this test process only, never touches the source file, and refuses to run too late to have any effect.
 * Database-free; nothing here reads `.env`, runs Prisma or opens a connection.
 */

describe('pinned verification cutoff for tests', () => {
  it('makes the verification module use the pinned value, whatever launch value is shipped in the source', async () => {
    pinVerificationCutoff()
    const verification = await import('../src/config/account-verification')
    assert.equal(verification.ACCOUNT_VERIFICATION_REQUIRED_FROM, TEST_VERIFICATION_CUTOFF)
    // An account created while a test runs is after the pinned (past) cutoff, so it has to verify, as after the real launch.
    assert.equal(verification.isAccountVerified({ role: 'SELLER', createdAt: new Date() }), false)
    assert.equal(verification.isAccountVerified({ role: 'SELLER', createdAt: new Date('2025-06-01T00:00:00Z') }), true, 'older accounts keep legacy access')
    assert.equal(verification.isAccountVerified({ role: 'SELLER', createdAt: new Date(), emailVerified: new Date() }), true)
    assert.equal(verification.isAccountVerified({ role: 'ADMIN' }), true)
  })

  it('throws instead of silently doing nothing when the verification module is already loaded', () => {
    assert.throws(() => pinVerificationCutoff(), /must run before/)
  })

  it('does not write the test value into the application source: the shipped constant is untouched', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../src/config/account-verification.config.ts'), 'utf8')
    assert.ok(!source.includes(TEST_VERIFICATION_CUTOFF), 'the test cutoff leaked into src/')
  })
})
