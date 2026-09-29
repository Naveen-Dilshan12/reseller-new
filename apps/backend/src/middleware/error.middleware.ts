import { Request, Response, NextFunction } from 'express'
import { ZodError } from 'zod'
import { MulterError } from 'multer'
import { Prisma } from '@prisma/client'

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

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    if (err.statusCode >= 500) console.error(`[AppError] ${err.message}`)
    res.status(err.statusCode).json({ success: false, message: err.message, code: err.code, errors: err.errors })
    return
  }

  if (err instanceof ZodError) {
    const errors = err.errors.map((e) => `${e.path.join('.')}: ${e.message}`)
    res.status(422).json({ success: false, message: 'Validation error', errors })
    return
  }

  if (err instanceof MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'File too large' : 'Invalid file upload'
    res.status(400).json({ success: false, message })
    return
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    // Never leak table/column/constraint names to clients.
    console.error(`[Prisma ${err.code}]`, JSON.stringify(err.meta))
    if (err.code === 'P2002') {
      res.status(409).json({ success: false, message: 'Record already exists' })
      return
    }
    if (err.code === 'P2025') {
      res.status(404).json({ success: false, message: 'Record not found' })
      return
    }
    res.status(400).json({ success: false, message: 'Database error' })
    return
  }

  if (err instanceof Prisma.PrismaClientValidationError) {
    res.status(400).json({ success: false, message: 'Invalid data provided' })
    return
  }

  const parseErr = err as Error & { type?: string }
  if (parseErr.type === 'entity.parse.failed') {
    res.status(400).json({ success: false, message: 'Invalid JSON body' })
    return
  }
  if (parseErr.type === 'entity.too.large') {
    res.status(413).json({ success: false, message: 'Request body too large' })
    return
  }
  if (err instanceof CorsOriginError) {
    res.status(403).json({ success: false, message: 'Origin not allowed' })
    return
  }

  console.error('[Unhandled]', err)
  res.status(500).json({ success: false, message: 'Internal server error' })
}

export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ success: false, message: 'Route not found' })
}
