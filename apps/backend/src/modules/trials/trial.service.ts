import { randomUUID } from 'crypto'
import type { Request } from 'express'
import { Prisma, type TrialRequestStatus } from '@prisma/client'
import { env } from '../../config/env'
import { prisma } from '../../config/database'
import { assertResellerAccess, resolveResellerId } from '../../middleware/auth.middleware'
import { AppError, badRequest, conflict, notFoundError } from '../../middleware/error.middleware'
import { toSkipTake } from '../../utils/pagination'
import { auditService } from '../audit-logs/audit.service'
import { findOrCreateCustomer, generateCustomerCode } from '../customer-accounts/customer-linking'
import { notificationService } from '../notifications/notification.service'
import { IntegrationError } from '../integrations/integration-error'
import { integrationService, trialCapability } from '../integrations/integration.service'
import type { AccountStatus, TenantIdentity } from '../integrations/saas-integration'
import { resellerAccessService } from '../products/reseller-access.service'
import {
  type CanonicalTrialOwner,
  type CreateTrialInput,
  type ListTrialsQuery,
  type TrialOwner,
  normalizeTrialOwner,
} from './trial.schema'

/** A PENDING request older than this was interrupted mid-call and may be recovered. */
const STALE_MS = env.INTEGRATION_TIMEOUT_MS * 2

const trialInclude = {
  product: {
    select: {
      id: true,
      code: true,
      name: true,
      // Never select the partner API base URL here: this include is returned to resellers as-is.
      integration: { select: { provider: true } },
    },
  },
  reseller: { select: { id: true, code: true, businessName: true } },
  customerAccount: {
    select: {
      id: true,
      status: true,
      externalTenantId: true,
      externalAccountId: true,
      customer: { select: { id: true, displayName: true, customerCode: true } },
    },
  },
} satisfies Prisma.TrialRequestInclude

type TrialWithRelations = Prisma.TrialRequestGetPayload<{ include: typeof trialInclude }>

export type TrialOutcome = 'PROVISIONED' | 'SUBMITTED' | 'FAILED' | 'PENDING'

export interface ProvisioningDetails {
  shopName: string
  planName: string
  customerCode?: string
  externalTenantId: string
  externalAccountId?: string | null
  loginUrl: string
  shopUrl: string
  ownerEmail: string
  ownerName: string
  phone: string
}

export function buildShopSlug(externalTenantId: string, shopName: string): string {
  const fromName = shopName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return fromName || externalTenantId.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

export function buildLoginUrl(product: { code: string; name: string }, _externalTenantId: string, baseUrl?: string | null): string {
  if (baseUrl) {
    const clean = baseUrl.replace(/\/+$/, '')
    return `${clean}/login`
  }
  switch (product.code) {
    case 'MOBILE_SHOP':
      return 'https://mobileshop.hexalyte.com/login'
    case 'FASHION_ERP':
      return 'https://clothingerp.hexalyte.com/login'
    case 'SALON':
      return 'https://salon.hexalyte.com/login'
    case 'SUPERMARKET':
      return 'https://pos.hexalyte.com/login'
    default:
      return 'https://app.hexalyte.com/login'
  }
}

export function buildShopUrl(product: { code: string; name: string }, externalTenantId: string, shopName: string, baseUrl?: string | null): string {
  const slug = buildShopSlug(externalTenantId, shopName)
  if (baseUrl) {
    const clean = baseUrl.replace(/\/+$/, '')
    return `${clean}/store/${slug}`
  }
  switch (product.code) {
    case 'MOBILE_SHOP':
      return `https://${slug}.mobileshop.hexalyte.com`
    case 'FASHION_ERP':
      return `https://${slug}.clothingerp.hexalyte.com`
    case 'SALON':
      return `https://${slug}.salon.hexalyte.com`
    case 'SUPERMARKET':
      return `https://${slug}.pos.hexalyte.com`
    default:
      return `https://${slug}.hexalyte.com`
  }
}

export interface OutcomeResult {
  trial: TrialWithRelations
  outcome: TrialOutcome
  message: string
  /** Returned from the SaaS for display only; not stored. */
  saas?: { status: string; trialEndsAt: string | null } | null
  provisioning?: ProvisioningDetails | null
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
      ['ADMIN'],
    )
  }
}

/** Sends the create-trial call for a claimed (PENDING) request and records the outcome. */
async function sendToSaas(trialId: string, owner: TrialOwner, req: Request): Promise<OutcomeResult> {
  const trial = await loadTrial(trialId)
  const canonicalOwner = normalizeTrialOwner(owner)
  try {
    const result = await integrationService.run(trial.productId, 'CREATE_TRIAL', trial.id, (i) =>
      i.createTrial({
        idempotencyKey: trial.idempotencyKey,
        externalRef: trial.customerAccountId,
        resellerCode: trial.reseller.code,
        businessName: canonicalOwner.businessName,
        contactName: canonicalOwner.contactName,
        contactEmail: canonicalOwner.contactEmail,
        contactPhone: canonicalOwner.contactPhone,
        password: canonicalOwner.password,
      }),
    )

    if (result.outcome === 'PROVISIONED') {
      const ok = await markProvisioned(trial, result, req)
      const refreshedTrial = await loadTrial(trialId)
      return {
        trial: refreshedTrial,
        outcome: ok ? 'PROVISIONED' : 'FAILED',
        message: ok ? `Trial account created in ${trial.product.name}.` : 'Trial could not be linked.',
        saas: ok ? { status: result.status, trialEndsAt: result.trialEndsAt ?? null } : null,
        provisioning: ok
          ? {
              shopName: canonicalOwner.businessName,
              planName: trial.product.name,
              customerCode: refreshedTrial.customerAccount.customer.customerCode ?? undefined,
              externalTenantId: result.externalTenantId,
              externalAccountId: result.externalAccountId ?? null,
              loginUrl: buildLoginUrl(trial.product, result.externalTenantId),
              shopUrl: buildShopUrl(trial.product, result.externalTenantId, canonicalOwner.businessName),
              ownerEmail: canonicalOwner.contactEmail,
              ownerName: canonicalOwner.contactName,
              phone: canonicalOwner.contactPhone,
            }
          : null,
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
    const message = result.reference
      ? `${trial.product.name} accepted the request and is creating the account. Check back shortly.`
      : `${trial.product.name} trial request submitted. External SaaS provisioning is pending (manual fulfilment).`
    return {
      trial: await loadTrial(trialId),
      outcome: 'SUBMITTED',
      message,
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

// Moved to the shared customer-linking module; re-exported so existing imports keep working.
export { generateCustomerCode }

export const trialService = {
  async list(query: ListTrialsQuery, req: Request) {
    const resellerId = resolveResellerId(req, query.resellerId)
    const baseWhere: Prisma.TrialRequestWhereInput = {
      resellerId,
      productId: query.productId,
    }
    const where: Prisma.TrialRequestWhereInput = {
      ...baseWhere,
      ...(query.status === 'PROVISIONED'
        ? {
            status: 'PROVISIONED',
            customerAccount: {
              status: 'TRIAL',
              externalTenantId: { not: null },
            },
          }
        : query.status
          ? { status: query.status }
          : {}),
      ...(query.search
        ? {
            OR: [
              { customerAccount: { customer: { displayName: { contains: query.search, mode: 'insensitive' } } } },
              { customerAccount: { customer: { customerCode: { contains: query.search, mode: 'insensitive' } } } },
              { customerAccount: { externalTenantId: { contains: query.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    }
    const [
      items,
      total,
      totalCount,
      activeTrialsCount,
      processingCount,
      manualFulfilmentCount,
      failedCount,
      convertedCount,
    ] = await Promise.all([
      prisma.trialRequest.findMany({ where, include: trialInclude, orderBy: { createdAt: 'desc' }, ...toSkipTake(query) }),
      prisma.trialRequest.count({ where }),
      prisma.trialRequest.count({ where: baseWhere }),
      // Active Trials: genuinely provisioned trial subscriptions that are still trials
      prisma.trialRequest.count({
        where: {
          ...baseWhere,
          status: 'PROVISIONED',
          customerAccount: {
            status: 'TRIAL',
            externalTenantId: { not: null },
          },
        },
      }),
      // Processing: in-progress requests awaiting tenant provisioning
      prisma.trialRequest.count({
        where: {
          ...baseWhere,
          status: { in: ['SUBMITTED', 'PENDING'] },
          customerAccount: {
            status: { not: 'ACTIVE' },
          },
        },
      }),
      // Manual fulfilment: in-progress requests awaiting manual provisioning
      prisma.trialRequest.count({
        where: {
          ...baseWhere,
          status: { in: ['SUBMITTED', 'PENDING'] },
          customerAccount: {
            status: { not: 'ACTIVE' },
          },
          product: {
            OR: [
              { integration: { provider: 'MANUAL' } },
              { integration: null },
            ],
          },
        },
      }),
      // Failed requests
      prisma.trialRequest.count({
        where: {
          ...baseWhere,
          status: 'FAILED',
        },
      }),
      // Converted/Paid accounts
      prisma.trialRequest.count({
        where: {
          ...baseWhere,
          customerAccount: {
            status: 'ACTIVE',
          },
        },
      }),
    ])

    const pipelineCounts = {
      total: totalCount,
      provisioned: activeTrialsCount,
      processing: processingCount,
      manualFulfilment: manualFulfilmentCount,
      failed: failedCount,
      converted: convertedCount,
    }

    return { items, total, pipelineCounts }
  },

  get: (id: string, req: Request) => loadTrial(id, req),

  async create(input: CreateTrialInput, req: Request): Promise<OutcomeResult> {
    const resellerId = resolveResellerId(req, input.resellerId)
    if (!resellerId) throw badRequest('resellerId is required')

    const reseller = await prisma.reseller.findUnique({ where: { id: resellerId }, select: { status: true } })
    if (!reseller) throw notFoundError('Partner')
    if (reseller.status !== 'ACTIVE') throw badRequest('Partner is not active')

    const MAX_TRIALS_PER_RESELLER = 100
    const activeTrialCount = await prisma.customerAccount.count({
      where: { resellerId, status: 'TRIAL' },
    })
    if (activeTrialCount >= MAX_TRIALS_PER_RESELLER) {
      throw conflict(`Partner trial account limit reached (maximum ${MAX_TRIALS_PER_RESELLER} active trial accounts allowed). Please convert existing trials to paid activations before creating new ones.`)
    }

    await resellerAccessService.assertCanSell(resellerId, input.productId)

    const product = await prisma.saasProduct.findUnique({
      where: { id: input.productId },
      select: { name: true, status: true, trialAvailable: true, integrationStatus: true, integration: { select: { provider: true } } },
    })
    if (!product) throw notFoundError('SaaS product')
    const capability = trialCapability(product)
    if (!capability.canCreateTrial) throw new AppError(capability.reason!, 422, undefined, 'TRIAL_API_UNAVAILABLE')

    const owner = normalizeTrialOwner(input.owner)

    const trialId = await prisma.$transaction(async (tx) => {
      let customerId = input.customerId
      if (customerId) {
        const customer = await tx.customer.findUnique({ where: { id: customerId }, select: { resellerId: true } })
        if (!customer || customer.resellerId !== resellerId) throw badRequest('Customer not found')
      } else {
        customerId = await findOrCreateCustomer(tx, resellerId, owner.businessName)
      }

      // 3. Create or link the correct CustomerAccount and trial request for the selected SaaS product
      const existing = await tx.customerAccount.findUnique({
        where: { customerId_productId: { customerId, productId: input.productId } },
        include: {
          trialRequests: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true } },
          activationRequests: {
            where: { status: { in: ['PENDING_REVIEW', 'UNDER_REVIEW', 'APPROVED'] } },
            take: 1,
            select: { reference: true, status: true },
          },
        },
      })
      let accountId: string
      if (existing) {
        if (existing.status === 'ACTIVE') throw conflict(`This customer already has an active paid subscription for ${product.name}`)
        if (existing.status === 'TRIAL' || existing.externalTenantId) throw conflict(`This customer already has an active trial for ${product.name}`)
        const openActivation = existing.activationRequests[0]
        if (openActivation) {
          throw conflict(`An activation request (${openActivation.reference}) is already pending review for this customer account`)
        }
        const last = existing.trialRequests[0]?.status
        if (last === 'PENDING' || last === 'SUBMITTED') throw conflict('A trial request for this customer is already in progress')
        if (last === 'FAILED') {
          throw new AppError('A previous trial request for this customer failed. Retry it from the trial list.', 409, undefined, 'TRIAL_RETRY_AVAILABLE')
        }
        await tx.customerAccount.update({ where: { id: existing.id }, data: { status: 'PENDING', deactivatedAt: null } })
        accountId = existing.id
      } else {
        try {
          accountId = (
            await tx.customerAccount.create({
              data: { resellerId, customerId, productId: input.productId, status: 'PENDING' },
            })
          ).id
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            throw conflict('A customer account for this product is already being created or linked. Please retry.')
          }
          throw err
        }
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

    return sendToSaas(trialId, owner, req)
  },

  /**
   * Retries a FAILED request. Owner details must be provided again because
   * they are not stored. After a transient failure the SaaS is first asked
   * whether the tenant was created anyway.
   */
  async retry(id: string, ownerInput: TrialOwner, req: Request): Promise<OutcomeResult> {
    const owner = normalizeTrialOwner(ownerInput)
    const trial = await loadTrial(id, req)
    if (trial.status !== 'FAILED') throw conflict('Only failed trial requests can be retried')

    if (trial.errorRetryable) {
      const found = await lookupTenant(trial).catch(() => null)
      if (found) {
        const ok = await markProvisioned(trial, found, req)
        const refreshed = await loadTrial(id)
        return {
          trial: refreshed,
          outcome: ok ? 'PROVISIONED' : 'FAILED',
          message: ok ? `The ${trial.product.name} account had already been created and is now linked.` : 'Trial could not be linked.',
          saas: ok ? { status: found.status, trialEndsAt: found.trialEndsAt ?? null } : null,
          provisioning: ok
            ? {
                shopName: owner.businessName,
                planName: trial.product.name,
                externalTenantId: found.externalTenantId,
                externalAccountId: found.externalAccountId ?? null,
                loginUrl: buildLoginUrl(trial.product, found.externalTenantId),
                shopUrl: buildShopUrl(trial.product, found.externalTenantId, owner.businessName),
                ownerEmail: owner.contactEmail,
                ownerName: owner.contactName,
                phone: owner.contactPhone,
              }
            : null,
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
    if (trial.product.integration?.provider === 'MANUAL') {
      throw badRequest('Remote status check is not supported for manual fulfilment products. SaaS tenant provisioning must be confirmed by an administrator.')
    }
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
