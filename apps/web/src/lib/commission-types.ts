export type CommissionStatus = 'PENDING' | 'APPROVED' | 'PAYABLE' | 'PAID' | 'REVERSED'

export interface StatusTotals {
  pending: string
  approved: string
  payable: string
  paid: string
  reversed: string
  net?: string
}

export interface CommissionLevel {
  level: number
  name: string
  minActiveCustomers: number
  maxActiveCustomers: number | null
  ratePercent: string
}

export interface CommissionSummary {
  reseller: { id: string; code: string; businessName: string; status: string; currentLevel: number | null }
  level: {
    level: number | null
    name: string | null
    ratePercent: string
    effectiveRatePercent: string
    activeCustomerCount: number
    nextLevel: { level: number; name: string; ratePercent: string; customersNeeded: number } | null
  }
  levels: CommissionLevel[]
  commissionPerCustomer: { product: string; productCode: string; baseAmount: string; currency: string; amount: string }[]
  totals: StatusTotals
  currentMonth: { periodMonth: string; earnings: string }
  monthlyEarnings: { periodMonth: string; earnings: string }[]
  levelHistory: { id: string; fromLevel: number | null; toLevel: number | null; activeCustomerCount: number; createdAt: string }[]
}

export interface CommissionEntry {
  id: string
  entryType: 'EARNING' | 'CLAWBACK'
  periodMonth: string
  level: number
  baseAmount: string
  rate: string
  amount: string
  currency: string
  status: CommissionStatus
  payableAt: string
  approvedAt: string | null
  paidAt: string | null
  reversedAt: string | null
  reversalReason: string | null
  createdAt: string
  customerAccount: { id: string; status: string; customer: CustomerRef }
  product: { code: string; name: string }
  reseller: { id: string; code: string; businessName: string }
  payout: { id: string; paymentReference: string; paidAt: string } | null
}

export interface CustomerCommissionRow {
  customerAccount: {
    id: string
    status: string
    customer: CustomerRef
    activatedAt: string | null
    product: { name: string }
    reseller: { code: string; businessName: string }
  }
  entries: number
  lastPeriod: string | null
  netEarned: string
  paid: string
  reversed: string
}

export interface Payout {
  id: string
  totalAmount: string
  currency: string
  paymentReference: string
  paidAt: string
  note: string | null
  reseller: { code: string; businessName: string }
  _count: { commissions: number }
}

export interface CustomerRef {
  id: string
  displayName: string
}
