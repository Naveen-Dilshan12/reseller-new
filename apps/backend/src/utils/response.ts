import { Response } from 'express'

export function sendSuccess<T>(res: Response, data: T, message = 'Success', statusCode = 200): void {
  res.status(statusCode).json({ success: true, data, message })
}

export function sendPaginated<T>(res: Response, data: T[], total: number, page: number, limit: number, extraMeta?: Record<string, any>): void {
  res.status(200).json({
    success: true,
    data,
    meta: { total, page, limit, totalPages: Math.ceil(total / limit), ...(extraMeta ?? {}) },
  })
}
