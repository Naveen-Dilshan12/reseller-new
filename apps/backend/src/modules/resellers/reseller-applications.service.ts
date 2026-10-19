import { Request } from 'express'
import { Prisma, type ResellerStatus } from '@prisma/client'
import { prisma } from '../../config/database'
import { conflict, notFoundError } from '../../middleware/error.middleware'
import { currentUser } from '../../middleware/auth.middleware'
import { toSkipTake } from '../../utils/pagination'
import { auditService } from '../audit-logs/audit.service'
import { notificationService } from '../notifications/notification.service'
import { resellerAccessService } from '../products/reseller-access.service'
import { decryptAccountNumber, maskedBankAccount } from './bank-account.util'
import type { ApproveApplicationInput, ListApplicationsQuery, RejectApplicationInput } from './reseller.schema'

const summarySelect = {
  id: true,
  code: true,
  fullName: true,
  email: true,
  mobile: true,
  businessName: true,
  businessRegistrationNo: true,
  status: true,
  submittedAt: true,
  reviewedAt: true,
} satisfies Prisma.ResellerSelect

async function findOrThrow(id: string) {
  const reseller = await prisma.reseller.findUnique({ where: { id }, include: { bankAccount: true } })
  if (!reseller) throw notFoundError('Partner application')
  return reseller
}

/**
 * Moves a PENDING application to its final status. The status guard in the
 * update makes concurrent reviews safe: only the first decision wins.
 */
async function decide(id: string, status: Extract<ResellerStatus, 'ACTIVE' | 'REJECTED'>, data: Prisma.ResellerUpdateManyMutationInput) {
  const result = await prisma.reseller.updateMany({ where: { id, status: 'PENDING' }, data: { ...data, status } })
  if (result.count === 0) {
    const existing = await prisma.reseller.findUnique({ where: { id }, select: { status: true } })
    if (!existing) throw notFoundError('Partner application')
    throw conflict(`Application has already been reviewed (status: ${existing.status})`)
  }
  return findOrThrow(id)
}

export const resellerApplicationsService = {
  async list(query: ListApplicationsQuery) {
    const where: Prisma.ResellerWhereInput = {
      status: query.status,
      ...(query.search
        ? {
            OR: ['code', 'fullName', 'email', 'businessName', 'businessRegistrationNo', 'nicOrPassport'].map((field) => ({
              [field]: { contains: query.search, mode: 'insensitive' },
            })),
          }
        : {}),
    }
    const [items, total, pendingCount] = await Promise.all([
      prisma.reseller.findMany({ where, select: summarySelect, orderBy: { submittedAt: 'desc' }, ...toSkipTake(query) }),
      prisma.reseller.count({ where }),
      prisma.reseller.count({ where: { status: 'PENDING' } }),
    ])
    return { items, total, pendingCount }
  },

  async get(req: Request, id: string) {
    const reseller = await findOrThrow(id)
    const reviewer = reseller.reviewedById
      ? await prisma.user.findUnique({ where: { id: reseller.reviewedById }, select: { id: true, name: true, email: true } })
      : null

    await auditService.fromRequest(req, {
      action: 'RESELLER_APPLICATION_VIEWED',
      entityType: 'Reseller',
      entityId: id,
      resellerId: id,
    })

    const { bankAccount, ...rest } = reseller
    return {
      id: rest.id,
      code: rest.code,
      status: rest.status,
      submittedAt: rest.submittedAt,
      personal: {
        fullName: rest.fullName,
        nicOrPassport: rest.nicOrPassport,
        email: rest.email,
        mobile: rest.mobile,
        address: rest.address,
      },
      business: {
        businessName: rest.businessName,
        businessRegistrationNo: rest.businessRegistrationNo,
        businessAddress: rest.businessAddress,
        businessPhone: rest.businessPhone,
        businessEmail: rest.businessEmail,
      },
      bank: maskedBankAccount(bankAccount),
      review: {
        reviewedAt: rest.reviewedAt,
        reviewedBy: reviewer,
        approvedAt: rest.approvedAt,
        rejectionReason: rest.rejectionReason,
        reviewNote: rest.reviewNote,
      },
      level: { currentLevel: rest.currentLevel, activeCustomerCount: rest.activeCustomerCount },
      suspension: rest.suspendedAt ? { suspendedAt: rest.suspendedAt, reason: rest.suspensionReason } : null,
    }
  },

  async revealBankAccountNumber(req: Request, id: string) {
    const reseller = await findOrThrow(id)
    if (!reseller.bankAccount) throw notFoundError('Bank account')
    await auditService.fromRequest(req, {
      action: 'RESELLER_BANK_ACCOUNT_REVEALED',
      entityType: 'ResellerBankAccount',
      entityId: reseller.bankAccount.id,
      resellerId: id,
    })
    return { accountNumber: decryptAccountNumber(reseller.bankAccount) }
  },

  async approve(req: Request, id: string, input: ApproveApplicationInput) {
    const reviewer = currentUser(req)
    const now = new Date()
    const reseller = await decide(id, 'ACTIVE', {
      reviewedAt: now,
      approvedAt: now,
      reviewedById: reviewer.userId,
      reviewNote: input.note ?? null,
      rejectionReason: null,
    })
    const productsGranted = await resellerAccessService.grantDefaults(prisma, id, reviewer.userId)

    await auditService.fromRequest(req, {
      action: 'RESELLER_APPLICATION_APPROVED',
      entityType: 'Reseller',
      entityId: id,
      resellerId: id,
      metadata: { note: input.note ?? null, productsGranted },
    })
    await notificationService.notifyReseller(id, {
      type: 'RESELLER_APPLICATION_APPROVED',
      title: 'Application approved',
      body: `Welcome to Hexalyte! Your partner account ${reseller.code} is now active.`,
      link: '/dashboard',
    })
    return { id: reseller.id, code: reseller.code, status: reseller.status }
  },

  async reject(req: Request, id: string, input: RejectApplicationInput) {
    const reviewer = currentUser(req)
    const reseller = await decide(id, 'REJECTED', {
      reviewedAt: new Date(),
      reviewedById: reviewer.userId,
      rejectionReason: input.reason,
    })
    await prisma.refreshToken.updateMany({
      where: { user: { resellerId: id }, revokedAt: null },
      data: { revokedAt: new Date() },
    })

    await auditService.fromRequest(req, {
      action: 'RESELLER_APPLICATION_REJECTED',
      entityType: 'Reseller',
      entityId: id,
      resellerId: id,
      metadata: { reason: input.reason },
    })
    return { id: reseller.id, code: reseller.code, status: reseller.status, rejectionReason: reseller.rejectionReason }
  },
}
