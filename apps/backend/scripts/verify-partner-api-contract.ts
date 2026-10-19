import http from 'http'
import { FashionErpIntegration } from '../src/modules/integrations/providers/fashion-erp.integration'
import { MobileShopIntegration } from '../src/modules/integrations/providers/mobile-shop.integration'
import { SalonIntegration } from '../src/modules/integrations/providers/salon.integration'
import { signRequest } from '../src/modules/integrations/signing'
import { safeEqual } from '../src/utils/crypto'
import { IntegrationError } from '../src/modules/integrations/integration-error'

const PORT = 4199
const BASE_URL = `http://127.0.0.1:${PORT}`
const API_KEY = 'test_partner_api_key_xyz'
const SIGNING_SECRET = 'test_signing_secret_sec_abc123456789'

interface ReceivedCall {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: any
  signatureValid: boolean
}

async function run() {
  console.log('======================================================================')
  console.log('PARTNER_API INTEGRATION VERIFICATION: API CALLS, MAPPINGS & FAILURES')
  console.log('======================================================================\n')

  let serverMode: 'SUCCESS' | 'ASYNC_202' | 'FAIL_503' | 'FAIL_409' | 'FAIL_401' | 'TIMEOUT' = 'SUCCESS'
  const calls: ReceivedCall[] = []

  // Create mock partner SaaS server
  const server = http.createServer(async (req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      let body: any = null
      try {
        body = raw ? JSON.parse(raw) : null
      } catch {}

      const timestamp = (req.headers['x-hexalyte-timestamp'] as string) || ''
      const signature = (req.headers['x-hexalyte-signature'] as string) || ''
      const path = req.url || ''
      const expectedSig = signRequest(SIGNING_SECRET, req.method || 'GET', path, raw, timestamp)
      const sigValid = safeEqual(expectedSig, signature)

      calls.push({
        method: req.method || '',
        url: path,
        headers: req.headers,
        body,
        signatureValid: sigValid,
      })

      if (serverMode === 'TIMEOUT') {
        // do not respond
        return
      }

      if (serverMode === 'FAIL_401') {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized: Invalid API key' }))
        return
      }

      if (serverMode === 'FAIL_409') {
        res.writeHead(409, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ message: 'A tenant with this business email already exists' }))
        return
      }

      if (serverMode === 'FAIL_503') {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Service Unavailable: Database maintenance' }))
        return
      }

      if (serverMode === 'ASYNC_202') {
        res.writeHead(202, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ reference: 'SAAS-REF-ASYNC-001', status: 'PENDING' }))
        return
      }

      // SUCCESS mode
      if (req.url === '/partner/v1/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, version: '1.0.0' }))
        return
      }

      if (req.url === '/partner/v1/tenants' && req.method === 'POST') {
        res.writeHead(201, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            tenantId: 'tenant_real_partner_8899',
            accountId: 'acc_usr_9988',
            status: 'TRIAL',
            plan: 'trial',
            trialEndsAt: '2026-10-26T18:00:00.000Z',
          }),
        )
        return
      }

      if (req.url?.includes('/subscription-activations') && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            status: 'ACTIVATED',
            subscriptionReference: 'SUB-CONFIRMED-4455',
            periodMonth: '2026-10',
          }),
        )
        return
      }

      if (req.url?.startsWith('/partner/v1/tenants/by-reference/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            tenantId: 'tenant_real_partner_8899',
            status: 'TRIAL',
            plan: 'trial',
          }),
        )
        return
      }

      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not Found' }))
    })
  })

  await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', () => resolve()))
  console.log(`✓ Started Mock Partner SaaS Server on ${BASE_URL}\n`)

  const credentials = { baseUrl: BASE_URL, apiKey: API_KEY, signingSecret: SIGNING_SECRET }

  // 1. Fashion ERP Integration Verification
  console.log('--- 1. Testing FashionErpIntegration (Clothing ERP) ---')
  const fashion = new FashionErpIntegration(credentials)

  // Health Check
  const health = await fashion.healthCheck()
  console.log(`   Health check result: ok = ${health.ok}`)
  const lastHealthCall = calls[calls.length - 1]
  console.log(`   Health check HMAC signature valid: ${lastHealthCall.signatureValid}`)
  console.log(`   Authorization header: ${lastHealthCall.headers['authorization']}`)

  // Trial Provisioning (POST /partner/v1/tenants)
  const trialInput = {
    idempotencyKey: 'idemp-fashion-test-01',
    externalRef: 'acc-cust-001',
    resellerCode: 'RS-HEXA',
    businessName: 'Lanka Silks & Apparels',
    contactName: 'Nimali Jayawardena',
    contactEmail: 'nimali@lankasilks.test',
    contactPhone: '+94712345678',
  }
  const fashionTrial = await fashion.createTrial(trialInput)
  console.log(`   createTrial outcome: ${fashionTrial.outcome}`)
  console.log(`   externalTenantId received: ${(fashionTrial as any).externalTenantId}`)
  console.log(`   status: ${(fashionTrial as any).status}`)
  console.log(`   trialEndsAt: ${(fashionTrial as any).trialEndsAt}`)

  const lastTrialCall = calls[calls.length - 1]
  console.log(`   Trial call HMAC signature valid: ${lastTrialCall.signatureValid}`)
  console.log(`   Trial payload mapped fields:`, JSON.stringify(lastTrialCall.body, null, 2))
  if (lastTrialCall.body.adminFirstName !== 'Nimali' || lastTrialCall.body.companyName !== 'Lanka Silks & Apparels') {
    throw new Error('FashionErpIntegration payload mapping failed')
  }

  // Paid Activation Conversion (POST /partner/v1/tenants/:id/subscription-activations)
  const activationInput = {
    idempotencyKey: 'idemp-act-fashion-01',
    externalRef: 'AR-ACT-999',
    externalTenantId: (fashionTrial as any).externalTenantId,
    periodMonth: '2026-10',
    amount: '5500.00',
    currency: 'LKR',
    paymentMethod: 'BANK_TRANSFER' as const,
    paymentReference: 'SLIP-REF-100200',
    paymentDate: '2026-10-12',
    verifiedBy: 'admin@hexalyte.com',
  }
  const fashionActivation = await fashion.activateSubscription(activationInput)
  console.log(`   activateSubscription status: ${fashionActivation.status}`)
  console.log(`   subscriptionReference: ${fashionActivation.subscriptionReference}`)
  const lastActCall = calls[calls.length - 1]
  console.log(`   Activation call URL: ${lastActCall.url}`)
  console.log(`   Activation HMAC signature valid: ${lastActCall.signatureValid}`)
  if (!lastActCall.url.includes('tenant_real_partner_8899')) {
    throw new Error('Activation was not directed to existing trial tenant ID!')
  }

  // 2. Mobile Shop Integration Verification
  console.log('\n--- 2. Testing MobileShopIntegration ---')
  const mobile = new MobileShopIntegration(credentials)
  const mobileTrial = await mobile.createTrial({
    idempotencyKey: 'idemp-mobile-test-01',
    externalRef: 'acc-cust-002',
    resellerCode: 'RS-HEXA',
    businessName: 'City Mobile Hub',
    contactName: 'Roshan Silva',
    contactEmail: 'roshan@citymobile.test',
    contactPhone: '+94779876543',
  })
  console.log(`   createTrial outcome: ${mobileTrial.outcome}`)
  console.log(`   externalTenantId received: ${(mobileTrial as any).externalTenantId}`)
  const lastMobileCall = calls[calls.length - 1]
  console.log(`   Mobile payload mapped: shopName="${lastMobileCall.body.shopName}", ownerName="${lastMobileCall.body.ownerName}"`)

  // 3. Salon Integration Verification
  console.log('\n--- 3. Testing SalonIntegration (Snake Case & Plan Mapping) ---')
  const salon = new SalonIntegration(credentials)
  const salonTrial = await salon.createTrial({
    idempotencyKey: 'idemp-salon-test-01',
    externalRef: 'acc-cust-003',
    resellerCode: 'RS-HEXA',
    businessName: 'Glow Beauty Salon',
    contactName: 'Kumari Perera',
    contactEmail: 'kumari@glow.test',
    contactPhone: '+94761122334',
  })
  console.log(`   createTrial outcome: ${salonTrial.outcome}`)
  const lastSalonCall = calls[calls.length - 1]
  console.log(`   Salon payload mapped snake_case: name="${lastSalonCall.body.name}", plan="${lastSalonCall.body.plan}"`)

  // 4. Asynchronous 202 Accepted Response Handling
  console.log('\n--- 4. Testing Asynchronous Provisioning (HTTP 202 Accepted) ---')
  serverMode = 'ASYNC_202'
  const asyncTrial = await fashion.createTrial(trialInput)
  console.log(`   createTrial outcome on 202: ${asyncTrial.outcome}`)
  console.log(`   reference: ${asyncTrial.reference}`)
  if (asyncTrial.outcome !== 'PENDING') throw new Error('HTTP 202 must return PENDING outcome')

  // 5. Failure Handling: 503 Maintenance (Retryable)
  console.log('\n--- 5. Testing Failure Handling: HTTP 503 Outage ---')
  serverMode = 'FAIL_503'
  try {
    await fashion.createTrial(trialInput)
    throw new Error('Should have thrown')
  } catch (err: any) {
    console.log(`   Caught error: "${err.message}", HTTP status: ${err.httpStatus}`)
    if (err.httpStatus !== 503) throw new Error('Expected HTTP 503 status')
  }

  // 6. Failure Handling: 409 Conflict (Non-Retryable Domain Error)
  console.log('\n--- 6. Testing Failure Handling: HTTP 409 Conflict ---')
  serverMode = 'FAIL_409'
  try {
    await fashion.createTrial(trialInput)
    throw new Error('Should have thrown')
  } catch (err: any) {
    console.log(`   Caught error: "${err.message}", HTTP status: ${err.httpStatus}`)
    if (err.httpStatus !== 409) throw new Error('Expected HTTP 409 status')
  }

  // 7. Failure Handling: 401 Unauthorized (Credentials Configuration Error)
  console.log('\n--- 7. Testing Failure Handling: HTTP 401 Unauthorized ---')
  serverMode = 'FAIL_401'
  try {
    await fashion.createTrial(trialInput)
    throw new Error('Should have thrown')
  } catch (err: any) {
    console.log(`   Caught error: "${err.message}", HTTP status: ${err.httpStatus}`)
    if (err.httpStatus !== 401) throw new Error('Expected HTTP 401 status')
  }

  server.close()
  console.log('\n======================================================================')
  console.log('ALL PARTNER_API INTEGRATION CONTRACT CHECKS VERIFIED SUCCESSFULLY!')
  console.log('======================================================================')
}

run()
  .catch((e) => {
    console.error('VERIFICATION ERROR:', e)
    process.exit(1)
  })
