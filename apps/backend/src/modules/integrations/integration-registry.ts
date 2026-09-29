import type { IntegrationCredentials, SaasIntegration } from './saas-integration'
import { FashionErpIntegration } from './providers/fashion-erp.integration'
import { ManualIntegration } from './providers/manual.integration'
import { MobileShopIntegration } from './providers/mobile-shop.integration'
import { SalonIntegration } from './providers/salon.integration'
import { SupermarketIntegration } from './providers/supermarket.integration'

export interface IntegrationProvider {
  key: string
  label: string
  description: string
  /** Remote providers need a base URL, API key and signing secret. */
  requiresCredentials: boolean
  create(credentials: IntegrationCredentials | null): SaasIntegration
}

/** To add a SaaS: implement `SaasIntegration` (usually by extending PartnerApiIntegration) and register it here. */
const PROVIDERS: IntegrationProvider[] = [
  {
    key: 'MANUAL',
    label: 'Manual fulfilment',
    description: 'No remote API; platform admins act in the SaaS console and record outcomes.',
    requiresCredentials: false,
    create: () => new ManualIntegration(),
  },
  {
    key: 'MOBILE_SHOP',
    label: 'Mobile Shop partner API',
    description: 'Hexalyte Mobile Shop /partner/v1 API.',
    requiresCredentials: true,
    create: (c) => new MobileShopIntegration(c!),
  },
  {
    key: 'SALON',
    label: 'Salon partner API',
    description: 'Hexalyte Salon /partner/v1 API.',
    requiresCredentials: true,
    create: (c) => new SalonIntegration(c!),
  },
  {
    key: 'FASHION_ERP',
    label: 'Clothing ERP partner API',
    description: 'HexaOne Clothing ERP /partner/v1 API.',
    requiresCredentials: true,
    create: (c) => new FashionErpIntegration(c!),
  },
  {
    key: 'SUPERMARKET',
    label: 'Supermarket partner API',
    description: 'Hexalyte Supermarket POS /partner/v1 API.',
    requiresCredentials: true,
    create: (c) => new SupermarketIntegration(c!),
  },
]

const BY_KEY = new Map(PROVIDERS.map((p) => [p.key, p]))

export const integrationRegistry = {
  keys: PROVIDERS.map((p) => p.key) as [string, ...string[]],
  get: (key: string) => BY_KEY.get(key),
  list: () => PROVIDERS.map(({ key, label, description, requiresCredentials }) => ({ key, label, description, requiresCredentials })),
}
