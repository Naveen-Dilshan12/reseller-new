/**
 * An explicit, deterministic account-verification cutoff for tests that exercise the real login / registration gate.
 *
 * The application reads the launch cutoff from `src/config/account-verification.config.ts` (a compiled-in constant that
 * stays a placeholder until the real launch time is decided, and will then be a real timestamp, possibly in the future).
 * A test that signs up a brand-new account and expects "must verify before login" must not depend on whichever value
 * happens to be shipped, so it pins its own cutoff here. Nothing in `src/` changes: only the module cache of the test
 * process is told that the constant has this value.
 *
 * TEST_VERIFICATION_CUTOFF lies in the past, so an account created while a test runs is never a "legacy" account and has
 * to complete verification, exactly as after the real launch. Tests that want the legacy rule pass their own `at` to
 * `isAccountVerified` / `hasLegacyAccess` instead, and are unaffected.
 *
 * Call `pinVerificationCutoff()` BEFORE the first import of the app or of `src/config/account-verification`: that module
 * reads the constant once, when it is first loaded. Calling it too late would silently do nothing, so it throws instead.
 * Node runs each test file in its own process, so the pin never leaks into another file.
 */

export const TEST_VERIFICATION_CUTOFF = '2026-01-01T00:00:00+05:30'

export function pinVerificationCutoff(iso: string = TEST_VERIFICATION_CUTOFF): void {
  const verification = require.resolve('../../src/config/account-verification')
  if (require.cache[verification]) {
    throw new Error('pinVerificationCutoff() must run before anything imports src/config/account-verification (or the app)')
  }
  const configFile = require.resolve('../../src/config/account-verification.config')
  // Load the real module (its parser is needed as it is) and override only the constant.
  const real = require(configFile) as { parseVerificationCutoff: (raw: string) => Date | null }
  if (real.parseVerificationCutoff(iso) === null) throw new Error(`the test cutoff is not a valid timestamp with an offset: ${iso}`)
  require.cache[configFile] = {
    id: configFile,
    filename: configFile,
    loaded: true,
    exports: { ...real, ACCOUNT_VERIFICATION_REQUIRED_FROM: iso },
  } as unknown as NodeModule
}
