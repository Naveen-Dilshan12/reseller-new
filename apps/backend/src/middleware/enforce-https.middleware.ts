import type { NextFunction, Request, RequestHandler, Response } from 'express'

/**
 * Hostname as it appears in an allow-list or a Host header: lower-case labels of letters, digits and hyphens.
 * No scheme, port, path, wildcard or IPv6 literal.
 */
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/

/** Splits a comma-separated list into lower-case hostnames. Returns `invalid` entries instead of silently dropping them. */
export function parseAllowedHosts(raw: string): { hosts: string[]; invalid: string[] } {
  const hosts: string[] = []
  const invalid: string[] = []
  for (const part of raw.split(',')) {
    const entry = part.trim().toLowerCase()
    if (!entry) continue
    if (HOSTNAME.test(entry)) hosts.push(entry)
    else invalid.push(part.trim())
  }
  return { hosts, invalid }
}

/** Reduces a `Host` header value to a bare lower-case hostname, or null if it is not a plain hostname[:port]. */
export function normalizeHostHeader(header: string | undefined): string | null {
  if (!header) return null
  const match = /^([^:]+)(?::(\d{1,5}))?$/.exec(header.trim().toLowerCase().replace(/\.$/, ''))
  if (!match) return null
  return HOSTNAME.test(match[1]) ? match[1] : null
}

/**
 * Redirects plain-HTTP requests to HTTPS. The redirect target is taken from the allow-list, never from the request:
 * a request whose Host header is not on the list (or when the list is empty) gets a 400 and no Location header,
 * so a forged Host cannot turn this into an open redirect or poison a cache. Requests that already arrive over HTTPS
 * (as reported by the trusted proxy via X-Forwarded-Proto) pass untouched, including the container health check.
 */
export function createEnforceHttps(options: { enabled: boolean; allowedHosts: readonly string[] }): RequestHandler {
  const allowed = new Set(options.allowedHosts)
  return function enforceHttps(req: Request, res: Response, next: NextFunction) {
    if (!options.enabled) return next()
    if (req.protocol === 'https') return next()

    const host = normalizeHostHeader(req.get('host'))
    if (host && allowed.has(host)) {
      return res.redirect(301, `https://${host}${req.originalUrl}`)
    }
    res.status(400).json({ success: false, message: 'HTTPS is required' })
  }
}
