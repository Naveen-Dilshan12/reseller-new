import jwt, { SignOptions } from 'jsonwebtoken'
import type { UserRole } from '@prisma/client'
import { env } from '../config/env'

export interface JwtPayload {
  userId: string
  email: string
  role: UserRole
  resellerId: string | null
}

const ISSUER = 'hexalyte-reseller'

export function signAccessToken(payload: JwtPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    issuer: ISSUER,
    expiresIn: env.JWT_ACCESS_EXPIRES_IN as SignOptions['expiresIn'],
  })
}

export function verifyAccessToken(token: string): JwtPayload {
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'], issuer: ISSUER }) as JwtPayload & jwt.JwtPayload
  return { userId: decoded.userId, email: decoded.email, role: decoded.role, resellerId: decoded.resellerId ?? null }
}
