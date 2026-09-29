import type { ActivationStatus } from './activation-types'

export interface AdminDashboard {
  period: string
  kpis: {
    totalResellers: number
    suspendedResellers: number
    pendingApprovals: number
    activeCustomers: number
    activeSubscriptions: number
    trialAccounts: number
    pendingActivations: { total: number; pendingReview: number; underReview: number; awaitingActivation: number }
    monthlyActivations: number
    commission: {
      currency: string
      pending: string
      payable: string
      awaitingApprovalCount: number
      paid: string
      paidThisMonth: string
    } | null
  }
  activationTrend: { periodMonth: string; count: number }[]
  queue: {
    applications: { id: string; code: string; businessName: string; fullName: string; submittedAt: string }[] | null
    activations:
      | {
          id: string
          reference: string
          status: ActivationStatus
          amount: string
          currency: string
          submittedAt: string
          paymentVerifiedAt: string | null
          product: { name: string }
          reseller: { code: string; businessName: string }
          customerAccount: { customer: { displayName: string } }
        }[]
      | null
  }
  attention: { failedTrials7d: number; integrationErrors: { id: string; name: string }[]; failedActivations: number }
  recentAudit: AuditLogEntry[] | null
  sections: {
    resellers: number
    pendingApplications: number
    products: number
    customers: number
    trials: number
    openActivations: number
    bankSlips: number | null
    unreadNotifications: number
  }
}

export interface AuditLogEntry {
  id: string
  actorType: 'USER' | 'SYSTEM' | 'SAAS'
  actorUserId?: string | null
  actorEmail: string | null
  action: string
  entityType: string
  entityId: string | null
  resellerId?: string | null
  ip?: string | null
  userAgent?: string | null
  metadata?: unknown
  createdAt: string
}

export type ResellerStatus = 'PENDING' | 'ACTIVE' | 'REJECTED' | 'SUSPENDED' | 'TERMINATED'

export interface AdminReseller {
  id: string
  code: string
  businessName: string
  fullName: string
  email: string
  mobile: string
  status: ResellerStatus
  currentLevel: number | null
  levelName: string | null
  activeCustomerCount: number
  approvedAt: string | null
  suspendedAt: string | null
  suspensionReason: string | null
  customers: number
  users: number
  openActivationRequests: number
  unpaidCommission: string
}

/** e.g. RESELLER_APPLICATION_APPROVED → "Reseller application approved" */
export function humanizeAction(action: string) {
  const s = action.toLowerCase().replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}
