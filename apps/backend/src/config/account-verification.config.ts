// Side-effect-free so scripts/check-deploy-config.cjs can validate the same value at build time.

/**
 * Accounts created BEFORE this instant pre-date mandatory verification and keep access ("legacy access").
 * Everything created at or after it must complete SMS verification (or, for accounts without a phone, an emailed code).
 *
 * !!! PLACEHOLDER: set this to the start of the production cut-over window, as an ISO-8601 timestamp WITH the
 * !!! Asia/Colombo offset, e.g. '2026-11-02T00:00:00+05:30'. It is deliberately not a real date: with the
 * !!! placeholder no account counts as legacy (fail closed) and a production build refuses to start.
 *
 * Legacy access is NOT proof of anything: it never sets or implies `emailVerified` or `phoneVerifiedAt`.
 */
export const ACCOUNT_VERIFICATION_REQUIRED_FROM = 'UNCONFIRMED-SET-DEPLOYMENT-TIMESTAMP'

export function parseVerificationCutoff(raw: string): Date | null {
  // Require an explicit UTC offset so the instant never depends on the server's timezone.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/.test(raw)) return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}
