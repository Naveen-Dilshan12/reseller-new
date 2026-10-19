import { Prisma } from '@prisma/client'
import { conflict } from '../../middleware/error.middleware'

/** Shared by the trial flow and demo confirmation so a customer is matched / created the same way everywhere. */

export async function generateCustomerCode(tx: Prisma.TransactionClient): Promise<string> {
  try {
    const res = await tx.$queryRaw<{ code: string }[]>`
      SELECT ('CUS-' || LPAD(nextval('customer_code_seq')::text, 6, '0')) as code
    `
    if (res?.[0]?.code) return res[0].code
  } catch {
    // fallback when sequence is not present in mock/in-memory test environment
  }
  for (let i = 0; i < 5; i++) {
    const num = Math.floor(100000 + Math.random() * 900000)
    const candidate = `CUS-${num}`
    const existing = await tx.customer.findFirst({ where: { customerCode: candidate } })
    if (!existing) return candidate
  }
  return `CUS-${Date.now().toString().slice(-6)}`
}

/**
 * Returns the id of this reseller's customer for a business name, creating it when there is none.
 * Names are matched case-insensitively, then ignoring punctuation and spacing, so "Kandy Mobiles"
 * and "kandy-mobiles" are the same customer and no duplicate is created.
 */
export async function findOrCreateCustomer(tx: Prisma.TransactionClient, resellerId: string, businessName: string): Promise<string> {
  const normalizedShopName = businessName.trim()
  const cleanName = normalizedShopName.toLowerCase().replace(/[^a-z0-9]/g, '')

  // Matching is read-then-create, so serialize concurrent callers for the same reseller + name
  // (lock is released when the surrounding transaction ends); otherwise both could create a customer.
  try {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${resellerId}:${cleanName}`}))`
  } catch {
    // not available in mock/in-memory test environments
  }

  // 1. Find existing customer record belonging to this reseller using reliable normalized identity matching
  const existingCandidates = await tx.customer.findMany({
    where: {
      resellerId,
      OR: [{ displayName: { equals: normalizedShopName, mode: 'insensitive' } }],
    },
    select: { id: true, displayName: true },
  })

  let matchedCustomer = existingCandidates.find((c) => c.displayName.trim().toLowerCase() === normalizedShopName.toLowerCase())

  if (!matchedCustomer && cleanName) {
    const allResellerCustomers = await tx.customer.findMany({
      where: { resellerId },
      select: { id: true, displayName: true },
    })
    matchedCustomer = allResellerCustomers.find((c) => c.displayName.toLowerCase().replace(/[^a-z0-9]/g, '') === cleanName)
  }

  // 2. Reuse the existing customer record if there is one
  if (matchedCustomer) return matchedCustomer.id

  // Otherwise create a new customer record with a unique Customer ID
  const customerCode = await generateCustomerCode(tx)
  const created = await tx.customer.create({ data: { resellerId, displayName: normalizedShopName, customerCode } })
  return created.id
}

/** What `linkTrialAccount` did: created a new account, attached the tenant to an existing one, or changed nothing. */
export type LinkOutcome = 'CREATED' | 'ATTACHED' | 'UNCHANGED'

/**
 * Links a tenant that already exists in the SaaS (e.g. a demo shop an admin created by hand) to a
 * customer as a TRIAL account, so the Paid Activation flow can pick it up. Never creates a second
 * account for the same customer + product, and never lets one tenant sit on two accounts.
 *
 * - no account yet                      → creates a TRIAL account
 * - account without a tenant            → attaches the tenant and makes it TRIAL
 * - account already on the same tenant  → no change (idempotent)
 * - ACTIVE account, or a different tenant on the account, or tenant used elsewhere → 409
 */
export async function linkTrialAccount(
  tx: Prisma.TransactionClient,
  input: {
    resellerId: string
    customerId: string
    productId: string
    productName: string
    externalTenantId: string
    /** Owner / admin user ID inside the SaaS; stored when the account is created or the tenant is attached. */
    externalAccountId?: string
  },
): Promise<{ accountId: string; created: boolean; outcome: LinkOutcome }> {
  const { resellerId, customerId, productId, productName, externalTenantId, externalAccountId } = input
  try {
    const existing = await tx.customerAccount.findUnique({
      where: { customerId_productId: { customerId, productId } },
      select: { id: true, status: true, externalTenantId: true },
    })
    if (existing) {
      if (existing.status === 'ACTIVE') throw conflict(`This customer already has an active paid subscription for ${productName}`)
      if (existing.externalTenantId) {
        if (existing.externalTenantId === externalTenantId) return { accountId: existing.id, created: false, outcome: 'UNCHANGED' }
        throw conflict(`This customer already has a different SaaS tenant linked for ${productName}`)
      }
      await tx.customerAccount.update({
        where: { id: existing.id },
        data: { externalTenantId, status: 'TRIAL', deactivatedAt: null, ...(externalAccountId ? { externalAccountId } : {}) },
      })
      return { accountId: existing.id, created: false, outcome: 'ATTACHED' }
    }
    const created = await tx.customerAccount.create({
      data: { resellerId, customerId, productId, externalTenantId, status: 'TRIAL', ...(externalAccountId ? { externalAccountId } : {}) },
      select: { id: true },
    })
    return { accountId: created.id, created: true, outcome: 'CREATED' }
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw conflict('This SaaS tenant is already linked to another customer account')
    }
    throw err
  }
}
