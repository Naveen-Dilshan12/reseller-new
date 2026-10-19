import { Request, Response, NextFunction } from 'express'
import { logger, getCorrelationId } from '../utils/logger'

/**
 * Sanitizes string input to prevent XSS attacks
 */
function sanitizeString(input: unknown): string {
  if (typeof input !== 'string') return String(input)

  // Remove potentially dangerous characters and patterns
  return input
    .replace(/[<>]/g, '') // Remove < and >
    .replace(/javascript:/gi, '') // Remove javascript: protocol
    .replace(/on\w+=/gi, '') // Remove event handlers like onclick=
    .replace(/data:text\/html/gi, '') // Remove data:text/html
    .trim()
}

/**
 * Recursively sanitizes an object or array
 */
function sanitizeInput(data: unknown): unknown {
  if (typeof data === 'string') {
    return sanitizeString(data)
  }

  if (Array.isArray(data)) {
    return data.map(item => sanitizeInput(item))
  }

  if (data !== null && typeof data === 'object') {
    const sanitized: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(data)) {
      // Skip file objects (Multer File)
      if (value && typeof value === 'object' && 'fieldname' in value && 'buffer' in value) {
        sanitized[key] = value
      } else {
        sanitized[key] = sanitizeInput(value)
      }
    }
    return sanitized
  }

  return data
}

/**
 * Top-level body fields that are stored and shown exactly as typed. The sanitizer would otherwise
 * strip `<`/`>`, trim, and mangle URL query strings (e.g. `?connection=x&phone=y` loses `on…=`),
 * which silently corrupts the admin's prepared demo welcome message (see saveWelcomeMessageSchema).
 * Safe because it is only ever rendered as escaped text and URL-encoded into a wa.me link.
 */
const VERBATIM_BODY_FIELDS = ['welcomeMessage'] as const

/**
 * Middleware to sanitize request body, query, and params
 */
export function sanitizeInputMiddleware(req: Request, _res: Response, next: NextFunction): void {
  try {
    // Sanitize request body
    if (req.body && typeof req.body === 'object') {
      const original = req.body as Record<string, unknown>
      const sanitized = sanitizeInput(original)
      if (sanitized && !Array.isArray(sanitized)) {
        for (const field of VERBATIM_BODY_FIELDS) {
          if (typeof original[field] === 'string') (sanitized as Record<string, unknown>)[field] = original[field]
        }
      }
      req.body = sanitized as any
    }

    // Sanitize query parameters (lighter sanitization for URLs)
    if (req.query) {
      const sanitized: Record<string, string> = {}
      for (const [key, value] of Object.entries(req.query)) {
        if (typeof value === 'string') {
          sanitized[key] = sanitizeString(value)
        } else {
          sanitized[key] = String(value)
        }
      }
      req.query = sanitized as any
    }

    // Sanitize route parameters (lighter sanitization)
    if (req.params) {
      const sanitized: Record<string, string> = {}
      for (const [key, value] of Object.entries(req.params)) {
        if (typeof value === 'string') {
          sanitized[key] = sanitizeString(value)
        } else {
          sanitized[key] = String(value)
        }
      }
      req.params = sanitized as any
    }

    next()
  } catch (error) {
    const correlationId = getCorrelationId(req)
    logger.error('Input sanitization failed', error as Error, {
      correlationId,
      endpoint: req.path,
      method: req.method,
    })
    next()
  }
}
