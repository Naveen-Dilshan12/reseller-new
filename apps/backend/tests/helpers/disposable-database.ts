/**
 * Guard for every test or script that writes to a real Postgres database (the DB-backed suites and scripts/e2e-flow.ts).
 *
 * Those create and delete users, resellers and commissions, so they must only ever run against a disposable database on
 * this machine. `disposableDatabaseUrl()` returns `E2E_DATABASE_URL` when it is safe to use, returns undefined when it is
 * not set (the suites then skip themselves), and THROWS when:
 *   - the value is not a postgres URL;
 *   - its host is not loopback (127.0.0.0/8, `localhost`, `::1`), or a `host=` / `hostaddr=` query parameter names anything
 *     but a local unix-socket directory (a path starting with `/`), unless the explicit confirmation below is given;
 *   - DATABASE_URL (which `.env` may supply, and which an early import can already have turned into a Prisma client) is set
 *     to something different, so a client built from `.env` can never end up talking to another database than the one the
 *     test believes it uses.
 *
 * Error messages never contain the URL, the user name, the password or the host. Only variable names are mentioned.
 */

export const OVERRIDE_VARIABLE = 'E2E_ALLOW_NON_LOOPBACK_DATABASE'
export const OVERRIDE_VALUE = 'I-KNOW-THIS-DATABASE-IS-DISPOSABLE-AND-WILL-BE-WRITTEN-TO'

const LOOPBACK_V4 = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/

/** True for 127.0.0.0/8, `localhost` and `::1` (with or without brackets). Nothing else, not even 0.0.0.0 or ::ffff:127.0.0.1. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === 'localhost' || host === '::1' || host === '[::1]' || LOOPBACK_V4.test(host)
}

export interface GuardOptions {
  /** Default true: DATABASE_URL, when set, must equal E2E_DATABASE_URL. Pass false where DATABASE_URL is overwritten before anything is imported. */
  requireSameDatabaseUrl?: boolean
}

export function disposableDatabaseUrl(env: NodeJS.ProcessEnv = process.env, options: GuardOptions = {}): string | undefined {
  const raw = env.E2E_DATABASE_URL
  if (raw === undefined || raw === '') return undefined

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('E2E_DATABASE_URL is not a valid URL (its value is not shown).')
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error('E2E_DATABASE_URL must be a postgresql:// URL.')
  }

  // libpq-style parameters can override the URL host: only a socket directory (an absolute path) is local by construction.
  const overridesLocal = ['host', 'hostaddr'].every((name) => url.searchParams.getAll(name).every((value) => value.startsWith('/')))
  const local = isLoopbackHost(url.hostname) && overridesLocal
  if (!local && env[OVERRIDE_VARIABLE] !== OVERRIDE_VALUE) {
    throw new Error(
      `E2E_DATABASE_URL points to a host that is not on this machine (loopback). These tests create and delete rows, so use a disposable local database. ` +
        `Only if that remote database really is disposable, set ${OVERRIDE_VARIABLE} to the exact confirmation text defined in tests/helpers/disposable-database.ts.`,
    )
  }

  if (options.requireSameDatabaseUrl !== false && env.DATABASE_URL !== undefined && env.DATABASE_URL !== raw) {
    throw new Error(
      'DATABASE_URL is set to a different value than E2E_DATABASE_URL (it may come from .env). Export the same disposable URL as DATABASE_URL too, so no client is built for another database.',
    )
  }
  return raw
}
