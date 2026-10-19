import { Request, Response, NextFunction } from 'express'
import { ZodError } from 'zod'
import { MulterError } from 'multer'
import { Prisma } from '@prisma/client'
import { logger, getCorrelationId } from '../utils/logger'

export class AppError extends Error {
  constructor(
    public message: string,
    public statusCode: number = 400,
    public errors?: string[],
    /** Machine-readable code for clients, e.g. APPLICATION_PENDING. */
    public code?: string,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export class CorsOriginError extends Error {
  constructor(origin: string) {
    super(`CORS: origin ${origin} not allowed`)
    this.name = 'CorsOriginError'
  }
}

export const badRequest = (message: string, errors?: string[]) => new AppError(message, 400, errors)
export const unauthorized = (message = 'Unauthorized') => new AppError(message, 401)
export const forbidden = (message = 'Forbidden') => new AppError(message, 403)
export const notFoundError = (entity = 'Record') => new AppError(`${entity} not found`, 404)
export const conflict = (message: string) => new AppError(message, 409)

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  const correlationId = getCorrelationId(req)
  const context = {
    correlationId,
    endpoint: req.path,
    method: req.method,
    userAgent: req.get('user-agent'),
    ip: req.ip,
  }

  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      logger.error(`[AppError] ${err.message}`, err, context)
    } else {
      logger.warn(`[AppError] ${err.message}`, context)
    }
    res.status(err.statusCode).json({
      success: false,
      message: err.message,
      code: err.code,
      errors: err.errors,
      correlationId
    })
    return
  }

  if (err instanceof ZodError) {
    const errors = err.errors.map((e) => `${e.path.join('.')}: ${e.message}`)
    logger.warn(`[Validation] ${errors.join(', ')}`, context)
    res.status(422).json({ success: false, message: 'Validation error', errors, correlationId })
    return
  }

  if (err instanceof MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'File too large' : 'Invalid file upload'
    logger.warn(`[Upload] ${message}`, context)
    res.status(400).json({ success: false, message, correlationId })
    return
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    // Never leak table/column/constraint names to clients.
    logger.error(`[Prisma ${err.code}] Database error`, err, { ...context, meta: err.meta })
    if (err.code === 'P2002') {
      res.status(409).json({ success: false, message: 'Record already exists', correlationId })
      return
    }
    if (err.code === 'P2025') {
      res.status(404).json({ success: false, message: 'Record not found', correlationId })
      return
    }
    res.status(400).json({ success: false, message: 'Database error', correlationId })
    return
  }

  if (err instanceof Prisma.PrismaClientValidationError) {
    logger.warn(`[Prisma] Validation error`, context)
    res.status(400).json({ success: false, message: 'Invalid data provided', correlationId })
    return
  }

  const parseErr = err as Error & { type?: string }
  if (parseErr.type === 'entity.parse.failed') {
    logger.warn(`[Parse] Invalid JSON body`, context)
    res.status(400).json({ success: false, message: 'Invalid JSON body', correlationId })
    return
  }
  if (parseErr.type === 'entity.too.large') {
    logger.warn(`[Parse] Request body too large`, context)
    res.status(413).json({ success: false, message: 'Request body too large', correlationId })
    return
  }
  if (err instanceof CorsOriginError) {
    logger.warn(`[CORS] Origin not allowed: ${err.message}`, context)
    res.status(403).json({ success: false, message: 'Origin not allowed', correlationId })
    return
  }

  logger.error('[Unhandled] Unexpected error', err, context)
  res.status(500).json({ success: false, message: 'Internal server error', correlationId })
}

export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ success: false, message: 'Route not found' })
}
