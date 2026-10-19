import type { ActivationStatus } from './activation-types'
import type { CommissionStatus } from './commission-types'
import type { TrialStatus } from './trial-types'

export type AccountStatus = 'PENDING' | 'TRIAL' | 'ACTIVE' | 'SUSPENDED' | 'CANCELLED'

type CustomerRef = { customerAccount: { customer: { id: string; displayName: string } } }
type ProductRef = { product: { code: string; name: string } }

export interface ResellerDashboard {
  reseller: { id: string; code: string; businessName: string }
  products: { id: string; code: string; name: string }[]
  filters: { from: string | null; to: string | null; productId: string | null }
  kpis: {
    level: {
      level: number | null
      name: string | null
      activeCount: number
      nextLevel: { name: string; customersNeeded: number } | null
      ratePercent: string | null
    }
    activeCustomers: number
    totalCustomers: number
    trialCustomers: number
    activeSubscriptions: number
    pendingActivationRequests: number | null
    commission: { currency: string; thisMonth: string; pending: string; paid: string } | null
  }
  period: {
    newCustomers: number
    trialsCreated: number | null
    activationsSubmitted: number | null
    commissionEarned: string | null
    commissionPaid: string | null
  }
  recent: {
    customers: {
      id: string
      displayName: string
      createdAt: string
      accounts: { id: string; status: AccountStatus; activatedAt: string | null; product: { id: string; code: string; name: string } }[]
    }[]
    trials: ({ id: string; status: TrialStatus; errorMessage: string | null; createdAt: string } & ProductRef & CustomerRef)[] | null
    activations:
      | ({
          id: string
          reference: string
          status: ActivationStatus
          periodMonth: string
          amount: string
          currency: string
          submittedAt: string
        } & ProductRef &
          CustomerRef)[]
      | null
    commissions:
      | ({
          id: string
          entryType: 'EARNING' | 'CLAWBACK'
          periodMonth: string
          rate: string
          amount: string
          currency: string
          status: CommissionStatus
          createdAt: string
          paidAt: string | null
        } & ProductRef &
          CustomerRef)[]
      | null
  }
  analytics: {
    customerGrowth: { month: string; count: number }[]
    commissionEarnings: { month: string; earned: string; paid: string }[] | null
  }
}

export const ACCOUNT_STATUS_LABELS: Record<AccountStatus, string> = {
  PENDING: 'Setting up',
  TRIAL: 'Trial',
  ACTIVE: 'Active',
  SUSPENDED: 'Suspended',
  CANCELLED: 'Cancelled',
}

export const COMMISSION_STATUS_LABELS: Record<CommissionStatus, string> = {
  PENDING: 'Pending approval',
  APPROVED: 'Approved (on hold)',
  PAYABLE: 'Payable',
  PAID: 'Paid',
  REVERSED: 'Reversed',
}
