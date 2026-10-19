export type ActivationStatus =
  | 'PENDING_REVIEW'
  | 'UNDER_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'ACTIVATION_COMPLETED'
  | 'CANCELLED'

export const ACTIVATION_STATUS_LABELS: Record<ActivationStatus, string> = {
  PENDING_REVIEW: 'Pending review',
  UNDER_REVIEW: 'Under review',
  APPROVED: 'Approved – activating',
  REJECTED: 'Rejected',
  ACTIVATION_COMPLETED: 'Activated',
  CANCELLED: 'Cancelled',
}

export interface ActivationPipelineCounts {
  total: number
  pendingReview: number
  underReview: number
  completed: number
}

export const ACTION_LABELS: Record<string, string> = {
  SUBMITTED: 'Request submitted',
  REVIEW_STARTED: 'Review started',
  PAYMENT_VERIFIED: 'Payment verified',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled by partner',
  SAAS_PENDING: 'SaaS processing activation',
  SAAS_FAILED: 'SaaS activation failed',
  COMPLETED: 'Subscription activated',
}

export interface ActivationListItem {
  id: string
  reference: string
  status: ActivationStatus
  periodMonth: string
  amount: string
  currency: string
  transactionRef: string
  submittedAt: string
  paymentVerifiedAt: string | null
  activatedAt: string | null
  product: { id: string; code: string; name: string }
  reseller: { id: string; code: string; businessName: string }
  customerAccount: { id: string; externalTenantId: string | null; customer: { id: string; displayName: string } }
}

export interface BankSlipInfo {
  id: string
  originalName: string
  mimeType: string
  sizeBytes: number
  createdAt: string
}

export interface HistoryEntry {
  id: string
  fromStatus: ActivationStatus | null
  toStatus: ActivationStatus
  action: string
  note: string | null
  createdAt: string
  internal?: boolean
  actor?: { name: string; email: string } | null
}

interface ActivationBase {
  id: string
  reference: string
  status: ActivationStatus
  periodMonth: string
  amount: string
  currency: string
  payerName: string
  payerBank: string | null
  transactionRef: string
  transferDate: string
  notes: string | null
  submittedAt: string
  decidedAt: string | null
  rejectionReason: string | null
  activatedAt: string | null
  activationReference: string | null
  reseller: { id: string; code: string; businessName: string }
  bankSlips: BankSlipInfo[]
  history: HistoryEntry[]
}

export interface ResellerActivation extends ActivationBase {
  paymentVerified: boolean
  product: { id: string; code: string; name: string }
  customerAccount: { id: string; status: string; externalTenantId: string | null; customer: { id: string; displayName: string } }
}

type Person = { name: string; email: string } | null

export interface AdminActivation extends ActivationBase {
  reviewStartedAt: string | null
  paymentVerifiedAt: string | null
  paymentVerificationNote: string | null
  activationMethod: 'PARTNER_API' | 'MANUAL' | null
  activationAttempts: number
  saasRequestId: string | null
  activationError: string | null
  activationNote: string | null
  subscriptionEventId: string | null
  product: { id: string; code: string; name: string; monthlyPrice: string; currency: string }
  customerAccount: {
    id: string
    status: string
    externalTenantId: string | null
    externalAccountId: string | null
    activatedAt: string | null
    customer: { id: string; displayName: string }
  }
  amountMatchesPrice: boolean
  activation: { remoteAvailable: boolean; provider: string | null; integrationStatus: string }
  warnings: {
    slipReusedIn: { id: string; reference: string; status: ActivationStatus }[]
    transactionRefUsedIn: { id: string; reference: string; status: ActivationStatus }[]
  }
  people: { requestedBy: Person; reviewer: Person; paymentVerifiedBy: Person; decidedBy: Person; activatedBy: Person }
}

export interface ActivationRunResult {
  outcome: 'ACTIVATED' | 'PENDING' | 'FAILED'
  message: string
  request: AdminActivation
}

export interface PaymentInfo {
  companyBankDetails: string | null
  maxUploadMb: number
}

export const STEPS: ActivationStatus[] = ['PENDING_REVIEW', 'UNDER_REVIEW', 'APPROVED', 'ACTIVATION_COMPLETED']

export function formatBytes(n: number) {
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
}
