import crypto from 'crypto'
import type { Request } from 'express'
import { Prisma, type ActivationMethod, type ActivationRequestStatus } from '@prisma/client'
import { env } from '../../config/env'
import { prisma } from '../../config/database'
import { assertResellerAccess, currentUser, resolveResellerId } from '../../middleware/auth.middleware'
import { AppError, badRequest, conflict, forbidden, notFoundError } from '../../middleware/error.middleware'
import { isPlatformRole } from '../../rbac/permissions'
import { sha256 } from '../../utils/crypto'
import { toSkipTake } from '../../utils/pagination'
import { billingWindow } from '../../utils/period'
import { auditService } from '../audit-logs/audit.service'
import { notificationService } from '../notifications/notification.service'
import {
  applySubscriptionEvent,
  notifySubscriptionEvent,
  type AppliedSubscriptionEvent,
} from '../commissions/subscription-events.service'
import { IntegrationError } from '../integrations/integration-error'
import { integrationRegistry } from '../integrations/integration-registry'
import { integrationService } from '../integrations/integration.service'
import type { ActivationResult } from '../integrations/saas-integration'
import { resellerAccessService } from '../products/reseller-access.service'
import { getCompanyBankDetails } from '../settings/settings.service'
import { detectFileType, privateStorage } from '../storage/private-storage'
import type { CreateActivationInput, ListActivationsQuery } from './activation.schema'

type Status = ActivationRequestStatus
type Tx = Prisma.TransactionClient

const OPEN_STATUSES: Status[] = ['PENDING_REVIEW', 'UNDER_REVIEW', 'APPROVED']
const REVIEW_ROLES = ['ADMIN'] as const
const SLIP_FOLDER = 'bank-slips'
const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

const listInclude = {
  product: { select: { id: true, code: true, name: true } },
  reseller: { select: { id: true, code: true, businessName: true } },
  customerAccount: { select: { id: true, externalTenantId: true, customer: { select: { id: true, displayName: true } } } },
} satisfies Prisma.ActivationRequestInclude

const detailInclude = {
  ...listInclude,
  product: {
    select: {
      id: true,
      code: true,
      name: true,
      monthlyPrice: true,
      currency: true,
      integrationStatus: true,
      integration: { select: { provider: true } },
    },
  },
  customerAccount: {
    select: {
      id: true,
      status: true,
      externalTenantId: true,
      externalAccountId: true,
      activatedAt: true,
      customer: { select: { id: true, displayName: true } },
    },
  },
  bankSlips: { select: { id: true, originalName: true, mimeType: true, sizeBytes: true, sha256: true, createdAt: true } },
  history: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.ActivationRequestInclude

type Detail = Prisma.ActivationRequestGetPayload<{ include: typeof detailInclude }>

export interface UploadedSlip {
  buffer: Buffer
  originalname: string
  size: number
}

function newReference() {
  const bytes = crypto.randomBytes(6)
  return `AR-${Array.from(bytes, (b) => REFERENCE_ALPHABET[b % REFERENCE_ALPHABET.length]).join('')}`
}

function safeFileName(name: string) {
  return name.replace(/[^\w.\- ]+/g, '_').slice(-120) || 'bank-slip'
}

/** Whether the product's SaaS can be activated through its partner API. */
function remoteActivationAvailable(product: Detail['product']) {
  const provider = product.integration && integrationRegistry.get(product.integration.provider)
  return Boolean(provider?.requiresCredentials) && !['NOT_CONFIGURED', 'DISABLED'].includes(product.integrationStatus)
}

async function loadDetail(id: string) {
  const request = await prisma.activationRequest.findUnique({ where: { id }, include: detailInclude })
  if (!request) throw notFoundError('Activation request')
  return request
}

/**
 * Moves a request between statuses. The status guard in `updateMany` makes
 * concurrent actions safe: only the first reviewer's action wins.
 */
async function transition(
  tx: Tx,
  req: Request,
  request: { id: string; resellerId: string },
  from: Status[],
  to: Status,
  action: string,
  data: Prisma.ActivationRequestUpdateManyMutationInput = {},
  opts: { note?: string | null; internal?: boolean; metadata?: Prisma.InputJsonObject } = {},
) {
  const updated = await tx.activationRequest.updateMany({ where: { id: request.id, status: { in: from } }, data: { ...data, status: to } })
  if (updated.count === 0) {
    const current = await tx.activationRequest.findUnique({ where: { id: request.id }, select: { status: true } })
    throw conflict(`This action is not allowed while the request is ${current?.status ?? 'unknown'}`)
  }
  const previous = from.length === 1 ? from[0] : null
  await tx.activationStatusChange.create({
    data: {
      activationRequestId: request.id,
      fromStatus: previous,
      toStatus: to,
      action,
      note: opts.note ?? null,
      internal: opts.internal ?? false,
      actorUserId: req.user?.userId ?? null,
    },
  })
  await auditService.fromRequest(
    req,
    {
      action: `ACTIVATION_${action}`,
      entityType: 'ActivationRequest',
      entityId: request.id,
      resellerId: request.resellerId,
      metadata: { from, to, ...(opts.metadata ?? {}) },
    },
    tx,
  )
}

/** History entry for a step that does not change the status (e.g. payment verified, SaaS pending). */
async function recordStep(tx: Tx, req: Request, request: { id: string; resellerId: string; status: Status }, action: string, note: string | null, internal: boolean, metadata?: Prisma.InputJsonObject) {
  await tx.activationStatusChange.create({
    data: { activationRequestId: request.id, fromStatus: request.status, toStatus: request.status, action, note, internal, actorUserId: req.user?.userId ?? null },
  })
  await auditService.fromRequest(
    req,
    { action: `ACTIVATION_${action}`, entityType: 'ActivationRequest', entityId: request.id, resellerId: request.resellerId, metadata },
    tx,
  )
}

async function userNames(ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))]
  if (unique.length === 0) return new Map<string, { name: string; email: string }>()
  const users = await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true, email: true } })
  return new Map(users.map((u) => [u.id, { name: u.name, email: u.email }]))
}

function describeIntegrationError(err: unknown): string {
  if (err instanceof IntegrationError) {
    const s = err.httpStatus
    if (s === undefined || s >= 500) return 'The SaaS did not respond or had a server error. Retrying is safe.'
    if (s === 401 || s === 403 || s === 404) return 'The SaaS rejected the platform connection (check the integration settings).'
    return err.message.replace(/^SaaS API error:\s*/, '')
  }
  return err instanceof AppError ? err.message : 'Unexpected error while activating'
}

// ─── Serialisation ───────────────────────────────────────────────────────────

async function platformView(request: Detail) {
  const [duplicateSlips, duplicateRefs, names] = await Promise.all([
    prisma.bankSlip.findMany({
      where: { sha256: { in: request.bankSlips.map((s) => s.sha256) }, activationRequestId: { not: request.id } },
      select: { activationRequest: { select: { id: true, reference: true, status: true } } },
    }),
    prisma.activationRequest.findMany({
      where: { id: { not: request.id }, transactionRef: { equals: request.transactionRef, mode: 'insensitive' } },
      select: { id: true, reference: true, status: true },
    }),
    userNames([
      request.requestedById,
      request.reviewerId,
      request.paymentVerifiedById,
      request.decidedById,
      request.activatedById,
      ...request.history.map((h) => h.actorUserId),
    ]),
  ])
  const { product, history, bankSlips, ...rest } = request
  return {
    ...rest,
    product: { id: product.id, code: product.code, name: product.name, monthlyPrice: product.monthlyPrice, currency: product.currency },
    amountMatchesPrice: request.amount.equals(product.monthlyPrice),
    activation: {
      remoteAvailable: remoteActivationAvailable(product),
      provider: product.integration?.provider ?? null,
      integrationStatus: product.integrationStatus,
    },
    bankSlips: bankSlips.map(({ sha256: _hash, ...s }) => s),
    warnings: {
      slipReusedIn: duplicateSlips.map((d) => d.activationRequest),
      transactionRefUsedIn: duplicateRefs,
      awaitingSaaSTenant: !request.customerAccount.externalTenantId,
    },
    people: {
      requestedBy: names.get(request.requestedById) ?? null,
      reviewer: request.reviewerId ? (names.get(request.reviewerId) ?? null) : null,
      paymentVerifiedBy: request.paymentVerifiedById ? (names.get(request.paymentVerifiedById) ?? null) : null,
      decidedBy: request.decidedById ? (names.get(request.decidedById) ?? null) : null,
      activatedBy: request.activatedById ? (names.get(request.activatedById) ?? null) : null,
    },
    history: history.map((h) => ({ ...h, actor: h.actorUserId ? (names.get(h.actorUserId) ?? null) : null })),
  }
}

/** Reseller view: no internal notes, reviewer identities or technical errors. */
function resellerView(request: Detail) {
  return {
    id: request.id,
    reference: request.reference,
    status: request.status,
    periodMonth: request.periodMonth,
    amount: request.amount,
    currency: request.currency,
    payerName: request.payerName,
    payerBank: request.payerBank,
    transactionRef: request.transactionRef,
    transferDate: request.transferDate,
    notes: request.notes,
    submittedAt: request.submittedAt,
    paymentVerified: Boolean(request.paymentVerifiedAt),
    decidedAt: request.decidedAt,
    rejectionReason: request.rejectionReason,
    activatedAt: request.activatedAt,
    activationReference: request.status === 'ACTIVATION_COMPLETED' ? request.activationReference : null,
    product: { id: request.product.id, code: request.product.code, name: request.product.name },
    reseller: request.reseller,
    customerAccount: {
      id: request.customerAccount.id,
      status: request.customerAccount.status,
      externalTenantId: request.customerAccount.externalTenantId,
      customer: request.customerAccount.customer,
    },
    bankSlips: request.bankSlips.map(({ sha256: _hash, ...s }) => s),
    history: request.history
      .filter((h) => !h.internal)
      .map((h) => ({ id: h.id, fromStatus: h.fromStatus, toStatus: h.toStatus, action: h.action, note: h.note, createdAt: h.createdAt })),
  }
}

// ─── Completion ──────────────────────────────────────────────────────────────

/**
 * Marks the request completed and records the verified payment as a
 * subscription event (customer becomes ACTIVE, commission is generated).
 * Reuses an event already recorded for the same month instead of duplicating it.
 */
async function complete(
  req: Request,
  request: Detail,
  method: ActivationMethod,
  details: { activationReference: string | null; saasRequestId?: string | null; note?: string | null },
) {
  const now = new Date()
  let applied: AppliedSubscriptionEvent | null = null
  const eventInput = {
    customerAccountId: request.customerAccountId,
    type: 'PAYMENT_VERIFIED' as const,
    periodMonth: request.periodMonth,
    externalRef: request.reference,
    note: `Activation request ${request.reference}`,
  }

  await prisma.$transaction(async (tx) => {
    await transition(
      tx,
      req,
      request,
      ['APPROVED'],
      'ACTIVATION_COMPLETED',
      'COMPLETED',
      {
        activationMethod: method,
        activationReference: details.activationReference,
        saasRequestId: details.saasRequestId ?? undefined,
        activationNote: details.note ?? null,
        activationError: null,
        activatedAt: now,
        activatedById: req.user!.userId,
      },
      { note: 'Subscription activated in the SaaS', metadata: { method, activationReference: details.activationReference } },
    )

    const existing = await tx.subscriptionEvent.findUnique({
      where: {
        customerAccountId_type_periodMonth: { customerAccountId: request.customerAccountId, type: 'PAYMENT_VERIFIED', periodMonth: request.periodMonth },
      },
      select: { id: true, activationRequest: { select: { id: true } } },
    })
    let eventId: string
    if (existing) {
      if (existing.activationRequest && existing.activationRequest.id !== request.id) {
        throw conflict(`A payment for ${request.periodMonth} is already linked to another activation request`)
      }
      eventId = existing.id
    } else {
      applied = await applySubscriptionEvent(tx, eventInput, { source: 'ACTIVATION_REQUEST', req })
      eventId = applied.event.id
    }
    await tx.activationRequest.update({ where: { id: request.id }, data: { subscriptionEventId: eventId } })
  })

  if (applied) await notifySubscriptionEvent(applied, eventInput)
  await notificationService.notifyReseller(request.resellerId, {
    type: 'ACTIVATION_COMPLETED',
    title: 'Subscription activated',
    body: `${request.customerAccount.customer.displayName} – ${request.product.name} is active for ${request.periodMonth} (${request.reference}).`,
    link: `/activations/${request.id}`,
  })
}

async function handleActivationResult(req: Request, request: Detail, result: ActivationResult) {
  if (result.status === 'ACTIVATED') {
    await complete(req, request, 'PARTNER_API', { activationReference: result.subscriptionReference ?? null, saasRequestId: result.requestId })
    return { outcome: 'ACTIVATED' as const, message: 'Subscription activated in the SaaS.' }
  }
  const pending = result.status === 'PENDING'
  await prisma.$transaction(async (tx) => {
    await tx.activationRequest.update({
      where: { id: request.id },
      data: {
        activationMethod: 'PARTNER_API',
        saasRequestId: result.requestId ?? request.saasRequestId,
        activationError: pending ? null : (result.note ?? 'The SaaS could not activate the subscription'),
      },
    })
    await recordStep(tx, req, request, pending ? 'SAAS_PENDING' : 'SAAS_FAILED', result.note ?? null, true, {
      saasRequestId: result.requestId ?? null,
      saasStatus: result.status,
    })
  })
  return pending
    ? { outcome: 'PENDING' as const, message: 'The SaaS accepted the activation and is processing it. Use “Check status” later.' }
    : { outcome: 'FAILED' as const, message: result.note ?? 'The SaaS could not activate the subscription.' }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export const activationService = {
  async paymentInfo() {
    return { companyBankDetails: await getCompanyBankDetails(), maxUploadMb: env.MAX_UPLOAD_MB }
  },

  async list(query: ListActivationsQuery, req: Request) {
    const statuses = query.status?.split(',') as Status[] | undefined
    const resellerId = resolveResellerId(req, query.resellerId)
    const baseWhere: Prisma.ActivationRequestWhereInput = {
      resellerId,
      productId: query.productId,
      customerAccountId: query.customerAccountId,
    }
    const where: Prisma.ActivationRequestWhereInput = {
      ...baseWhere,
      ...(statuses ? { status: { in: statuses } } : {}),
      ...(query.search
        ? {
            OR: [
              { reference: { contains: query.search, mode: 'insensitive' } },
              { transactionRef: { contains: query.search, mode: 'insensitive' } },
              { customerAccount: { customer: { displayName: { contains: query.search, mode: 'insensitive' } } } },
              { customerAccount: { customer: { customerCode: { contains: query.search, mode: 'insensitive' } } } },
            ],
          }
        : {}),
    }
    const [
      items,
      total,
      totalCount,
      pendingReviewCount,
      underReviewCount,
      completedCount,
    ] = await Promise.all([
      prisma.activationRequest.findMany({
        where,
        select: {
          id: true,
          reference: true,
          status: true,
          periodMonth: true,
          amount: true,
          currency: true,
          transactionRef: true,
          submittedAt: true,
          paymentVerifiedAt: true,
          activatedAt: true,
          ...listInclude,
        },
        orderBy: { submittedAt: 'desc' },
        ...toSkipTake(query),
      }),
      prisma.activationRequest.count({ where }),
      prisma.activationRequest.count({ where: baseWhere }),
      prisma.activationRequest.count({ where: { ...baseWhere, status: 'PENDING_REVIEW' } }),
      prisma.activationRequest.count({ where: { ...baseWhere, status: 'UNDER_REVIEW' } }),
      prisma.activationRequest.count({ where: { ...baseWhere, status: 'ACTIVATION_COMPLETED' } }),
    ])

    const pipelineCounts = {
      total: totalCount,
      pendingReview: pendingReviewCount,
      underReview: underReviewCount,
      completed: completedCount,
    }

    return { items, total, pipelineCounts }
  },

  async get(id: string, req: Request) {
    const request = await loadDetail(id)
    assertResellerAccess(req, request.resellerId)
    await auditService.fromRequest(req, {
      action: 'ACTIVATION_REQUEST_VIEWED',
      entityType: 'ActivationRequest',
      entityId: id,
      resellerId: request.resellerId,
    })
    return isPlatformRole(currentUser(req).role) ? platformView(request) : resellerView(request)
  },

  async create(input: CreateActivationInput, file: UploadedSlip | undefined, req: Request) {
    const user = currentUser(req)
    if (isPlatformRole(user.role) || !user.resellerId) throw forbidden('Activation requests are submitted by partners')
    const resellerId = user.resellerId

    if (!file) throw badRequest('Upload the bank slip', ['slip: Upload the bank slip'])
    const detected = detectFileType(file.buffer)
    if (!detected) throw badRequest('Bank slip must be a JPG, PNG, WEBP or PDF file', ['slip: Unsupported file type'])

    await resellerAccessService.assertCanSell(resellerId, input.productId)
    let resolvedCustomerId = input.customerId
    if (input.customerId.startsWith('CUS-')) {
      const match = await prisma.customer.findFirst({
        where: { customerCode: input.customerId },
        select: { id: true, resellerId: true },
      })
      if (!match || match.resellerId !== resellerId) {
        throw notFoundError('Customer')
      }
      resolvedCustomerId = match.id
    }

    const account = await prisma.customerAccount.findUnique({
      where: { customerId_productId: { customerId: resolvedCustomerId, productId: input.productId } },
      select: {
        id: true,
        resellerId: true,
        externalTenantId: true,
        status: true,
        product: { select: { monthlyPrice: true, currency: true, name: true } },
      },
    })

    if (!account) {
      throw badRequest('The customer must have a trial account for this product before requesting paid activation. Please provision a trial first.')
    }
    if (account.resellerId !== resellerId) {
      throw notFoundError('Customer')
    }
    if (!account.externalTenantId) {
      throw badRequest('The customer account has no provisioned SaaS tenant. Provision a trial through the SaaS integration first before submitting paid activation.')
    }
    if (account.status === 'ACTIVE') {
      throw conflict(`This customer already has an active paid subscription for ${account.product.name}`)
    }

    // Block duplicate activation request if an open request is already under review
    const anyOpen = await prisma.activationRequest.findFirst({
      where: { customerAccountId: account.id, status: { in: OPEN_STATUSES } },
      select: { reference: true, status: true },
    })
    if (anyOpen) {
      throw conflict(`An activation request (${anyOpen.reference}) is already pending review for this customer account`)
    }

    if (!new Prisma.Decimal(input.amount).equals(account.product.monthlyPrice)) {
      throw badRequest(`The monthly subscription fee for ${account.product.name} is ${account.product.currency} ${account.product.monthlyPrice.toFixed(2)}`, [
        `amount: Must be ${account.product.monthlyPrice.toFixed(2)}`,
      ])
    }

    const billing = billingWindow()
    if (input.periodMonth < billing.from || input.periodMonth > billing.to) {
      throw badRequest('Billing month must be between last month and two months ahead', ['periodMonth: Out of range'])
    }
    const transferDate = new Date(`${input.transferDate}T00:00:00Z`)
    const today = new Date()
    if (transferDate.getTime() > today.getTime() + 24 * 3600_000) throw badRequest('Transfer date cannot be in the future', ['transferDate: In the future'])
    if (today.getTime() - transferDate.getTime() > 90 * 24 * 3600_000) throw badRequest('Transfer date is more than 90 days ago', ['transferDate: Too old'])

    const [open, alreadyPaid] = await Promise.all([
      prisma.activationRequest.findFirst({
        where: { customerAccountId: account.id, periodMonth: input.periodMonth, status: { in: [...OPEN_STATUSES, 'ACTIVATION_COMPLETED'] } },
        select: { reference: true, status: true },
      }),
      prisma.subscriptionEvent.findUnique({
        where: { customerAccountId_type_periodMonth: { customerAccountId: account.id, type: 'PAYMENT_VERIFIED', periodMonth: input.periodMonth } },
        select: { id: true },
      }),
    ])
    if (open) throw conflict(`Request ${open.reference} for ${input.periodMonth} is already ${open.status.replace(/_/g, ' ').toLowerCase()}`)
    if (alreadyPaid) throw conflict(`The subscription for ${input.periodMonth} has already been activated`)

    const storageKey = await privateStorage.save(SLIP_FOLDER, file.buffer)
    try {
      const created = await prisma.$transaction(async (tx) => {
        const request = await tx.activationRequest.create({
          data: {
            reference: newReference(),
            resellerId,
            productId: input.productId,
            customerAccountId: account.id,
            periodMonth: input.periodMonth,
            amount: input.amount,
            currency: account.product.currency,
            payerName: input.payerName,
            payerBank: input.payerBank,
            transactionRef: input.transactionRef,
            transferDate,
            notes: input.notes,
            requestedById: user.userId,
            bankSlips: {
              create: {
                resellerId,
                storageKey,
                originalName: safeFileName(file.originalname),
                mimeType: detected.mimeType,
                sizeBytes: file.size,
                sha256: sha256(file.buffer),
                uploadedById: user.userId,
              },
            },
            history: { create: { toStatus: 'PENDING_REVIEW', action: 'SUBMITTED', actorUserId: user.userId } },
          },
          select: { id: true, reference: true },
        })
        await auditService.fromRequest(
          req,
          {
            action: 'ACTIVATION_SUBMITTED',
            entityType: 'ActivationRequest',
            entityId: request.id,
            resellerId,
            metadata: { reference: request.reference, productId: input.productId, periodMonth: input.periodMonth, amount: input.amount.toFixed(2) },
          },
          tx,
        )
        return request
      })

      await notificationService.notifyPlatform(
        {
          type: 'ACTIVATION_SUBMITTED',
          title: 'New activation request',
          body: `${created.reference}: ${account.product.name}, ${input.periodMonth}, ${account.product.currency} ${input.amount.toFixed(2)}`,
          link: `/admin/activations/${created.id}`,
        },
        REVIEW_ROLES,
      )
      return created
    } catch (err) {
      await privateStorage.remove(storageKey).catch(() => undefined)
      throw err
    }
  },

  /** Streams a bank slip to an authorised user. Every access is audited. */
  async readSlip(id: string, slipId: string, req: Request) {
    const slip = await prisma.bankSlip.findFirst({
      where: { id: slipId, activationRequestId: id },
      select: { id: true, resellerId: true, storageKey: true, mimeType: true, originalName: true, activationRequest: { select: { reference: true } } },
    })
    if (!slip) throw notFoundError('Bank slip')
    assertResellerAccess(req, slip.resellerId)
    const content = await privateStorage.read(slip.storageKey)
    await auditService.fromRequest(req, {
      action: 'BANK_SLIP_VIEWED',
      entityType: 'BankSlip',
      entityId: slip.id,
      resellerId: slip.resellerId,
      metadata: { activationRequestId: id, reference: slip.activationRequest.reference },
    })
    return { content, mimeType: slip.mimeType, fileName: slip.originalName }
  },

  async cancel(id: string, req: Request) {
    const request = await loadDetail(id)
    const user = currentUser(req)
    if (isPlatformRole(user.role) || user.resellerId !== request.resellerId) throw forbidden()
    await prisma.$transaction((tx) => transition(tx, req, request, ['PENDING_REVIEW'], 'CANCELLED', 'CANCELLED', { cancelledAt: new Date() }))
    return loadDetail(id).then(resellerView)
  },

  async startReview(id: string, req: Request) {
    const request = await loadDetail(id)
    await prisma.$transaction((tx) =>
      transition(tx, req, request, ['PENDING_REVIEW'], 'UNDER_REVIEW', 'REVIEW_STARTED', { reviewerId: req.user!.userId, reviewStartedAt: new Date() }),
    )
    await notificationService.notifyReseller(request.resellerId, {
      type: 'ACTIVATION_UNDER_REVIEW',
      title: 'Activation request under review',
      body: `${request.reference} is being reviewed by Hexalyte.`,
      link: `/activations/${id}`,
    })
    return platformView(await loadDetail(id))
  },

  async verifyPayment(id: string, note: string, req: Request) {
    const request = await loadDetail(id)
    if (request.status !== 'UNDER_REVIEW') throw conflict('Start the review before verifying the payment')
    if (request.paymentVerifiedAt) throw conflict('Payment has already been verified')
    await prisma.$transaction(async (tx) => {
      const updated = await tx.activationRequest.updateMany({
        where: { id, status: 'UNDER_REVIEW', paymentVerifiedAt: null },
        data: { paymentVerifiedAt: new Date(), paymentVerifiedById: req.user!.userId, paymentVerificationNote: note },
      })
      if (updated.count === 0) throw conflict('The request changed; reload and try again')
      await recordStep(tx, req, request, 'PAYMENT_VERIFIED', 'Payment received in the company account', false, { note })
    })
    return platformView(await loadDetail(id))
  },

  async approve(id: string, note: string | undefined, req: Request) {
    const request = await loadDetail(id)
    if (!request.paymentVerifiedAt) throw conflict('Verify the payment before approving')
    await prisma.$transaction((tx) =>
      transition(tx, req, request, ['UNDER_REVIEW'], 'APPROVED', 'APPROVED', { decidedAt: new Date(), decidedById: req.user!.userId }, { note: note ?? null, internal: true }),
    )
    await notificationService.notifyReseller(request.resellerId, {
      type: 'ACTIVATION_APPROVED',
      title: 'Activation request approved',
      body: `${request.reference}: payment verified. The subscription is being activated.`,
      link: `/activations/${id}`,
    })
    return platformView(await loadDetail(id))
  },

  async reject(id: string, reason: string, req: Request) {
    const request = await loadDetail(id)
    await prisma.$transaction((tx) =>
      transition(
        tx,
        req,
        request,
        request.status === 'PENDING_REVIEW' ? ['PENDING_REVIEW'] : ['UNDER_REVIEW'],
        'REJECTED',
        'REJECTED',
        { decidedAt: new Date(), decidedById: req.user!.userId, rejectionReason: reason },
        { note: reason, metadata: { reason } },
      ),
    )
    await notificationService.notifyReseller(request.resellerId, {
      type: 'ACTIVATION_REJECTED',
      title: 'Activation request rejected',
      body: `${request.reference}: ${reason}`,
      link: `/activations/${id}`,
    })
    return platformView(await loadDetail(id))
  },

  /** Triggers activation through the SaaS partner API (its own subscription flow). */
  async activate(id: string, req: Request) {
    const request = await loadDetail(id)
    if (request.status !== 'APPROVED') throw conflict('Only approved requests can be activated')
    if (!remoteActivationAvailable(request.product)) {
      throw new AppError('This product has no partner API. Activate it in the SaaS admin console and confirm completion here.', 422, undefined, 'MANUAL_ACTIVATION_REQUIRED')
    }
    if (!request.customerAccount.externalTenantId) throw badRequest('The customer account has no SaaS tenant')

    // The key is fixed on first use so concurrent or repeated triggers reach the SaaS with the same key.
    if (!request.idempotencyKey) {
      await prisma.activationRequest.updateMany({ where: { id, idempotencyKey: null }, data: { idempotencyKey: crypto.randomUUID() } })
    }
    const idempotencyKey = (
      await prisma.activationRequest.update({
        where: { id },
        data: { activationAttempts: { increment: 1 }, activationMethod: 'PARTNER_API' },
        select: { idempotencyKey: true },
      })
    ).idempotencyKey!

    let outcome
    try {
      const result = await integrationService.run(request.productId, 'REQUEST_ACTIVATION', id, (i) =>
        i.activateSubscription({
          idempotencyKey,
          externalRef: request.reference,
          externalTenantId: request.customerAccount.externalTenantId!,
          periodMonth: request.periodMonth,
          amount: request.amount.toFixed(2),
          currency: request.currency,
          paymentMethod: 'BANK_TRANSFER',
          paymentReference: request.transactionRef,
          paymentDate: request.transferDate.toISOString().slice(0, 10),
          verifiedBy: currentUser(req).email,
        }),
      )
      outcome = await handleActivationResult(req, request, result)
    } catch (err) {
      if (err instanceof AppError && !(err instanceof IntegrationError)) throw err
      const message = describeIntegrationError(err)
      await prisma.$transaction(async (tx) => {
        await tx.activationRequest.update({ where: { id }, data: { activationError: message } })
        await recordStep(tx, req, request, 'SAAS_FAILED', message, true, { technical: err instanceof Error ? err.message : null })
      })
      outcome = { outcome: 'FAILED' as const, message }
    }
    return { ...outcome, request: await platformView(await loadDetail(id)) }
  },

  /** Polls the SaaS for an activation it accepted asynchronously. */
  async sync(id: string, req: Request) {
    const request = await loadDetail(id)
    if (request.status !== 'APPROVED' || !request.saasRequestId) throw conflict('There is no pending SaaS activation to check')
    let outcome
    try {
      const result = await integrationService.run(request.productId, 'GET_ACTIVATION_STATUS', id, (i) => i.getActivationStatus(request.saasRequestId!))
      outcome = result
        ? await handleActivationResult(req, request, result)
        : { outcome: 'PENDING' as const, message: 'No result from the SaaS yet.' }
    } catch (err) {
      if (err instanceof AppError && !(err instanceof IntegrationError)) throw err
      outcome = { outcome: 'FAILED' as const, message: describeIntegrationError(err) }
    }
    return { ...outcome, request: await platformView(await loadDetail(id)) }
  },

  /** Confirms an activation done by staff in the SaaS's own admin console. */
  async completeManually(id: string, input: { activationReference: string; externalTenantId?: string; note?: string }, req: Request) {
    const request = await loadDetail(id)
    if (request.status !== 'APPROVED') throw conflict('Only approved requests can be completed')
    if (!request.customerAccount.externalTenantId) {
      if (!input.externalTenantId) {
        throw badRequest('Enter the external tenant ID created in the SaaS console to complete activation')
      }
      await prisma.customerAccount.update({
        where: { id: request.customerAccountId },
        data: { externalTenantId: input.externalTenantId.trim() },
      })
      request.customerAccount.externalTenantId = input.externalTenantId.trim()
    }
    await complete(req, request, 'MANUAL', { activationReference: input.activationReference, note: input.note })
    return platformView(await loadDetail(id))
  },
}
