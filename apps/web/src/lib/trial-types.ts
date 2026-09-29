export type TrialStatus = 'PENDING' | 'SUBMITTED' | 'PROVISIONED' | 'FAILED' | 'CANCELLED'

export interface TrialRequest {
  id: string
  status: TrialStatus
  notes: string | null
  attempts: number
  saasReference: string | null
  errorMessage: string | null
  errorRetryable: boolean | null
  submittedAt: string | null
  completedAt: string | null
  createdAt: string
  product: { id: string; code: string; name: string }
  reseller: { id: string; code: string; businessName: string }
  customerAccount: {
    id: string
    status: string
    externalTenantId: string | null
    externalAccountId: string | null
    customer: { id: string; displayName: string }
  }
}

export interface TrialOutcomeResult {
  trial: TrialRequest
  outcome: 'PROVISIONED' | 'SUBMITTED' | 'FAILED' | 'PENDING'
  message: string
  saas?: { status: string; trialEndsAt: string | null } | null
}

export interface TrialOwner {
  businessName: string
  contactName: string
  contactEmail: string
  contactPhone: string
}

export const emptyOwner: TrialOwner = { businessName: '', contactName: '', contactEmail: '', contactPhone: '' }

export const TRIAL_STATUS_LABELS: Record<TrialStatus, string> = {
  PENDING: 'Sending',
  SUBMITTED: 'Processing in SaaS',
  PROVISIONED: 'Trial created',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
}

export function validateOwner(o: TrialOwner): Record<string, string> {
  const errors: Record<string, string> = {}
  if (o.businessName.trim().length < 2) errors['owner.businessName'] = 'Business name is required'
  if (o.contactName.trim().length < 3) errors['owner.contactName'] = 'Contact name is required'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(o.contactEmail.trim())) errors['owner.contactEmail'] = 'Enter a valid email address'
  if (!/^(\+94|0)7\d{8}$/.test(o.contactPhone.replace(/[\s-]/g, ''))) errors['owner.contactPhone'] = 'Enter a valid mobile number, e.g. 0771234567'
  return errors
}
