import { strictFake } from './hermetic-backend'

/**
 * In-memory stand-in for the Prisma calls behind the reseller application profile and the bank-account reveal
 * (`/admin/reseller-applications/:id`, `…/bank-account/reveal`), plus the user lookup `authenticate` makes.
 * Use with `installHermeticBackend(fake.fakePrisma)`; call `fake.seed(encryptAccountNumber)` once the real
 * `bank-account.util` has been imported (it needs the throwaway ENCRYPTION_KEY the helper sets).
 */

export const ACCOUNT_NUMBER = '9988776655443'
export const OTHER_ACCOUNT_NUMBER = '1111222233334'
export const LAST4 = '5443'

type Row = Record<string, any>
type Encrypt = (accountNumber: string) => { accountNumberEncrypted: string; accountNumberLast4: string }

export function createApplicationsFake() {
  const state = {
    resellers: new Map<string, Row>(),
    users: new Map<string, Row>(),
    audit: [] as Row[],
    /** Ordered trail of what happened, e.g. ['audit', 'decrypt']. */
    events: [] as string[],
    failAudit: undefined as Error | undefined,
  }

  const fakePrisma = strictFake('prisma', {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const user = state.users.get(where.id)
        if (!user) return null
        const reseller = user.resellerId ? state.resellers.get(user.resellerId) : undefined
        return { ...user, reseller: reseller ? { status: reseller.status } : null }
      },
    },
    reseller: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const reseller = state.resellers.get(where.id)
        return reseller ? { ...reseller } : null
      },
    },
    auditLog: {
      create: async ({ data }: { data: Row }) => {
        state.events.push('audit')
        if (state.failAudit) {
          const err = state.failAudit
          state.failAudit = undefined
          throw err
        }
        state.audit.push({ ...data })
        return data
      },
    },
  })

  const reseller = (id: string, over: Row = {}): Row => ({
    id,
    code: `CODE-${id}`,
    status: 'ACTIVE',
    submittedAt: new Date('2025-01-01T00:00:00Z'),
    fullName: 'Nimal Perera',
    nicOrPassport: '901234567V',
    email: 'nimal@acme.invalid',
    mobile: '+94771234567',
    address: '12 Galle Road, Colombo',
    businessName: `Business ${id}`,
    businessRegistrationNo: 'PV 12345',
    businessAddress: '34 Main Street, Colombo',
    businessPhone: '+94112345678',
    businessEmail: 'biz@acme.invalid',
    reviewedAt: null,
    reviewedById: null,
    approvedAt: new Date('2025-01-02T00:00:00Z'),
    rejectionReason: null,
    reviewNote: null,
    currentLevel: 1,
    activeCustomerCount: 2,
    suspendedAt: null,
    suspensionReason: null,
    bankAccount: null,
    ...over,
  })

  function seed(encrypt: Encrypt) {
    const bank = (id: string, resellerId: string, accountNumber: string): Row => ({
      id,
      resellerId,
      bankName: 'Test Bank',
      branch: 'Colombo',
      accountHolderName: 'Nimal Perera',
      ...encrypt(accountNumber),
    })
    state.resellers.clear()
    state.users.clear()
    state.audit.length = 0
    state.events.length = 0
    state.failAudit = undefined
    state.resellers.set('rs-1', reseller('rs-1', { bankAccount: bank('ba-1', 'rs-1', ACCOUNT_NUMBER) }))
    state.resellers.set('rs-2', reseller('rs-2', { bankAccount: bank('ba-2', 'rs-2', OTHER_ACCOUNT_NUMBER) }))
    state.resellers.set('rs-nobank', reseller('rs-nobank'))
    const user = (id: string, role: 'ADMIN' | 'SELLER', resellerId: string | null) =>
      state.users.set(id, { id, email: `${id}@test.invalid`, role, status: 'ACTIVE', emailVerified: role === 'ADMIN' ? null : new Date(), resellerId })
    user('u-admin', 'ADMIN', null)
    user('u-seller-1', 'SELLER', 'rs-1')
    user('u-seller-2', 'SELLER', 'rs-2')
  }

  return { state, fakePrisma, seed }
}
