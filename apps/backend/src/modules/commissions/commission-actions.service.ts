import { Request } from 'express'
import { Prisma } from '@prisma/client'
import { prisma } from '../../config/database'
import { badRequest, conflict, notFoundError } from '../../middleware/error.middleware'
import { currentUser } from '../../middleware/auth.middleware'
import { toSkipTake, type Pagination } from '../../utils/pagination'
import { auditService } from '../audit-logs/audit.service'
import { notificationService } from '../notifications/notification.service'
import { promotePayable, reverseEntry } from './commission-ledger.service'
import type { CreatePayoutInput } from './commission.schema'

const ZERO = new Prisma.Decimal(0)

export const commissionActionsService = {
  /** PENDING → APPROVED, or straight to PAYABLE when the hold period has already ended. */
  async approve(req: Request, ids: string[]) {
    const user = currentUser(req)
    const now = new Date()
    const base = { id: { in: ids }, status: 'PENDING' as const }
    const data = { approvedAt: now, approvedById: user.userId }

    const [payable, approved] = await prisma.$transaction([
      prisma.commission.updateMany({ where: { ...base, payableAt: { lte: now } }, data: { ...data, status: 'PAYABLE' } }),
      prisma.commission.updateMany({ where: { ...base, payableAt: { gt: now } }, data: { ...data, status: 'APPROVED' } }),
    ])
    const count = payable.count + approved.count
    if (count === 0) throw conflict('No pending commissions found in the selection')

    await auditService.fromRequest(req, {
      action: 'COMMISSION_APPROVED',
      entityType: 'Commission',
      metadata: { ids, approved: approved.count, payable: payable.count },
    })
    return { approved: approved.count, payable: payable.count, skipped: ids.length - count }
  },

  async reverse(req: Request, id: string, reason: string) {
    const user = currentUser(req)
    const result = await prisma.$transaction(async (tx) => {
      const commission = await tx.commission.findUnique({ where: { id } })
      if (!commission) throw notFoundError('Commission')
      const outcome = await reverseEntry(tx, commission, reason, user.userId)
      await auditService.fromRequest(
        req,
        {
          action: outcome.clawback ? 'COMMISSION_CLAWBACK_CREATED' : 'COMMISSION_REVERSED',
          entityType: 'Commission',
          entityId: id,
          resellerId: commission.resellerId,
          metadata: { reason, amount: commission.amount.toString(), clawbackId: outcome.clawback?.id ?? null },
        },
        tx,
      )
      return { commission, ...outcome }
    })

    await notificationService.notifyReseller(result.commission.resellerId, {
      type: 'COMMISSION_REVERSED',
      title: 'Commission reversed',
      body: `A commission of ${result.commission.currency} ${result.commission.amount.toFixed(2)} for ${result.commission.periodMonth} was reversed: ${reason}`,
      link: '/commissions',
    })
    return { reversed: result.reversed, clawback: result.clawback }
  },

  async createPayout(req: Request, input: CreatePayoutInput) {
    const user = currentUser(req)

    const payout = await prisma.$transaction(async (tx) => {
      const reseller = await tx.reseller.findUnique({ where: { id: input.resellerId }, select: { id: true } })
      if (!reseller) throw notFoundError('Reseller')
      await promotePayable(tx)

      const entries = await tx.commission.findMany({
        where: {
          resellerId: input.resellerId,
          status: 'PAYABLE',
          ...(input.commissionIds ? { id: { in: input.commissionIds } } : {}),
        },
        select: { id: true, amount: true, currency: true },
      })
      if (input.commissionIds && entries.length !== input.commissionIds.length) {
        throw conflict('Some selected commissions are not payable (not approved, still on hold, or already paid)')
      }
      if (entries.length === 0) throw badRequest('There are no payable commissions for this reseller')

      const total = entries.reduce((s, e) => s.add(e.amount), ZERO)
      if (total.lte(0)) throw badRequest('Payable total must be greater than zero (clawbacks exceed earnings)')

      const paidAt = input.paidAt ?? new Date()
      const created = await tx.commissionPayout.create({
        data: {
          resellerId: input.resellerId,
          totalAmount: total,
          currency: entries[0].currency,
          paymentReference: input.paymentReference,
          paidAt,
          paidById: user.userId,
          note: input.note,
        },
      })
      const updated = await tx.commission.updateMany({
        where: { id: { in: entries.map((e) => e.id) }, status: 'PAYABLE' },
        data: { status: 'PAID', paidAt, payoutId: created.id },
      })
      if (updated.count !== entries.length) throw conflict('Commissions changed during payout; please retry')

      await auditService.fromRequest(
        req,
        {
          action: 'COMMISSION_PAYOUT_CREATED',
          entityType: 'CommissionPayout',
          entityId: created.id,
          resellerId: input.resellerId,
          metadata: { total: total.toString(), entries: entries.length, paymentReference: input.paymentReference },
        },
        tx,
      )
      return { ...created, entries: entries.length }
    })

    await notificationService.notifyReseller(input.resellerId, {
      type: 'COMMISSION_PAID',
      title: 'Commission paid',
      body: `${payout.currency} ${payout.totalAmount.toFixed(2)} has been paid. Reference: ${payout.paymentReference}`,
      link: '/commissions',
    })
    return payout
  },

  async listPayouts(query: Pagination, resellerId?: string) {
    const where = { resellerId }
    const [items, total] = await Promise.all([
      prisma.commissionPayout.findMany({
        where,
        include: { reseller: { select: { code: true, businessName: true } }, _count: { select: { commissions: true } } },
        orderBy: { paidAt: 'desc' },
        ...toSkipTake(query),
      }),
      prisma.commissionPayout.count({ where }),
    ])
    return { items, total }
  },
}
