#!/usr/bin/env node
/**
 * Build-time guard (runs first in `npm run build`, which the Docker image uses for the production bundle).
 * Fails the build while ACCOUNT_VERIFICATION_REQUIRED_FROM is still the unconfirmed placeholder, is not an
 * ISO-8601 timestamp with an explicit UTC offset, or is not a real calendar instant (e.g. 2026-02-31, hour 25,
 * offset +25:00, a year outside 2026-2100), so a half-configured build can never reach `prisma migrate deploy`.
 *
 * A VALID cutoff is NOT a SAFE cutoff. This script cannot see production data, so it only warns about the two
 * ways a well-formed value can still do damage; the data check is section 5a of prisma/precheck-account-verification.sql:
 *   - a cutoff in the past: every non-admin account created since then has no verification and is locked out;
 *   - a cutoff far in the future: every sign-up until then skips verification ("legacy access").
 *
 * Plain Node, no dependencies, and it only reads the source file text: no .env, no database, no network.
 * Usage: node scripts/check-deploy-config.cjs [path-to-account-verification.config.ts]
 */
const fs = require('node:fs')
const path = require('node:path')

const file = process.argv[2] || path.join(__dirname, '..', 'src', 'config', 'account-verification.config.ts')
const SHAPE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|([+-])(\d{2}):(\d{2}))$/
const MIN_YEAR = 2026
const MAX_YEAR = 2100
const FAR_FUTURE_DAYS = 60
const EXAMPLE = '2026-11-02T00:00:00+05:30 (Asia/Colombo)'

function fail(message) {
  console.error(`\nDEPLOY CONFIG ERROR: ${message}\n  File: ${file}\n`)
  process.exit(1)
}

const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
const daysInMonth = (y, m) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]

/** Returns a reason the value is not a real instant, or null. Never relies on Date's leniency. */
function calendarProblem(m) {
  const [year, month, day, hour, minute] = [m[1], m[2], m[3], m[4], m[5]].map(Number)
  const second = m[6] === undefined ? 0 : Number(m[6])
  if (month < 1 || month > 12) return `month ${month} does not exist`
  if (day < 1 || day > daysInMonth(year, month)) return `day ${day} does not exist in ${year}-${m[2]}`
  if (hour > 23 || minute > 59 || second > 59) return 'the time of day is out of range'
  if (m[8] !== undefined && (Number(m[9]) > 14 || Number(m[10]) > 59)) return 'the UTC offset is out of range (maximum +/-14:00)'
  if (year < MIN_YEAR || year > MAX_YEAR) return `the year must be between ${MIN_YEAR} and ${MAX_YEAR}`
  return null
}

let source
try {
  source = fs.readFileSync(file, 'utf8')
} catch {
  fail('cannot read the account-verification config file.')
}

const match = /export const ACCOUNT_VERIFICATION_REQUIRED_FROM\s*=\s*(['"])(.*?)\1/.exec(source)
if (!match) fail('ACCOUNT_VERIFICATION_REQUIRED_FROM was not found.')

const value = match[2]
const parts = SHAPE.exec(value)
const instant = parts ? new Date(value) : null
if (!parts || Number.isNaN(instant.getTime())) {
  fail(
    `ACCOUNT_VERIFICATION_REQUIRED_FROM is "${value}". Set it to the confirmed maintenance-window start as ISO-8601 with an offset, e.g. ${EXAMPLE}.`,
  )
}
const problem = calendarProblem(parts)
if (problem) fail(`ACCOUNT_VERIFICATION_REQUIRED_FROM "${value}" is not a real instant: ${problem}. Example: ${EXAMPLE}.`)

let colombo = ''
try {
  colombo = ` (${instant.toLocaleString('en-GB', { timeZone: 'Asia/Colombo', hour12: false })} Asia/Colombo)`
} catch {
  // No ICU timezone data: the instant itself was already validated, so just omit the local rendering.
}
console.log(`Deploy config: cutoff ${instant.toISOString()}${colombo}. Accounts created before it keep legacy access.`)

const daysAhead = (instant.getTime() - Date.now()) / 86_400_000
if (daysAhead < 0) {
  console.warn(
    `\nWARNING: the cutoff is ${Math.floor(-daysAhead)} day(s) in the PAST. Every non-admin account created since then has no verification and will be locked out at login.\n` +
      '  Confirm with production data first (prisma/precheck-account-verification.sql, section 5a).',
  )
} else if (daysAhead > FAR_FUTURE_DAYS) {
  console.warn(
    `\nWARNING: the cutoff is ${Math.floor(daysAhead)} days away. Every account created before it, including new sign-ups, skips verification until then.`,
  )
}
console.warn(
  '\nNOTE: a well-formed cutoff is not proof of a safe one. This check cannot see production data. Before go-live, run section 5a of\n' +
    '  prisma/precheck-account-verification.sql against the approved database to confirm the cutoff is after the newest existing\n' +
    '  non-admin user and matches the real go-live moment.\n',
)
