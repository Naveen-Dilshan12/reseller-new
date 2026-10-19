import crypto from 'crypto'
import type { Request, Response, NextFunction } from 'express'

export type LogLevel = 'info' | 'warn' | 'error' | 'debug'

interface LogContext {
  correlationId?: string
  userId?: string
  resellerId?: string
  endpoint?: string
  method?: string
  userAgent?: string
  ip?: string
  [key: string]: unknown
}

interface LogEntry {
  timestamp: string
  level: LogLevel
  message: string
  context: LogContext
  error?: {
    name: string
    message: string
    stack?: string
  }
}

class Logger {
  private generateCorrelationId(): string {
    return crypto.randomUUID()
  }

  private formatLog(entry: LogEntry): string {
    const { timestamp, level, message, context, error } = entry
    const contextStr = Object.keys(context).length > 0 ? ` | ${JSON.stringify(context)}` : ''
    const errorStr = error ? ` | Error: ${error.name}: ${error.message}` : ''
    return `[${timestamp}] ${level.toUpperCase()}: ${message}${contextStr}${errorStr}`
  }

  private log(level: LogLevel, message: string, context: LogContext = {}, error?: Error): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context,
    }

    if (error) {
      entry.error = {
        name: error.name,
        message: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      }
    }

    const formatted = this.formatLog(entry)

    switch (level) {
      case 'error':
        console.error(formatted)
        break
      case 'warn':
        console.warn(formatted)
        break
      case 'debug':
        if (process.env.NODE_ENV === 'development') {
          console.debug(formatted)
        }
        break
      default:
        console.log(formatted)
    }
  }

  info(message: string, context?: LogContext): void {
    this.log('info', message, context)
  }

  warn(message: string, context?: LogContext): void {
    this.log('warn', message, context)
  }

  error(message: string, error?: Error, context?: LogContext): void {
    this.log('error', message, context, error)
  }

  debug(message: string, context?: LogContext): void {
    this.log('debug', message, context)
  }

  withContext(context: LogContext): Logger {
    return this
  }
}

export const logger = new Logger()

export function addCorrelationId(req: Request, res: Response, next: NextFunction): void {
  req.headers['x-correlation-id'] = (req.headers['x-correlation-id'] as string) || crypto.randomUUID()
  res.setHeader('X-Correlation-ID', req.headers['x-correlation-id'] as string)
  next()
}

export function getCorrelationId(req: Request): string {
  return (req.headers['x-correlation-id'] as string) || 'unknown'
}
