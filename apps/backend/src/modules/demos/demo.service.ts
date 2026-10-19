import type { Request } from 'express'
import { Prisma, type DemoRequestStatus } from '@prisma/client'
import { prisma } from '../../config/database'
import { assertResellerAccess, currentUser, resolveResellerId } from '../../middleware/auth.middleware'
import { badRequest, conflict, notFoundError } from '../../middleware/error.middleware'
import { isPlatformRole } from '../../rbac/permissions'
import { toSkipTake } from '../../utils/pagination'
import { auditService } from '../audit-logs/audit.service'
import { notificationService } from '../notifications/notification.service'
import { resellerAccessService } from '../products/reseller-access.service'
import { findOrCreateCustomer, linkTrialAccount } from '../customer-accounts/customer-linking'
import type { ConfirmDemoInput, CreateDemoRequestInput, ListDemoRequestsQuery } from './demo.schema'

type Status = DemoRequestStatus
type Tx = Prisma.TransactionClient

/** Anything other than REJECTED blocks a new demo request for the same reseller/contact/product. */
const OPEN_STATUSES: Status[] = ['PENDING', 'APPROVED', 'DEMO_CREATED', 'CONFIRMED']
const REVIEW_ROLES = ['ADMIN'] as const

const listInclude = {
  product: { select: { id: true, code: true, name: true } },
  reseller: { select: { id: true, code: true, businessName: true } },
} satisfies Prisma.DemoRequestInclude

const detailInclude = {
  ...listInclude,
  history: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.DemoRequestInclude

type Detail = Prisma.DemoRequestGetPayload<{ include: typeof detailInclude }>

function newNotes(v?: string) {
  return v && v.length > 0 ? v : undefined
}

/**
 * Moves a request between statuses. The status guard in `updateMany` makes
 * concurrent admin actions safe: only the first action to match the current
 * status wins; a second concurrent attempt sees `count === 0` and conflicts.
 */
async function transition(
  tx: Tx,
  req: Request,
  request: { id: string; resellerId: string },
  from: Status[],
  to: Status,
  action: string,
  data: Prisma.DemoRequestUpdateManyMutationInput = {},
  opts: { note?: string | null; internal?: boolean; metadata?: Prisma.InputJsonObject } = {},
) {
  const updated = await tx.demoRequest.updateMany({ where: { id: request.id, status: { in: from } }, data: { ...data, status: to } })
  if (updated.count === 0) {
    const current = await tx.demoRequest.findUnique({ where: { id: request.id }, select: { status: true } })
    throw conflict(`This action is not allowed while the request is ${current?.status ?? 'unknown'}`)
  }
  const previous = from.length === 1 ? from[0] : null
  await tx.demoRequestStatusChange.create({
    data: {
      demoRequestId: request.id,
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
      action: `DEMO_${action}`,
      entityType: 'DemoRequest',
      entityId: request.id,
      resellerId: request.resellerId,
      metadata: { from, to, ...(opts.metadata ?? {}) },
    },
    tx,
  )
}

async function loadDetail(id: string) {
  const request = await prisma.demoRequest.findUnique({ where: { id }, include: detailInclude })
  if (!request) throw notFoundError('Demo request')
  return request
}

async function userNames(ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))]
  if (unique.length === 0) return new Map<string, { name: string; email: string }>()
  const users = await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true, email: true } })
  return new Map(users.map((u) => [u.id, { name: u.name, email: u.email }]))
}

/**
 * Builds a `wa.me` deep link with the welcome message pre-filled, mirroring
 * the existing manual WhatsApp pattern used for trial welcome messages
 * (apps/web/src/app/trials/new/page.tsx). Opening it only *opens* WhatsApp
 * with the message ready to send — it never sends anything itself and there
 * is no delivery confirmation, which is why the frontend must describe this
 * as "prepared"/"opened", never "delivered".
 */
export function buildWhatsAppLink(phone: string, message: string): string {
  let clean = phone.replace(/[^\d]/g, '')
  if (clean.startsWith('0')) clean = `94${clean.slice(1)}`
  else if (!clean.startsWith('94') && clean.length === 9) clean = `94${clean}`
  return `https://wa.me/${clean}?text=${encodeURIComponent(message)}`
}

// ─── Serialisation ───────────────────────────────────────────────────────────

async function platformView(request: Detail) {
  const names = await userNames([
    request.requestedById,
    request.reviewedById,
    request.demoCreatedById,
    request.confirmedById,
    ...request.history.map((h) => h.actorUserId),
  ])
  const { history, ...rest } = request
  return {
    ...rest,
    people: {
      requestedBy: names.get(request.requestedById) ?? null,
      reviewedBy: request.reviewedById ? (names.get(request.reviewedById) ?? null) : null,
      demoCreatedBy: request.demoCreatedById ? (names.get(request.demoCreatedById) ?? null) : null,
      confirmedBy: request.confirmedById ? (names.get(request.confirmedById) ?? null) : null,
    },
    history: history.map((h) => ({ ...h, actor: h.actorUserId ? (names.get(h.actorUserId) ?? null) : null })),
  }
}

/** Reseller view: no internal review notes, reviewer identity, or rejection internals beyond the shared reason. */
function resellerView(request: Detail) {
  const detailsAvailable = request.status === 'DEMO_CREATED' || request.status === 'CONFIRMED'
  return {
    id: request.id,
    status: request.status,
    businessName: request.businessName,
    contactName: request.contactName,
    contactEmail: request.contactEmail,
    contactPhone: request.contactPhone,
    notes: request.notes,
    submittedAt: request.submittedAt,
    decidedAt: request.decidedAt,
    rejectionReason: request.rejectionReason,
    product: request.product,
    reseller: request.reseller,
    demoCreatedAt: request.demoCreatedAt,
    confirmedAt: request.confirmedAt,
    // The admin-saved welcome message is only shown to the reseller once an
    // admin has actually saved it (DEMO_CREATED or later), exactly as saved.
    welcomeMessage: detailsAvailable ? request.welcomeMessage : null,
    /** Pre-filled wa.me link the reseller can open; opening it is not proof of delivery (see buildWhatsAppLink). */
    whatsappLink: detailsAvailable && request.welcomeMessage ? buildWhatsAppLink(request.contactPhone, request.welcomeMessage) : null,
    history: request.history
      .filter((h) => !h.internal)
      .map((h) => ({ id: h.id, fromStatus: h.fromStatus, toStatus: h.toStatus, action: h.action, note: h.note, createdAt: h.createdAt })),
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export const demoService = {
  async list(query: ListDemoRequestsQuery, req: Request) {
    const resellerId = resolveResellerId(req, query.resellerId)
    const baseWhere: Prisma.DemoRequestWhereInput = { resellerId, productId: query.productId }
    const where: Prisma.DemoRequestWhereInput = {
      ...baseWhere,
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { businessName: { contains: query.search, mode: 'insensitive' } },
              { contactName: { contains: query.search, mode: 'insensitive' } },
              { contactEmail: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    }
    const [items, total, totalCount, pendingCount, approvedCount, demoCreatedCount, confirmedCount] = await Promise.all([
      prisma.demoRequest.findMany({ where, include: listInclude, orderBy: { submittedAt: 'desc' }, ...toSkipTake(query) }),
      prisma.demoRequest.count({ where }),
      prisma.demoRequest.count({ where: baseWhere }),
      prisma.demoRequest.count({ where: { ...baseWhere, status: 'PENDING' } }),
      prisma.demoRequest.count({ where: { ...baseWhere, status: 'APPROVED' } }),
      prisma.demoRequest.count({ where: { ...baseWhere, status: 'DEMO_CREATED' } }),
      prisma.demoRequest.count({ where: { ...baseWhere, status: 'CONFIRMED' } }),
    ])
    const pipelineCounts = {
      total: totalCount,
      pending: pendingCount,
      approved: approvedCount,
      demoCreated: demoCreatedCount,
      confirmed: confirmedCount,
    }
    return { items, total, pipelineCounts }
  },

  async get(id: string, req: Request) {
    const request = await loadDetail(id)
    assertResellerAccess(req, request.resellerId)
    return isPlatformRole(currentUser(req).role) ? platformView(request) : resellerView(request)
  },

  async create(input: CreateDemoRequestInput, req: Request) {
    const user = currentUser(req)
    if (isPlatformRole(user.role) || !user.resellerId) throw conflict('Demo requests are submitted by partners')
    const resellerId = user.resellerId

    // Same eligibility rule as trial.service.ts: only an approved, active
    // reseller may use this feature — a PENDING/REJECTED/SUSPENDED/TERMINATED
    // reseller's user must not be able to submit demo requests.
    const reseller = await prisma.reseller.findUnique({ where: { id: resellerId }, select: { status: true } })
    if (!reseller) throw notFoundError('Partner')
    if (reseller.status !== 'ACTIVE') throw badRequest('Partner is not active')

    await resellerAccessService.assertCanSell(resellerId, input.productId)

    // Fast, friendly pre-check. This alone cannot close the race between two
    // concurrent submissions — that is enforced by the partial unique index
    // added in the 20261014130000_demo_requests_open_duplicate_index
    // migration, backstopped by the P2002 catch below.
    const anyOpen = await prisma.demoRequest.findFirst({
      where: {
        resellerId,
        productId: input.productId,
        contactEmail: input.contactEmail,
        status: { in: OPEN_STATUSES },
      },
      select: { id: true, status: true },
    })
    if (anyOpen) {
      throw conflict(`A demo request for this customer and product is already ${anyOpen.status.replace(/_/g, ' ').toLowerCase()}`)
    }

    const created = await prisma.$transaction(async (tx) => {
      let request: { id: string }
      try {
        request = await tx.demoRequest.create({
          data: {
            resellerId,
            productId: input.productId,
            businessName: input.businessName,
            contactName: input.contactName,
            contactEmail: input.contactEmail,
            contactPhone: input.contactPhone,
            notes: newNotes(input.notes),
            requestedById: user.userId,
            history: { create: { toStatus: 'PENDING', action: 'SUBMITTED', actorUserId: user.userId } },
          },
          select: { id: true },
        })
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw conflict('A demo request for this customer and product is already open')
        }
        throw err
      }
      await auditService.fromRequest(
        req,
        {
          action: 'DEMO_SUBMITTED',
          entityType: 'DemoRequest',
          entityId: request.id,
          resellerId,
          metadata: { productId: input.productId, businessName: input.businessName },
        },
        tx,
      )
      return request
    })

    await notificationService.notifyPlatform(
      {
        type: 'DEMO_REQUESTED',
        title: 'New demo request',
        body: `${input.businessName}: a partner requested a demo.`,
        link: `/admin/demo-requests/${created.id}`,
      },
      REVIEW_ROLES,
    )

    return loadDetail(created.id).then(resellerView)
  },

  async approve(id: string, note: string | undefined, req: Request) {
    const request = await loadDetail(id)
    await prisma.$transaction((tx) =>
      transition(
        tx,
        req,
        request,
        ['PENDING'],
        'APPROVED',
        'APPROVED',
        { reviewedById: req.user!.userId, decidedAt: new Date() },
        { note: note ?? null, internal: true },
      ),
    )
    await notificationService.notifyReseller(request.resellerId, {
      type: 'DEMO_APPROVED',
      title: 'Demo request approved',
      body: `${request.businessName}: approved. Hexalyte will create the demo shop next.`,
      link: `/demo-requests/${id}`,
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
        ['PENDING'],
        'REJECTED',
        'REJECTED',
        { reviewedById: req.user!.userId, decidedAt: new Date(), rejectionReason: reason },
        { note: reason, metadata: { reason } },
      ),
    )
    await notificationService.notifyReseller(request.resellerId, {
      type: 'DEMO_REJECTED',
      title: 'Demo request rejected',
      body: `${request.businessName}: ${reason}`,
      link: `/demo-requests/${id}`,
    })
    return platformView(await loadDetail(id))
  },

  /**
   * Saves the admin's already-prepared customer welcome message against an
   * approved request and makes it visible to the reseller exactly as pasted.
   * Nothing is generated or rewritten here, and nothing is created in the SaaS.
   */
  async saveWelcomeMessage(id: string, welcomeMessage: string, req: Request) {
    const request = await loadDetail(id)
    await prisma.$transaction((tx) =>
      transition(
        tx,
        req,
        request,
        ['APPROVED'],
        'DEMO_CREATED',
        'DEMO_CREATED',
        { welcomeMessage, demoCreatedAt: new Date(), demoCreatedById: req.user!.userId },
        { internal: false },
      ),
    )
    await notificationService.notifyReseller(request.resellerId, {
      type: 'DEMO_CREATED',
      title: 'Demo ready to share',
      body: `${request.businessName}: the customer welcome message is ready. Open the request to copy it or open WhatsApp.`,
      link: `/demo-requests/${id}`,
    })
    return platformView(await loadDetail(id))
  },

  /**
   * Confirms the demo and, in the same transaction, creates or links the Customer and its TRIAL
   * account for the tenant the admin created. If linking conflicts (customer already paid, tenant
   * already used, …) the whole confirmation rolls back and the request stays DEMO_CREATED.
   * Nothing is created in the SaaS itself.
   */
  async confirm(id: string, input: ConfirmDemoInput, req: Request) {
    const request = await loadDetail(id)
    if (request.status !== 'DEMO_CREATED') {
      throw conflict(`This action is not allowed while the request is ${request.status}`)
    }

    const reseller = await prisma.reseller.findUnique({ where: { id: request.resellerId }, select: { status: true } })
    if (!reseller) throw notFoundError('Partner')
    if (reseller.status !== 'ACTIVE') throw badRequest('Partner is not active')
    await resellerAccessService.assertCanSell(request.resellerId, request.productId)

    const linkedAccount = await prisma.$transaction(async (tx) => {
      await transition(
        tx,
        req,
        request,
        ['DEMO_CREATED'],
        'CONFIRMED',
        'CONFIRMED',
        { confirmedAt: new Date(), confirmedById: req.user!.userId },
        { note: input.note ?? null, internal: true },
      )

      const customerId = await findOrCreateCustomer(tx, request.resellerId, request.businessName)
      const { accountId, created } = await linkTrialAccount(tx, {
        resellerId: request.resellerId,
        customerId,
        productId: request.productId,
        productName: request.product.name,
        externalTenantId: input.externalTenantId,
      })
      const customer = await tx.customer.findUniqueOrThrow({ where: { id: customerId }, select: { customerCode: true, displayName: true } })

      await auditService.fromRequest(
        req,
        {
          action: 'DEMO_CUSTOMER_LINKED',
          entityType: 'DemoRequest',
          entityId: request.id,
          resellerId: request.resellerId,
          metadata: { customerId, customerAccountId: accountId, productId: request.productId, externalTenantId: input.externalTenantId, accountCreated: created },
        },
        tx,
      )
      return { customerId, customerCode: customer.customerCode, displayName: customer.displayName, accountId, accountCreated: created }
    })

    await notificationService.notifyReseller(request.resellerId, {
      type: 'DEMO_CONFIRMED',
      title: 'Demo request confirmed',
      body: `${request.businessName}: demo confirmed. The customer is now in My Customers as a trial account, ready to activate.`,
      link: `/demo-requests/${id}`,
    })
    return { ...(await platformView(await loadDetail(id))), linkedAccount }
  },
}
