import rateLimit from 'express-rate-limit'

export const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests' },
})

export const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: process.env.NODE_ENV === 'test' ? 1000 : 30,
  // Only the test runner's own NODE_ENV (never a request header) may skip this.
  skip: (_req) => process.env.NODE_ENV === 'test',
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: 'Too many registration attempts. Try again later.' },
})

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  // Only the test runner's own NODE_ENV (never a request header) may skip this.
  skip: (_req) => process.env.NODE_ENV === 'test',
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: 'Too many authentication attempts' },
})

export const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: 'Too many password reset attempts. Please try again later.' },
})

// Sensitive endpoint rate limiters
export const sensitiveOperationLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: 'Too many sensitive operations. Please slow down.' },
})

export const dataExportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: 'Too many export requests. Try again later.' },
})

/** Test SMS costs credit: a handful per admin per hour is plenty. */
export const smsTestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  skip: (_req) => process.env.NODE_ENV === 'test',
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: 'Too many test SMS messages. Try again later.' },
})
