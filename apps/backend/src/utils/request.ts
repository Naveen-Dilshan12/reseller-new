import { Request } from 'express'

export function getClientIp(req: Request): string | undefined {
  return req.ip || req.socket.remoteAddress || undefined
}

export function getUserAgent(req: Request): string | undefined {
  const ua = req.headers['user-agent']
  return ua ? ua.slice(0, 500) : undefined
}
