import { randomUUID } from 'crypto'
import type { Request } from 'express'
import { Prisma, type TrialRequestStatus } from '@prisma/client'
import { env } from '../../config/env'
import { prisma } from '../../config/database'
import { assertResellerAccess, resolveResellerId } from '../../middleware/auth.middleware'
import { AppError, badRequest, conflict, notFoundError } from '../../middleware/error.middleware'
import { toSkipTake } from '../../utils/pagination'
import { auditService } from '../audit-logs/audit.service'
import { notificationService } from '../notifications/notification.service'
import { IntegrationError } from '../integrations/integration-error'
import { integrationService, trialCapability } from '../integrations/integration.service'
import type { AccountStatus, TenantIdentity } from '../integrations/saas-integration'
import { resellerAccessService } from '../products/reseller-access.service'
import type { CreateTrialInput, ListTrialsQuery, TrialOwner } from './trial.schema'

/** A PENDING request older than this was interrupted mid-call and may be recovered. */
const STALE_MS = env.INTEGRATION_TIMEOUT_MS * 2

const trialInclude = {
  product: { select: { id: true, code: true, name: true } },
  reseller: { select: { id: true, code: true, businessName: true } },
  customerAccount: {
    select: {
      id: true,
      status: true,
      externalTenantId: true,
      externalAccountId: true,
      customer: { select: { id: true, displayName: true } },
    },
  },
} satisfies Prisma.TrialRequestInclude

type TrialWithRelations = Prisma.TrialRequestGetPayload<{ include: typeof trialInclude }>

export type TrialOutcome = 'PROVISIONED' | 'SUBMITTED' | 'FAILED' | 'PENDING'

interface OutcomeResult {
  trial: TrialWithRelations
  outcome: TrialOutcome
  message: string
  /** Returned from the SaaS for display only; not stored. */
  saas?: { status: string; trialEndsAt: string | null } | null
}

interface FailureInfo {
  message: string
  retryable: boolean
  /** Credentials, missing endpoint, etc.: platform admins must act. */
  configProblem: boolean
}

function classify(err: unknown): FailureInfo {
  if (err instanceof IntegrationError) {
    const status = err.httpStatus
    if (status === undefined || status >= 500 || status === 408 || status === 429) {
      return {
        message: 'The SaaS did not complete the request (timeout or server error). Retrying is safe and will not create a duplicate account.',
        retryable: true,
        configProblem: false,
      }
    }
    if (status === 401 || status === 403 || status === 404) {
      return {
        message: 'The SaaS trial API rejected the platform connection. Hexalyte support has been notified.',
        retryable: false,
        configProblem: true,
      }
    }
    // 400 / 409 / 422: the SaaS's own validation (e.g. email already registered) – fixable by the reseller.
    return { message: err.message.replace(/^SaaS API error:\s*/, ''), retryable: false, configProblem: false }
  }
  if (err instanceof AppError && err.statusCode < 500) {
    return { message: err.message, retryable: false, configProblem: true }
  }
  return { message: 'Unexpected error while creating the trial. Hexalyte support has been notified.', retryable: true, configProblem: true }
}

async function loadTrial(id: string, req?: Request) {
  const trial = await prisma.trialRequest.findUnique({ where: { id }, include: trialInclude })
  if (!trial) throw notFoundError('Trial request')
  if (req) assertResellerAccess(req, trial.resellerId)
  return trial
}

/** Atomically moves a trial from one of `from` to PENDING for a new attempt; only one caller wins. */
async function claimAttempt(id: string, from: TrialRequestStatus[]) {
  const result = await prisma.trialRequest.updateMany({
    where: { id, status: { in: from } },
    data: {
      status: 'PENDING',
      attempts: { increment: 1 },
      idempotencyKey: randomUUID(),
      submittedAt: new Date(),
      errorMessage: null,
      errorRetryable: null,
    },
  })
  if (result.count === 0) throw conflict('This trial request is not in a state that allows this action')
}

async function markProvisioned(trial: TrialWithRelations, tenant: TenantIdentity, req: Request): Promise<boolean> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.customerAccount.update({
        where: { id: trial.customerAccountId },
        data: {
          externalTenantId: tenant.externalTenantId,
          externalAccountId: tenant.externalAccountId ?? null,
          status: 'TRIAL',
          deactivatedAt: null,
        },
      })
      await tx.trialRequest.update({
        where: { id: trial.id },
        data: { status: 'PROVISIONED', completedAt: new Date(), errorMessage: null, errorRetryable: null },
      })
      await auditService.fromRequest(
        req,
        {
          action: 'TRIAL_PROVISIONED',
          entityType: 'TrialRequest',
          entityId: trial.id,
          resellerId: trial.resellerId,
          metadata: {
            customerAccountId: trial.customerAccountId,
            productId: trial.productId,
            externalTenantId: tenant.externalTenantId,
            externalAccountId: tenant.externalAccountId ?? null,
          },
        },
        tx,
      )
    })
    return true
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      await markFailed(
        trial,
        {
          message: 'The SaaS returned a tenant that is already linked to another customer. Hexalyte support has been notified.',
          retryable: false,
          configProblem: true,
        },
        req,
      )
      return false
    }
    throw err
  }
}

async function markFailed(trial: TrialWithRelations, failure: FailureInfo, req: Request, technical?: string) {
  await prisma.trialRequest.update({
    where: { id: trial.id },
    data: { status: 'FAILED', errorMessage: failure.message, errorRetryable: failure.retryable, completedAt: null },
  })
  await auditService.fromRequest(req, {
    action: 'TRIAL_FAILED',
    entityType: 'TrialRequest',
    entityId: trial.id,
    resellerId: trial.resellerId,
    metadata: { productId: trial.productId, reason: failure.message, technical: technical ?? null, retryable: failure.retryable },
  })
  if (failure.configProblem) {
    await notificationService.notifyPlatform(
      {
        type: 'TRIAL_INTEGRATION_FAILED',
        title: `Trial creation failed for ${trial.product.name}`,
        body: `${trial.reseller.businessName} (${trial.reseller.code}): ${technical ?? failure.message}`,
        link: `/admin/products/${trial.productId}`,
      },
      ['SUPER_ADMIN', 'ADMIN'],
    )
  }
}

/** Sends the create-trial call for a claimed (PENDING) request and records the outcome. */
async function sendToSaas(trialId: string, owner: TrialOwner, req: Request): Promise<OutcomeResult> {
  const trial = await loadTrial(trialId)
  try {
    const result = await integrationService.run(trial.productId, 'CREATE_TRIAL', trial.id, (i) =>
      i.createTrial({
        idempotencyKey: trial.idempotencyKey,
        externalRef: trial.customerAccountId,
        resellerCode: trial.reseller.code,
        ...owner,
      }),
    )

    if (result.outcome === 'PROVISIONED') {
      const ok = await markProvisioned(trial, result, req)
      return {
        trial: await loadTrial(trialId),
        outcome: ok ? 'PROVISIONED' : 'FAILED',
        message: ok ? `Trial account created in ${trial.product.name}.` : 'Trial could not be linked.',
        saas: ok ? { status: result.status, trialEndsAt: result.trialEndsAt ?? null } : null,
      }
    }

    await prisma.trialRequest.update({ where: { id: trial.id }, data: { status: 'SUBMITTED', saasReference: result.reference ?? null } })
    await auditService.fromRequest(req, {
      action: 'TRIAL_SUBMITTED',
      entityType: 'TrialRequest',
      entityId: trial.id,
      resellerId: trial.resellerId,
      metadata: { productId: trial.productId, saasReference: result.reference ?? null },
    })
    return {
      trial: await loadTrial(trialId),
      outcome: 'SUBMITTED',
      message: `${trial.product.name} accepted the request and is creating the account. Check back shortly.`,
    }
  } catch (err) {
    const failure = classify(err)
    await markFailed(trial, failure, req, err instanceof Error ? err.message : undefined)
    return { trial: await loadTrial(trialId), outcome: 'FAILED', message: failure.message }
  }
}

/** Asks the SaaS whether a tenant already exists for this request's customer account. */
async function lookupTenant(trial: TrialWithRelations): Promise<AccountStatus | null> {
  return integrationService.run(trial.productId, 'LOOKUP_TENANT', trial.id, (i) =>
    i.findTenantByReference(trial.customerAccountId),
  )
}

function isStalePending(trial: { status: TrialRequestStatus; submittedAt: Date | null }) {
  return trial.status === 'PENDING' && (!trial.submittedAt || Date.now() - trial.submittedAt.getTime() > STALE_MS)
}

export const trialService = {
  async list(query: ListTrialsQuery, req: Request) {
    const where: Prisma.TrialRequestWhereInput = {
      resellerId: resolveResellerId(req, query.resellerId),
      productId: query.productId,
      status: query.status,
      ...(query.search
        ? {
            OR: [
              { customerAccount: { customer: { displayName: { contains: query.search, mode: 'insensitive' } } } },
              { customerAccount: { externalTenantId: { contains: query.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    }
    const [items, total] = await Promise.all([
      prisma.trialRequest.findMany({ where, include: trialInclude, orderBy: { createdAt: 'desc' }, ...toSkipTake(query) }),
      prisma.trialRequest.count({ where }),
    ])
    return { items, total }
  },

  get: (id: string, req: Request) => loadTrial(id, req),

  async create(input: CreateTrialInput, req: Request): Promise<OutcomeResult> {
    const resellerId = resolveResellerId(req, input.resellerId)
    if (!resellerId) throw badRequest('resellerId is required')

    const reseller = await prisma.reseller.findUnique({ where: { id: resellerId }, select: { status: true } })
    if (!reseller) throw notFoundError('Reseller')
    if (reseller.status !== 'ACTIVE') throw badRequest('Reseller is not active')
    await resellerAccessService.assertCanSell(resellerId, input.productId)

    const product = await prisma.saasProduct.findUnique({
      where: { id: input.productId },
      select: { name: true, status: true, trialAvailable: true, integrationStatus: true, integration: { select: { provider: true } } },
    })
    if (!product) throw notFoundError('SaaS product')
    const capability = trialCapability(product)
    if (!capability.canCreateTrial) throw new AppError(capability.reason!, 422, undefined, 'TRIAL_API_UNAVAILABLE')

    const trialId = await prisma.$transaction(async (tx) => {
      let customerId = input.customerId
      if (customerId) {
        const customer = await tx.customer.findUnique({ where: { id: customerId }, select: { resellerId: true } })
        if (!customer || customer.resellerId !== resellerId) throw badRequest('Customer not found')
      } else {
        customerId = (await tx.customer.create({ data: { resellerId, displayName: input.owner.businessName } })).id
      }

      const existing = await tx.customerAccount.findUnique({
        where: { customerId_productId: { customerId, productId: input.productId } },
        include: { trialRequests: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true } } },
      })
      let accountId: string
      if (existing) {
        if (existing.externalTenantId) throw conflict(`This customer already has a ${product.name} account`)
        const last = existing.trialRequests[0]?.status
        if (last === 'PENDING' || last === 'SUBMITTED') throw conflict('A trial request for this customer is already in progress')
        if (last === 'FAILED') {
          throw new AppError('A previous trial request for this customer failed. Retry it from the trial list.', 409, undefined, 'TRIAL_RETRY_AVAILABLE')
        }
        await tx.customerAccount.update({ where: { id: existing.id }, data: { status: 'PENDING', deactivatedAt: null } })
        accountId = existing.id
      } else {
        accountId = (
          await tx.customerAccount.create({
            data: { resellerId, customerId, productId: input.productId, status: 'PENDING' },
          })
        ).id
      }

      const trial = await tx.trialRequest.create({
        data: {
          resellerId,
          productId: input.productId,
          customerAccountId: accountId,
          notes: input.notes,
          idempotencyKey: randomUUID(),
          attempts: 1,
          submittedAt: new Date(),
          requestedById: req.user!.userId,
        },
      })
      await auditService.fromRequest(
        req,
        {
          action: 'TRIAL_REQUESTED',
          entityType: 'TrialRequest',
          entityId: trial.id,
          resellerId,
          metadata: { productId: input.productId, customerId, customerAccountId: accountId },
        },
        tx,
      )
      return trial.id
    })

    return sendToSaas(trialId, input.owner, req)
  },

  /**
   * Retries a FAILED request. Owner details must be provided again because
   * they are not stored. After a transient failure the SaaS is first asked
   * whether the tenant was created anyway.
   */
  async retry(id: string, owner: TrialOwner, req: Request): Promise<OutcomeResult> {
    const trial = await loadTrial(id, req)
    if (trial.status !== 'FAILED') throw conflict('Only failed trial requests can be retried')

    if (trial.errorRetryable) {
      const found = await lookupTenant(trial).catch(() => null)
      if (found) {
        const ok = await markProvisioned(trial, found, req)
        return {
          trial: await loadTrial(id),
          outcome: ok ? 'PROVISIONED' : 'FAILED',
          message: ok ? `The ${trial.product.name} account had already been created and is now linked.` : 'Trial could not be linked.',
          saas: ok ? { status: found.status, trialEndsAt: found.trialEndsAt ?? null } : null,
        }
      }
    }

    await claimAttempt(id, ['FAILED'])
    await auditService.fromRequest(req, {
      action: 'TRIAL_RETRIED',
      entityType: 'TrialRequest',
      entityId: id,
      resellerId: trial.resellerId,
      metadata: { attempt: trial.attempts + 1 },
    })
    return sendToSaas(id, owner, req)
  },

  /** Checks with the SaaS whether a submitted or interrupted request has produced a tenant. */
  async sync(id: string, req: Request): Promise<OutcomeResult> {
    const trial = await loadTrial(id, req)
    const eligible = trial.status === 'SUBMITTED' || (trial.status === 'FAILED' && trial.errorRetryable) || isStalePending(trial)
    if (!eligible) throw conflict('Nothing to check for this trial request')

    let found: AccountStatus | null
    try {
      found = await lookupTenant(trial)
    } catch (err) {
      return { trial, outcome: trial.status as TrialOutcome, message: `Could not reach the SaaS: ${classify(err).message}` }
    }

    if (found) {
      const ok = await markProvisioned(trial, found, req)
      return {
        trial: await loadTrial(id),
        outcome: ok ? 'PROVISIONED' : 'FAILED',
        message: ok ? `Trial account created in ${trial.product.name}.` : 'Trial could not be linked.',
        saas: ok ? { status: found.status, trialEndsAt: found.trialEndsAt ?? null } : null,
      }
    }
    if (isStalePending(trial)) {
      await markFailed(trial, { message: 'The request was interrupted before the SaaS confirmed it. Retry to continue.', retryable: true, configProblem: false }, req)
      return { trial: await loadTrial(id), outcome: 'FAILED', message: 'The request was interrupted. Retry to continue.' }
    }
    return { trial, outcome: trial.status as TrialOutcome, message: 'The SaaS is still processing this request.' }
  },

  async cancel(id: string, req: Request) {
    const trial = await loadTrial(id, req)
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.trialRequest.updateMany({ where: { id, status: 'FAILED' }, data: { status: 'CANCELLED', completedAt: new Date() } })
      if (updated.count === 0) throw conflict('Only failed trial requests can be cancelled')
      await tx.customerAccount.updateMany({
        where: { id: trial.customerAccountId, externalTenantId: null },
        data: { status: 'CANCELLED', deactivatedAt: new Date() },
      })
      await auditService.fromRequest(
        req,
        { action: 'TRIAL_CANCELLED', entityType: 'TrialRequest', entityId: id, resellerId: trial.resellerId },
        tx,
      )
      return updated.count
    })
    return { cancelled: result === 1, trial: await loadTrial(id) }
  },
}
