import { Request } from 'express'
import { Prisma, type AuditActorType } from '@prisma/client'
import { prisma } from '../../config/database'
import { getClientIp, getUserAgent } from '../../utils/request'

type Db = Prisma.TransactionClient | typeof prisma

export interface AuditEntry {
  action: string
  entityType: string
  entityId?: string | null
  resellerId?: string | null
  metadata?: Prisma.InputJsonValue
  /** Overrides the actor taken from `req.user`, e.g. during login or public registration. */
  actor?: { userId?: string | null; email?: string | null }
}

const SENSITIVE_KEYS = /password|secret|token|apikey|api_key|authorization/i

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SENSITIVE_KEYS.test(k) ? '[REDACTED]' : redact(v)]),
    )
  }
  return value
}

async function write(db: Db, actorType: AuditActorType, entry: AuditEntry, extra: Partial<Prisma.AuditLogCreateInput>) {
  await db.auditLog.create({
    data: {
      actorType,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      resellerId: entry.resellerId ?? null,
      metadata: entry.metadata === undefined ? undefined : (redact(entry.metadata) as Prisma.InputJsonValue),
      ...extra,
    },
  })
}

export const auditService = {
  /** Records an action performed by the authenticated user of `req`. */
  async fromRequest(req: Request, entry: AuditEntry, db: Db = prisma) {
    await write(db, 'USER', entry, {
      actorUserId: entry.actor ? (entry.actor.userId ?? null) : (req.user?.userId ?? null),
      actorEmail: entry.actor ? (entry.actor.email ?? null) : (req.user?.email ?? null),
      ip: getClientIp(req),
      userAgent: getUserAgent(req),
    })
  },

  async system(entry: AuditEntry, db: Db = prisma) {
    await write(db, 'SYSTEM', entry, {})
  },

  async saas(productCode: string, entry: AuditEntry, db: Db = prisma) {
    await write(db, 'SAAS', entry, { actorEmail: `saas:${productCode}` })
  },
}
