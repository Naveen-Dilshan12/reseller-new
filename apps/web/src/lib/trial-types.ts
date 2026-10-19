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
  product: {
    id: string
    code: string
    name: string
    integration?: {
      provider: string
      baseUrl?: string | null
    } | null
  }
  reseller: { id: string; code: string; businessName: string }
  customerAccount: {
    id: string
    status: string
    externalTenantId: string | null
    externalAccountId: string | null
    customer: { id: string; displayName: string; customerCode?: string | null }
  }
}

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

export interface TrialOutcomeResult {
  trial: TrialRequest
  outcome: 'PROVISIONED' | 'SUBMITTED' | 'FAILED' | 'PENDING'
  message: string
  saas?: { status: string; trialEndsAt: string | null } | null
  provisioning?: ProvisioningDetails | null
}

export interface ShopDetails {
  shopName: string
  ownerName: string
  email: string
  phone: string
  password?: string
}

export const emptyShopDetails: ShopDetails = {
  shopName: '',
  ownerName: '',
  email: '',
  phone: '',
  password: '',
}

export interface TrialOwner {
  businessName: string
  contactName: string
  contactEmail: string
  contactPhone: string
  password?: string
}

export const emptyOwner: TrialOwner = { businessName: '', contactName: '', contactEmail: '', contactPhone: '' }

export function validateShopDetails(d: ShopDetails): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!d.shopName || d.shopName.trim().length < 2) {
    errors.shopName = 'Shop Name is required (at least 2 characters)'
  }
  if (!d.ownerName || d.ownerName.trim().length < 2) {
    errors.ownerName = 'Owner Name is required (at least 2 characters)'
  }
  if (!d.email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email.trim())) {
    errors.email = 'Valid Email is required'
  }
  const cleanPhone = (d.phone || '').replace(/[\s-]/g, '')
  if (!cleanPhone || !/^(\+94|0)?7\d{8}$/.test(cleanPhone)) {
    errors.phone = 'Valid Phone number is required (e.g. 0771234567 or +94771234567)'
  }
  if (d.password && d.password.trim().length > 0 && d.password.trim().length < 6) {
    errors.password = 'Password must be at least 6 characters if provided'
  }
  return errors
}

export const TRIAL_STATUS_LABELS: Record<TrialStatus, string> = {
  PENDING: 'Sending',
  SUBMITTED: 'Processing in SaaS',
  PROVISIONED: 'Active Trial',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
}

export function isManualProduct(product: TrialRequest['product']): boolean {
  return product.integration?.provider === 'MANUAL'
}

export interface TrialDisplayStatus {
  label: string
  badgeClass: string
  isConverted: boolean
  isTenantUnverified: boolean
  isManualFulfilment: boolean
}

export function getTrialDisplayStatus(t: TrialRequest): TrialDisplayStatus {
  const isPaid = t.customerAccount.status === 'ACTIVE'
  const isManual = isManualProduct(t.product)
  const hasTenant = Boolean(t.customerAccount.externalTenantId)

  if (isPaid) {
    if (hasTenant) {
      return {
        label: 'Converted to Paid',
        badgeClass: 'badge sub-ACTIVE',
        isConverted: true,
        isTenantUnverified: false,
        isManualFulfilment: false,
      }
    }
    return {
      label: 'Paid (Tenant Unverified)',
      badgeClass: 'badge act-UNDER_REVIEW',
      isConverted: true,
      isTenantUnverified: true,
      isManualFulfilment: false,
    }
  }

  if (t.status === 'PROVISIONED') {
    if (hasTenant) {
      return {
        label: 'Active Trial',
        badgeClass: 'badge trial-PROVISIONED',
        isConverted: false,
        isTenantUnverified: false,
        isManualFulfilment: false,
      }
    }
    return {
      label: 'Awaiting Provisioning',
      badgeClass: 'badge trial-PENDING',
      isConverted: false,
      isTenantUnverified: true,
      isManualFulfilment: false,
    }
  }

  if (t.status === 'SUBMITTED' || t.status === 'PENDING') {
    if (isManual) {
      return {
        label: 'Awaiting Manual Provisioning',
        badgeClass: 'badge trial-PENDING',
        isConverted: false,
        isTenantUnverified: false,
        isManualFulfilment: true,
      }
    }
    return {
      label: 'Processing in SaaS',
      badgeClass: 'badge trial-SUBMITTED',
      isConverted: false,
      isTenantUnverified: false,
      isManualFulfilment: false,
    }
  }

  if (t.status === 'FAILED') {
    return {
      label: 'Failed',
      badgeClass: 'badge trial-FAILED',
      isConverted: false,
      isTenantUnverified: false,
      isManualFulfilment: false,
    }
  }

  return {
    label: TRIAL_STATUS_LABELS[t.status] ?? t.status,
    badgeClass: `badge trial-${t.status}`,
    isConverted: false,
    isTenantUnverified: false,
    isManualFulfilment: false,
  }
}

export function validateOwner(o: TrialOwner): Record<string, string> {
  const errors: Record<string, string> = {}
  if (o.businessName.trim().length < 2) errors['owner.businessName'] = 'Business name is required'
  if (o.contactName.trim().length < 3) errors['owner.contactName'] = 'Contact name is required'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(o.contactEmail.trim())) errors['owner.contactEmail'] = 'Enter a valid email address'
  if (!/^(\+94|0)7\d{8}$/.test(o.contactPhone.replace(/[\s-]/g, ''))) errors['owner.contactPhone'] = 'Enter a valid mobile number, e.g. 0771234567'
  return errors
}
