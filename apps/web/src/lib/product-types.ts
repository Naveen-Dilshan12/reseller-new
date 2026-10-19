export type ProductStatus = 'ACTIVE' | 'INACTIVE' | 'COMING_SOON'
export type IntegrationStatus = 'NOT_CONFIGURED' | 'CONFIGURED' | 'CONNECTED' | 'ERROR' | 'DISABLED'
export type AccessStatus = 'ACTIVE' | 'SUSPENDED' | 'REVOKED'

export interface Product {
  id: string
  code: string
  name: string
  description: string | null
  status: ProductStatus
  monthlyPrice: string
  currency: string
  trialAvailable: boolean
  trialDays: number | null
  integrationStatus?: IntegrationStatus
}

/** Catalogue entry as returned to reseller users. */
export interface ResellerProduct extends Product {
  canCreateTrial: boolean
  reason: string | null
}

export interface AdminProduct extends Product {
  integrationStatus: IntegrationStatus
  createdAt: string
  updatedAt: string
  _count: { resellerAccess: number; accounts: number }
}

export interface ProductListItem extends AdminProduct {
  integration: { provider: string; lastCheckedAt: string | null; lastCheckOk: boolean | null } | null
}

/** What the API returns about a connection: secrets only as present/absent. */
export interface SafeIntegrationConfig {
  provider: string
  providerLabel: string
  requiresCredentials: boolean
  baseUrl: string | null
  hasApiKey: boolean
  hasSigningSecret: boolean
  lastCheckedAt: string | null
  lastCheckOk: boolean | null
  lastError: string | null
  updatedAt: string
}

export interface ProductDetail extends AdminProduct {
  integration: SafeIntegrationConfig | null
}

export interface IntegrationProviderInfo {
  key: string
  label: string
  description: string
  requiresCredentials: boolean
}

/** What a lifecycle change (retire, restore, set coming soon, launch) touches (GET /admin/saas-products/:id/impact). Counts only. */
export interface ProductImpact {
  productId: string
  status: ProductStatus
  customerAccounts: { active: number; trial: number; pending: number }
  openActivationRequests: number
  openDemoRequests: { total: number; awaitingConfirmation: number }
  unpaidCommissions: { count: number; totals: { currency: string; amount: string }[] }
  resellers: { withAccess: number; approvedWithoutAccess: number }
}

/** An approved reseller with no access record for a product (GET /admin/saas-products/:id/resellers-without-access). */
export interface ResellerWithoutAccess {
  id: string
  code: string
  businessName: string
  approvedAt: string | null
}

/** The only ways a product's status changes; each is POST /admin/saas-products/:id/<action>. */
export type LifecycleAction = 'retire' | 'restore' | 'coming-soon' | 'launch'

/** Button label and confirm label of each lifecycle action. */
export const LIFECYCLE_LABELS: Record<LifecycleAction, string> = {
  retire: 'Retire product',
  restore: 'Restore product',
  'coming-soon': 'Set coming soon',
  launch: 'Launch product',
}

/** What the server accepts from each status (see productLifecycleService): the page offers exactly these. */
export const LIFECYCLE_ACTIONS: Record<ProductStatus, readonly LifecycleAction[]> = {
  ACTIVE: ['retire', 'coming-soon'],
  COMING_SOON: ['launch', 'retire'],
  INACTIVE: ['restore', 'coming-soon'],
}

export const PRODUCT_STATUS_LABELS: Record<ProductStatus, string> = {
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
  COMING_SOON: 'Coming soon',
}

/** Only an Active product can be sold (trials, demos and paid activations all check it); existing subscriptions are unaffected. */
export const PRODUCT_STATUS_DESCRIPTIONS: Record<ProductStatus, string> = {
  ACTIVE: 'On sale: partners with active access can sell it.',
  COMING_SOON: 'Not launched yet: partners cannot sell it until it is launched. Existing paid subscriptions and commissions continue.',
  INACTIVE: 'Off sale: partners cannot sell it. Existing paid subscriptions and commissions continue.',
}

export const INTEGRATION_STATUS_LABELS: Record<IntegrationStatus, string> = {
  NOT_CONFIGURED: 'Not configured',
  CONFIGURED: 'Configured',
  CONNECTED: 'Connected',
  ERROR: 'Error',
  DISABLED: 'Disabled',
}

export function trialLabel(p: Pick<Product, 'trialAvailable' | 'trialDays'>): string {
  if (!p.trialAvailable) return 'No trial'
  return p.trialDays ? `${p.trialDays}-day trial` : 'Trial available'
}
