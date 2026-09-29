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

export const PRODUCT_STATUS_LABELS: Record<ProductStatus, string> = {
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
  COMING_SOON: 'Coming soon',
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
