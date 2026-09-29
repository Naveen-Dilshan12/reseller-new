import { Request, Response, NextFunction } from 'express'
import { PERMISSIONS } from '../rbac/permissions'
import { signAccessToken, verifyAccessToken } from '../utils/jwt'

export const DEMO_ADMIN = {
  id: 'demo-admin-id',
  email: 'admin@hexalyte.com',
  name: 'Hexalyte Super Admin',
  role: 'SUPER_ADMIN' as const,
  resellerId: null,
  reseller: null,
  permissions: [...PERMISSIONS],
}

export const DEMO_RESELLER = {
  id: 'demo-reseller-user-id',
  email: 'reseller@hexalyte.com',
  name: 'Kasun Perera',
  role: 'RESELLER_ADMIN' as const,
  resellerId: 'demo-reseller-id',
  reseller: {
    id: 'demo-reseller-id',
    code: 'RS-7K2F9Q',
    businessName: 'Apex Mobile & IT Solutions',
    status: 'ACTIVE',
  },
  permissions: [
    'products:read',
    'accounts:read',
    'accounts:sync',
    'trials:read',
    'trials:create',
    'activations:read',
    'activations:create',
    'bankslips:read',
    'bankslips:upload',
    'reseller-users:manage',
    'commissions:read',
  ],
}

// In-Memory Data Store for Full End-to-End Interactivity
let DEMO_PRODUCTS = [
  {
    id: 'p-1',
    code: 'MOBILE_SHOP',
    name: 'Hexalyte Mobile Shop',
    description: 'Comprehensive Mobile phone shop POS, IMEI tracking, repairing management & inventory SaaS.',
    status: 'ACTIVE',
    monthlyPrice: '5500.00',
    currency: 'LKR',
    trialAvailable: true,
    trialDays: 14,
    canCreateTrial: true,
    reason: null,
    integrationStatus: 'CONNECTED',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    _count: { resellerAccess: 12, accounts: 34 },
    integration: { provider: 'MOBILE_SHOP', lastCheckedAt: '2026-09-29T08:00:00.000Z', lastCheckOk: true },
  },
  {
    id: 'p-2',
    code: 'FASHION_ERP',
    name: 'HexaOne Clothing ERP',
    description: 'Cloud clothing retail & wholesale ERP with barcoding, sizes, matrix inventory & multi-branch.',
    status: 'ACTIVE',
    monthlyPrice: '8500.00',
    currency: 'LKR',
    trialAvailable: true,
    trialDays: 14,
    canCreateTrial: true,
    reason: null,
    integrationStatus: 'CONNECTED',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    _count: { resellerAccess: 8, accounts: 19 },
    integration: { provider: 'FASHION_ERP', lastCheckedAt: '2026-09-29T08:00:00.000Z', lastCheckOk: true },
  },
  {
    id: 'p-3',
    code: 'SALON',
    name: 'Hexalyte Salon',
    description: 'Beauty salon & spa management system with appointment booking, staff commission & billing.',
    status: 'ACTIVE',
    monthlyPrice: '4500.00',
    currency: 'LKR',
    trialAvailable: true,
    trialDays: 7,
    canCreateTrial: true,
    reason: null,
    integrationStatus: 'CONNECTED',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    _count: { resellerAccess: 15, accounts: 27 },
    integration: { provider: 'SALON', lastCheckedAt: '2026-09-29T08:00:00.000Z', lastCheckOk: true },
  },
  {
    id: 'p-4',
    code: 'SUPERMARKET',
    name: 'Hexalyte Supermarket POS',
    description: 'High-speed supermarket POS & inventory management with scale integration & loyalty points.',
    status: 'ACTIVE',
    monthlyPrice: '6500.00',
    currency: 'LKR',
    trialAvailable: false,
    trialDays: null,
    canCreateTrial: false,
    reason: 'Contact Hexalyte sales for supermarket deployment',
    integrationStatus: 'CONFIGURED',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    _count: { resellerAccess: 5, accounts: 8 },
    integration: { provider: 'SUPERMARKET', lastCheckedAt: '2026-09-29T08:00:00.000Z', lastCheckOk: true },
  },
]

let DEMO_CUSTOMERS = [
  {
    id: 'c-1',
    displayName: 'City Mobile Kandy',
    createdAt: '2026-09-10T09:30:00.000Z',
    accounts: [
      {
        id: 'acc-1',
        status: 'ACTIVE' as const,
        externalTenantId: 'TENANT-MS-9812',
        product: { id: 'p-1', code: 'MOBILE_SHOP', name: 'Hexalyte Mobile Shop', monthlyPrice: '5500.00', currency: 'LKR' },
      },
    ],
  },
  {
    id: 'c-2',
    displayName: 'Glamour Salon & Spa Colombo',
    createdAt: '2026-09-15T14:20:00.000Z',
    accounts: [
      {
        id: 'acc-2',
        status: 'ACTIVE' as const,
        externalTenantId: 'TENANT-SALON-4410',
        product: { id: 'p-3', code: 'SALON', name: 'Hexalyte Salon', monthlyPrice: '4500.00', currency: 'LKR' },
      },
    ],
  },
  {
    id: 'c-3',
    displayName: 'Vogue Fashion Store',
    createdAt: '2026-09-22T11:00:00.000Z',
    accounts: [
      {
        id: 'acc-3',
        status: 'TRIAL' as const,
        externalTenantId: 'TENANT-ERP-1102',
        product: { id: 'p-2', code: 'FASHION_ERP', name: 'HexaOne Clothing ERP', monthlyPrice: '8500.00', currency: 'LKR' },
      },
    ],
  },
]

let DEMO_APPLICATIONS = [
  {
    id: 'app-1',
    code: 'RS-9X82',
    fullName: 'Sunil Shantha',
    email: 'sunil@lankatech.lk',
    mobile: '+94771234567',
    businessName: 'Lanka Tech Solutions',
    businessRegistrationNo: 'PV98124',
    status: 'PENDING',
    submittedAt: '2026-09-28T09:00:00.000Z',
    reviewedAt: null,
    personal: { fullName: 'Sunil Shantha', nicOrPassport: '198512345678', email: 'sunil@lankatech.lk', mobile: '+94771234567', address: '12 Main St, Kandy' },
    business: { businessName: 'Lanka Tech Solutions', businessRegistrationNo: 'PV98124', businessAddress: '12 Main St, Kandy', businessPhone: '0812234567', businessEmail: 'info@lankatech.lk' },
    bank: { bankName: 'Commercial Bank of Ceylon', branch: 'Kandy City', accountHolderName: 'Lanka Tech Solutions (Pvt) Ltd', accountNumberMasked: '••••••••8819' },
    review: { reviewedAt: null, reviewedBy: null, approvedAt: null, rejectionReason: null, reviewNote: null },
    level: { currentLevel: null, activeCustomerCount: 0 },
    suspension: null,
  },
  {
    id: 'app-2',
    code: 'RS-10M4',
    fullName: 'Dhammika Perera',
    email: 'dhammika@galleithub.lk',
    mobile: '+94719876543',
    businessName: 'Galle IT Hub',
    businessRegistrationNo: 'PV54120',
    status: 'PENDING',
    submittedAt: '2026-09-28T14:30:00.000Z',
    reviewedAt: null,
    personal: { fullName: 'Dhammika Perera', nicOrPassport: '199045612345', email: 'dhammika@galleithub.lk', mobile: '+94719876543', address: '45 Galle Rd, Galle' },
    business: { businessName: 'Galle IT Hub', businessRegistrationNo: 'PV54120', businessAddress: '45 Galle Rd, Galle', businessPhone: '0912234567', businessEmail: 'contact@galleithub.lk' },
    bank: { bankName: 'Hatton National Bank', branch: 'Galle Fort', accountHolderName: 'Galle IT Hub', accountNumberMasked: '••••••••4401' },
    review: { reviewedAt: null, reviewedBy: null, approvedAt: null, rejectionReason: null, reviewNote: null },
    level: { currentLevel: null, activeCustomerCount: 0 },
    suspension: null,
  },
]

let DEMO_RESELLERS = [
  {
    id: 'demo-reseller-id',
    code: 'RS-7K2F9Q',
    businessName: 'Apex Mobile & IT Solutions',
    fullName: 'Kasun Perera',
    email: 'reseller@hexalyte.com',
    mobile: '+94771234567',
    status: 'ACTIVE',
    currentLevel: 2,
    levelName: 'Level 2',
    activeCustomerCount: 8,
    customers: 12,
    users: 1,
    openActivationRequests: 1,
    unpaidCommission: '11500.00',
    approvedAt: '2026-09-02T10:00:00.000Z',
  },
]

let DEMO_TRIALS = [
  {
    id: 'tr-1',
    status: 'PROVISIONED',
    errorMessage: null,
    createdAt: '2026-09-25T10:00:00.000Z',
    product: { id: 'p-1', code: 'MOBILE_SHOP', name: 'Hexalyte Mobile Shop' },
    reseller: { id: 'demo-reseller-id', code: 'RS-7K2F9Q', businessName: 'Apex Mobile & IT Solutions' },
    customerAccount: {
      id: 'acc-1',
      status: 'ACTIVE',
      externalTenantId: 'TENANT-MS-9812',
      externalAccountId: 'u-1',
      customer: { id: 'c-1', displayName: 'City Mobile Kandy' },
    },
  },
]

let DEMO_ACTIVATIONS = [
  {
    id: 'act-1',
    reference: 'AR-7K9F2Q',
    status: 'PENDING_REVIEW',
    periodMonth: '2026-09',
    amount: '5500.00',
    currency: 'LKR',
    payerName: 'Nimal Perera',
    payerBank: 'BOC',
    transactionRef: 'TRX-882910',
    transferDate: '2026-09-28',
    notes: 'Monthly subscription transfer',
    submittedAt: '2026-09-28T16:00:00.000Z',
    paymentVerified: false,
    paymentVerifiedAt: null,
    decidedAt: null,
    rejectionReason: null,
    activatedAt: null,
    activationReference: null,
    product: { id: 'p-1', code: 'MOBILE_SHOP', name: 'Hexalyte Mobile Shop', monthlyPrice: '5500.00', currency: 'LKR' },
    reseller: { id: 'demo-reseller-id', code: 'RS-7K2F9Q', businessName: 'Apex Mobile & IT Solutions' },
    customerAccount: {
      id: 'acc-1',
      status: 'TRIAL',
      externalTenantId: 'TENANT-MS-9812',
      customer: { id: 'c-1', displayName: 'City Mobile Kandy' },
    },
    bankSlips: [{ id: 'slip-1', originalName: 'bank_slip.png', mimeType: 'image/png', sizeBytes: 1048576, createdAt: '2026-09-28T16:00:00.000Z' }],
    history: [{ id: 'h-1', fromStatus: null, toStatus: 'PENDING_REVIEW', action: 'SUBMITTED', note: null, createdAt: '2026-09-28T16:00:00.000Z' }],
  },
]

let DEMO_COMMISSIONS = [
  {
    id: 'comm-1',
    entryType: 'EARNING',
    periodMonth: '2026-09',
    level: 2,
    baseAmount: '5500.00',
    rate: '15.00',
    amount: '825.00',
    currency: 'LKR',
    status: 'APPROVED',
    payableAt: '2026-10-05T00:00:00.000Z',
    createdAt: '2026-09-28T16:30:00.000Z',
    paidAt: null,
    product: { code: 'MOBILE_SHOP', name: 'Hexalyte Mobile Shop' },
    customerAccount: { id: 'acc-1', status: 'ACTIVE', customer: { id: 'c-1', displayName: 'City Mobile Kandy' } },
    reseller: { id: 'demo-reseller-id', code: 'RS-7K2F9Q', businessName: 'Apex Mobile & IT Solutions' },
    payout: null,
  },
]

let DEMO_BANK_SLIPS = [
  {
    id: 'slip-1',
    originalName: 'bank-transfer-boc.png',
    mimeType: 'image/png',
    sizeBytes: 1048576,
    sha256: 'a1b2c3d4e5f6',
    createdAt: '2026-09-28T16:00:00.000Z',
    uploadedTimes: 1,
    reseller: { id: 'demo-reseller-id', code: 'RS-7K2F9Q', businessName: 'Apex Mobile & IT Solutions' },
    activationRequest: {
      id: 'act-1',
      reference: 'AR-7K9F2Q',
      status: 'PENDING_REVIEW',
      amount: '5500.00',
      currency: 'LKR',
      transactionRef: 'TRX-882910',
      periodMonth: '2026-09',
      paymentVerifiedAt: null,
      product: { name: 'Hexalyte Mobile Shop' },
      customerAccount: { customer: { displayName: 'City Mobile Kandy' } },
    },
  },
]

let DEMO_NOTIFICATIONS = [
  { id: 'notif-1', title: 'New Reseller Application', body: 'Lanka Tech Solutions submitted an application.', type: 'APPLICATION', readAt: null, createdAt: '2026-09-28T09:00:00.000Z', link: '/admin/reseller-applications' },
  { id: 'notif-2', title: 'Activation Request Submitted', body: 'AR-7K9F2Q submitted for City Mobile Kandy.', type: 'ACTIVATION', readAt: null, createdAt: '2026-09-28T16:00:00.000Z', link: '/admin/activations' },
  { id: 'notif-3', title: 'Commission Earned', body: 'LKR 825.00 pending approval for September.', type: 'COMMISSION', readAt: null, createdAt: '2026-09-28T16:30:00.000Z', link: '/commissions' },
]

let DEMO_SETTINGS = {
  commissionLevels: [
    { level: 1, name: 'Level 1', minActiveCustomers: 1, maxActiveCustomers: 10, ratePercent: '10.00' },
    { level: 2, name: 'Level 2', minActiveCustomers: 11, maxActiveCustomers: 30, ratePercent: '15.00' },
    { level: 3, name: 'Level 3', minActiveCustomers: 31, maxActiveCustomers: 60, ratePercent: '20.00' },
    { level: 4, name: 'Level 4', minActiveCustomers: 61, maxActiveCustomers: 100, ratePercent: '25.00' },
    { level: 5, name: 'Level 5', minActiveCustomers: 101, maxActiveCustomers: null, ratePercent: '30.00' },
  ],
  companyBankDetails: {
    value: 'Hexalyte (Pvt) Ltd | Commercial Bank, Colombo 03 | 1234567890',
    source: 'database',
    updatedAt: '2026-09-01T00:00:00.000Z',
    updatedBy: { name: 'Hexalyte Super Admin', email: 'admin@hexalyte.com' },
  },
  system: {
    commissionHoldDays: 7,
    maxUploadMb: 5,
    businessTimezone: 'Asia/Colombo',
    environment: 'development',
  },
  integrations: DEMO_PRODUCTS.map((p) => ({
    id: p.id,
    code: p.code,
    name: p.name,
    status: p.status,
    integrationStatus: p.integrationStatus,
    provider: p.code,
    lastCheckedAt: '2026-09-29T08:00:00.000Z',
  })),
}

export function demoMiddleware(req: Request, res: Response, next: NextFunction) {
  const path = req.path
  const method = req.method
  const authHeader = req.headers.authorization

  // 1. Auth Login
  if (path === '/auth/login' && method === 'POST') {
    const { email, password } = req.body || {}
    if (email === 'admin@hexalyte.com' && (password === 'ChangeMe!12345' || password === 'admin')) {
      const accessToken = signAccessToken({
        userId: DEMO_ADMIN.id,
        email: DEMO_ADMIN.email,
        role: DEMO_ADMIN.role,
        resellerId: null,
      })
      return res.json({
        success: true,
        data: {
          accessToken,
          refreshToken: 'demo-refresh-token-admin',
          user: { id: DEMO_ADMIN.id, email: DEMO_ADMIN.email, name: DEMO_ADMIN.name, role: DEMO_ADMIN.role, resellerId: null },
        },
        message: 'Logged in as Demo Super Admin',
      })
    }
    if (email === 'reseller@hexalyte.com' && (password === 'Demo12345!' || password === 'reseller')) {
      const accessToken = signAccessToken({
        userId: DEMO_RESELLER.id,
        email: DEMO_RESELLER.email,
        role: DEMO_RESELLER.role,
        resellerId: DEMO_RESELLER.resellerId,
      })
      return res.json({
        success: true,
        data: {
          accessToken,
          refreshToken: 'demo-refresh-token-reseller',
          user: { id: DEMO_RESELLER.id, email: DEMO_RESELLER.email, name: DEMO_RESELLER.name, role: DEMO_RESELLER.role, resellerId: DEMO_RESELLER.resellerId },
        },
        message: 'Logged in as Demo Reseller',
      })
    }
  }

  // Check demo user from Bearer Token
  let isDemoAdmin = false
  let isDemoReseller = false
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const decoded = verifyAccessToken(authHeader.slice(7))
      if (decoded.userId === DEMO_ADMIN.id || decoded.email === DEMO_ADMIN.email) isDemoAdmin = true
      if (decoded.userId === DEMO_RESELLER.id || decoded.email === DEMO_RESELLER.email) isDemoReseller = true
    } catch {
      // ignore
    }
  }

  // 2. Auth Me
  if (path === '/auth/me') {
    if (isDemoAdmin) return res.json({ success: true, data: DEMO_ADMIN })
    if (isDemoReseller) return res.json({ success: true, data: DEMO_RESELLER })
  }

  // 3. Auth Refresh
  if (path === '/auth/refresh' && method === 'POST') {
    const { refreshToken } = req.body || {}
    if (refreshToken?.includes('admin')) {
      const accessToken = signAccessToken({ userId: DEMO_ADMIN.id, email: DEMO_ADMIN.email, role: DEMO_ADMIN.role, resellerId: null })
      return res.json({ success: true, data: { accessToken, refreshToken, user: DEMO_ADMIN } })
    }
    const accessToken = signAccessToken({ userId: DEMO_RESELLER.id, email: DEMO_RESELLER.email, role: DEMO_RESELLER.role, resellerId: DEMO_RESELLER.resellerId })
    return res.json({ success: true, data: { accessToken, refreshToken, user: DEMO_RESELLER } })
  }

  // 3b. Auth Change Password
  if (path === '/auth/change-password' && method === 'POST') {
    return res.json({ success: true, message: 'Password changed successfully.' })
  }

  // 3c. Auth Logout
  if (path === '/auth/logout' && method === 'POST') {
    return res.json({ success: true, message: 'Logged out successfully.' })
  }

  // 4. Notifications unread count & list
  if (path === '/notifications/unread-count') {
    const unread = DEMO_NOTIFICATIONS.filter((n) => !n.readAt).length
    return res.json({ success: true, data: { count: unread } })
  }

  if (path === '/notifications' && method === 'GET') {
    return res.json({
      success: true,
      data: DEMO_NOTIFICATIONS,
      meta: { total: DEMO_NOTIFICATIONS.length, page: 1, limit: 20, totalPages: 1 },
    })
  }

  if (path.startsWith('/notifications/') && method === 'POST') {
    if (path === '/notifications/read-all') {
      DEMO_NOTIFICATIONS.forEach((n) => (n.readAt = new Date().toISOString()))
    } else {
      const notifId = path.split('/')[2]
      const n = DEMO_NOTIFICATIONS.find((x) => x.id === notifId)
      if (n) n.readAt = new Date().toISOString()
    }
    return res.json({ success: true, message: 'Notifications updated.' })
  }

  // 5. Products Catalogue & Admin Products
  if ((path === '/products' || path === '/admin/saas-products') && method === 'GET') {
    return res.json({ success: true, data: DEMO_PRODUCTS })
  }

  if (path === '/admin/saas-products' && method === 'POST') {
    const body = req.body || {}
    const newProduct = {
      id: 'p-' + Date.now(),
      code: (body.code || 'PRODUCT_' + Date.now()).toUpperCase(),
      name: body.name || 'New SaaS Product',
      description: body.description || '',
      status: body.status || 'ACTIVE',
      monthlyPrice: String(body.monthlyPrice || '5000.00'),
      currency: 'LKR',
      trialAvailable: !!body.trialAvailable,
      trialDays: body.trialDays ? Number(body.trialDays) : 14,
      canCreateTrial: !!body.trialAvailable,
      reason: null,
      integrationStatus: 'CONNECTED',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      _count: { resellerAccess: 0, accounts: 0 },
      integration: { provider: body.code || 'CUSTOM', lastCheckedAt: new Date().toISOString(), lastCheckOk: true },
    }
    DEMO_PRODUCTS.push(newProduct)
    return res.status(201).json({ success: true, data: newProduct, message: 'Product created successfully' })
  }

  if (path.startsWith('/admin/saas-products/') && method === 'GET') {
    const prodId = path.split('/')[3]
    const p = DEMO_PRODUCTS.find((x) => x.id === prodId) || DEMO_PRODUCTS[0]
    return res.json({
      success: true,
      data: {
        ...p,
        resellerAccess: [{ id: 'ra-1', reseller: { id: 'r-1', code: 'RS-7K2F9Q', businessName: 'Apex Mobile' } }],
        recentAccounts: [],
      },
    })
  }

  // 6. Reseller Application Registration (POST /reseller-registration)
  if (path === '/reseller-registration' && method === 'POST') {
    const body = req.body || {}
    const code = `RS-${Math.random().toString(36).substring(2, 6).toUpperCase()}`
    const newApp = {
      id: 'app-' + Date.now(),
      code,
      fullName: body.personal?.fullName || 'Applicant',
      email: body.personal?.email || 'applicant@hexalyte.com',
      mobile: body.personal?.mobile || '+94770000000',
      businessName: body.business?.businessName || 'New Reseller Business',
      businessRegistrationNo: body.business?.businessRegistrationNo || 'PV12345',
      status: 'PENDING',
      submittedAt: new Date().toISOString(),
      reviewedAt: null,
      personal: body.personal || {},
      business: body.business || {},
      bank: {
        bankName: body.bank?.bankName || 'Bank of Ceylon',
        branch: body.bank?.branch || 'Colombo',
        accountHolderName: body.bank?.accountHolderName || body.business?.businessName,
        accountNumberMasked: '••••••••' + (body.bank?.accountNumber?.slice(-4) || '9999'),
      },
      review: { reviewedAt: null, reviewedBy: null, approvedAt: null, rejectionReason: null, reviewNote: null },
      level: { currentLevel: null, activeCustomerCount: 0 },
      suspension: null,
    }
    DEMO_APPLICATIONS.unshift(newApp)
    return res.status(201).json({
      success: true,
      data: { code, email: newApp.email },
      message: 'Application submitted successfully.',
    })
  }

  // 6b. Admin Reseller Applications List & Actions
  if (path === '/admin/reseller-applications' && method === 'GET') {
    const st = req.query.status as string
    const filtered = st ? DEMO_APPLICATIONS.filter((a) => a.status === st) : DEMO_APPLICATIONS
    const pendingCount = DEMO_APPLICATIONS.filter((a) => a.status === 'PENDING').length
    return res.json({
      success: true,
      data: filtered,
      meta: { total: filtered.length, page: 1, limit: 20, totalPages: 1, pendingCount },
    })
  }

  if (path.startsWith('/admin/reseller-applications/') && method === 'GET') {
    const appId = path.split('/')[3]
    const app = DEMO_APPLICATIONS.find((a) => a.id === appId) || DEMO_APPLICATIONS[0]
    return res.json({ success: true, data: app })
  }

  if (path.includes('/bank-account/reveal') && method === 'POST') {
    return res.json({ success: true, data: { accountNumber: '123456789012' } })
  }

  if (path.endsWith('/approve') && path.includes('/reseller-applications/')) {
    const appId = path.split('/')[3]
    const app = DEMO_APPLICATIONS.find((a) => a.id === appId)
    if (app) {
      app.status = 'ACTIVE'
      app.review.reviewedAt = new Date().toISOString()
      app.review.approvedAt = new Date().toISOString()
      app.review.reviewedBy = { name: 'Hexalyte Super Admin', email: 'admin@hexalyte.com' }
      DEMO_RESELLERS.push({
        id: 'res-' + Date.now(),
        code: app.code,
        businessName: app.businessName,
        fullName: app.fullName,
        email: app.email,
        mobile: app.mobile,
        status: 'ACTIVE',
        currentLevel: 1,
        levelName: 'Level 1',
        activeCustomerCount: 0,
        customers: 0,
        users: 1,
        openActivationRequests: 0,
        unpaidCommission: '0.00',
        approvedAt: new Date().toISOString(),
      })
    }
    return res.json({ success: true, message: 'Reseller application approved. Partner account is now active.' })
  }

  if (path.endsWith('/reject') && path.includes('/reseller-applications/')) {
    const appId = path.split('/')[3]
    const app = DEMO_APPLICATIONS.find((a) => a.id === appId)
    if (app) {
      app.status = 'REJECTED'
      app.review.reviewedAt = new Date().toISOString()
      app.review.rejectionReason = req.body?.reason || 'Documentation incomplete.'
    }
    return res.json({ success: true, message: 'Application rejected.' })
  }

  // 7. Admin Resellers List & Suspend / Reactivate
  if (path === '/admin/resellers' && method === 'GET') {
    const activeCount = DEMO_RESELLERS.filter((r) => r.status === 'ACTIVE').length
    const suspendedCount = DEMO_RESELLERS.filter((r) => r.status === 'SUSPENDED').length
    return res.json({
      success: true,
      data: DEMO_RESELLERS,
      meta: { total: DEMO_RESELLERS.length, page: 1, limit: 20, totalPages: 1, statusCounts: { ACTIVE: activeCount, SUSPENDED: suspendedCount, PENDING: 1 } },
    })
  }

  if (path.includes('/admin/resellers/') && path.endsWith('/suspend') && method === 'POST') {
    const resId = path.split('/')[3]
    const r = DEMO_RESELLERS.find((x) => x.id === resId)
    if (r) r.status = 'SUSPENDED'
    return res.json({ success: true, message: 'Reseller suspended successfully.' })
  }

  if (path.includes('/admin/resellers/') && path.endsWith('/reactivate') && method === 'POST') {
    const resId = path.split('/')[3]
    const r = DEMO_RESELLERS.find((x) => x.id === resId)
    if (r) r.status = 'ACTIVE'
    return res.json({ success: true, message: 'Reseller reactivated successfully.' })
  }

  // 8. Customers
  if (path === '/customers') {
    const search = ((req.query.search as string) || '').toLowerCase()
    const filtered = search ? DEMO_CUSTOMERS.filter((c) => c.displayName.toLowerCase().includes(search)) : DEMO_CUSTOMERS
    return res.json({ success: true, data: filtered, meta: { total: filtered.length, page: 1, limit: 20, totalPages: 1 } })
  }

  // 9. Reseller Dashboard
  if (path === '/dashboard/reseller') {
    return res.json({
      success: true,
      data: {
        reseller: DEMO_RESELLER.reseller,
        products: DEMO_PRODUCTS,
        filters: { from: null, to: null, productId: null },
        kpis: {
          level: {
            level: 2,
            name: 'Level 2',
            activeCount: DEMO_CUSTOMERS.length,
            nextLevel: { name: 'Level 3', customersNeeded: 8 },
            ratePercent: 15,
          },
          activeCustomers: DEMO_CUSTOMERS.length,
          totalCustomers: DEMO_CUSTOMERS.length,
          trialCustomers: 1,
          activeSubscriptions: DEMO_CUSTOMERS.length,
          pendingActivationRequests: DEMO_ACTIVATIONS.filter((a) => a.status === 'PENDING_REVIEW').length,
          commission: {
            currency: 'LKR',
            thisMonth: '11500.00',
            pending: '5500.00',
            paid: '36000.00',
          },
        },
        period: {
          newCustomers: DEMO_CUSTOMERS.length,
          trialsCreated: DEMO_TRIALS.length,
          activationsSubmitted: DEMO_ACTIVATIONS.length,
          commissionEarned: '11500.00',
          commissionPaid: '15000.00',
        },
        recent: {
          customers: DEMO_CUSTOMERS,
          trials: DEMO_TRIALS,
          activations: DEMO_ACTIVATIONS,
          commissions: DEMO_COMMISSIONS,
        },
      },
    })
  }

  // 10. Admin Dashboard
  if (path === '/dashboard/admin') {
    const pendingReviewCount = DEMO_ACTIVATIONS.filter((a) => a.status === 'PENDING_REVIEW').length
    const pendingApps = DEMO_APPLICATIONS.filter((a) => a.status === 'PENDING').length
    return res.json({
      success: true,
      data: {
        period: '2026-09',
        kpis: {
          totalResellers: DEMO_RESELLERS.length,
          suspendedResellers: DEMO_RESELLERS.filter((r) => r.status === 'SUSPENDED').length,
          pendingApprovals: pendingApps,
          activeCustomers: 86,
          activeSubscriptions: 94,
          trialAccounts: DEMO_TRIALS.length,
          pendingActivations: { total: pendingReviewCount, pendingReview: pendingReviewCount, underReview: 0, awaitingActivation: 0 },
          monthlyActivations: 24,
          commission: {
            currency: 'LKR',
            pending: '48500.00',
            payable: '32000.00',
            awaitingApprovalCount: 6,
            paid: '240000.00',
            paidThisMonth: '65000.00',
          },
        },
        activationTrend: [
          { periodMonth: '2026-04', count: 12 },
          { periodMonth: '2026-05', count: 16 },
          { periodMonth: '2026-06', count: 19 },
          { periodMonth: '2026-07', count: 21 },
          { periodMonth: '2026-08', count: 23 },
          { periodMonth: '2026-09', count: 24 },
        ],
        queue: {
          applications: DEMO_APPLICATIONS.filter((a) => a.status === 'PENDING'),
          activations: DEMO_ACTIVATIONS.filter((a) => a.status === 'PENDING_REVIEW'),
        },
        attention: { failedTrials7d: 0, integrationErrors: [], failedActivations: 0 },
        recentAudit: [
          { id: 'aud-1', action: 'ACTIVATION_SUBMITTED', actorEmail: 'reseller@hexalyte.com', actorType: 'USER', entityType: 'ActivationRequest', entityId: 'act-1', createdAt: '2026-09-28T16:00:00.000Z' },
          { id: 'aud-2', action: 'AUTH_LOGIN', actorEmail: 'admin@hexalyte.com', actorType: 'USER', entityType: 'User', entityId: 'u-1', createdAt: '2026-09-29T08:00:00.000Z' },
        ],
        sections: {
          resellers: DEMO_RESELLERS.length,
          pendingApplications: pendingApps,
          products: DEMO_PRODUCTS.length,
          customers: 86,
          trials: DEMO_TRIALS.length,
          openActivations: pendingReviewCount,
          bankSlips: DEMO_BANK_SLIPS.length,
          unreadNotifications: DEMO_NOTIFICATIONS.filter((n) => !n.readAt).length,
        },
      },
    })
  }

  // 11. Trials List & Create
  if (path === '/trials' && method === 'GET') {
    return res.json({
      success: true,
      data: DEMO_TRIALS,
      meta: { total: DEMO_TRIALS.length, page: 1, limit: 20, totalPages: 1 },
    })
  }

  if (path === '/trials' && method === 'POST') {
    const { productId, owner } = req.body || {}
    const product = DEMO_PRODUCTS.find((p) => p.id === productId) || DEMO_PRODUCTS[0]
    const businessName = owner?.businessName || 'New Client'
    const newCustomer = {
      id: 'c-' + Date.now(),
      displayName: businessName,
      createdAt: new Date().toISOString(),
      accounts: [
        {
          id: 'acc-' + Date.now(),
          status: 'TRIAL' as const,
          externalTenantId: `TENANT-${product.code}-${Math.floor(1000 + Math.random() * 9000)}`,
          product: { id: product.id, code: product.code, name: product.name, monthlyPrice: product.monthlyPrice, currency: product.currency },
        },
      ],
    }
    DEMO_CUSTOMERS.unshift(newCustomer)

    const newTrial = {
      id: 'tr-' + Date.now(),
      status: 'PROVISIONED',
      errorMessage: null,
      createdAt: new Date().toISOString(),
      product: { id: product.id, code: product.code, name: product.name },
      reseller: { id: 'demo-reseller-id', code: 'RS-7K2F9Q', businessName: 'Apex Mobile & IT Solutions' },
      customerAccount: {
        id: newCustomer.accounts[0].id,
        status: 'TRIAL',
        externalTenantId: newCustomer.accounts[0].externalTenantId,
        customer: { id: newCustomer.id, displayName: newCustomer.displayName },
      },
    }
    DEMO_TRIALS.unshift(newTrial)

    return res.status(201).json({
      success: true,
      data: {
        trial: newTrial,
        outcome: 'PROVISIONED',
        message: `Trial account created in ${product.name}.`,
        saas: { status: 'TRIAL', trialEndsAt: new Date(Date.now() + 14 * 86400000).toISOString() },
      },
      message: `Trial account created in ${product.name}.`,
    })
  }

  if (path.startsWith('/trials/') && method === 'GET') {
    const trId = path.split('/')[2]
    const tr = DEMO_TRIALS.find((t) => t.id === trId) || DEMO_TRIALS[0]
    return res.json({ success: true, data: tr })
  }

  if (path.includes('/trials/') && path.endsWith('/sync') && method === 'POST') {
    return res.json({ success: true, outcome: 'PROVISIONED', message: 'Tenant status synced with SaaS provider: Active trial.' })
  }

  if (path.includes('/trials/') && path.endsWith('/cancel') && method === 'POST') {
    const trId = path.split('/')[2]
    const tr = DEMO_TRIALS.find((t) => t.id === trId)
    if (tr) tr.status = 'CANCELLED'
    return res.json({ success: true, message: 'Trial cancelled.' })
  }

  // 12. Activation Payment Info
  if (path === '/activation-requests/payment-info') {
    return res.json({
      success: true,
      data: {
        companyBankDetails: DEMO_SETTINGS.companyBankDetails.value,
        maxUploadMb: 5,
      },
    })
  }

  // 12b. Activations List & Create
  if (path === '/activation-requests' && method === 'GET') {
    return res.json({
      success: true,
      data: DEMO_ACTIVATIONS,
      meta: { total: DEMO_ACTIVATIONS.length, page: 1, limit: 20, totalPages: 1 },
    })
  }

  if (path === '/activation-requests' && method === 'POST') {
    const ref = `AR-${Math.random().toString(36).substring(2, 8).toUpperCase()}`
    const body = req.body || {}
    const newAct = {
      id: 'act-' + Date.now(),
      reference: ref,
      status: 'PENDING_REVIEW',
      periodMonth: new Date().toISOString().substring(0, 7),
      amount: String(body.amount || '5500.00'),
      currency: 'LKR',
      payerName: body.payerName || 'Client Transfer',
      payerBank: body.payerBank || 'Bank',
      transactionRef: body.transactionRef || `TRX-${Date.now().toString().slice(-6)}`,
      transferDate: body.transferDate || new Date().toISOString().substring(0, 10),
      notes: body.notes || 'Monthly SaaS activation payment',
      submittedAt: new Date().toISOString(),
      paymentVerified: false,
      paymentVerifiedAt: null,
      decidedAt: null,
      rejectionReason: null,
      activatedAt: null,
      activationReference: null,
      product: DEMO_PRODUCTS[0],
      reseller: { id: 'demo-reseller-id', code: 'RS-7K2F9Q', businessName: 'Apex Mobile & IT Solutions' },
      customerAccount: {
        id: 'acc-1',
        status: 'TRIAL',
        externalTenantId: 'TENANT-MS-9812',
        customer: { id: 'c-1', displayName: 'City Mobile Kandy' },
      },
      bankSlips: [{ id: 'slip-' + Date.now(), originalName: 'uploaded_slip.png', mimeType: 'image/png', sizeBytes: 1048576, createdAt: new Date().toISOString() }],
      history: [{ id: 'h-' + Date.now(), fromStatus: null, toStatus: 'PENDING_REVIEW', action: 'SUBMITTED', note: null, createdAt: new Date().toISOString() }],
    }
    DEMO_ACTIVATIONS.unshift(newAct)
    return res.status(201).json({
      success: true,
      data: newAct,
      message: `Activation request ${ref} submitted successfully. Hexalyte will review the bank slip.`,
    })
  }

  if (path.startsWith('/activation-requests/') && method === 'GET') {
    const actId = path.split('/')[2]
    const act = DEMO_ACTIVATIONS.find((a) => a.id === actId) || DEMO_ACTIVATIONS[0]
    return res.json({ success: true, data: act })
  }

  // 12c. Activation Actions
  if (path.includes('/activation-requests/') && path.endsWith('/review') && method === 'POST') {
    const actId = path.split('/')[2]
    const act = DEMO_ACTIVATIONS.find((a) => a.id === actId)
    if (act) act.status = 'UNDER_REVIEW'
    return res.json({ success: true, data: act, message: 'Activation request marked under review.' })
  }

  if (path.includes('/activation-requests/') && path.endsWith('/verify-payment') && method === 'POST') {
    const actId = path.split('/')[2]
    const act = DEMO_ACTIVATIONS.find((a) => a.id === actId)
    if (act) {
      act.paymentVerified = true
      act.paymentVerifiedAt = new Date().toISOString()
      act.status = 'APPROVED'
    }
    return res.json({ success: true, data: act, message: 'Bank payment slip verified.' })
  }

  if (path.includes('/activation-requests/') && path.endsWith('/approve') && method === 'POST') {
    const actId = path.split('/')[2]
    const act = DEMO_ACTIVATIONS.find((a) => a.id === actId)
    if (act) act.status = 'APPROVED'
    return res.json({ success: true, data: act, message: 'Activation request approved.' })
  }

  if (path.includes('/activation-requests/') && path.endsWith('/activate') && method === 'POST') {
    const actId = path.split('/')[2]
    const act = DEMO_ACTIVATIONS.find((a) => a.id === actId)
    if (act) {
      act.status = 'ACTIVATION_COMPLETED'
      act.activatedAt = new Date().toISOString()
      act.activationReference = `ACT-${Math.random().toString(36).substring(2, 8).toUpperCase()}`
      // Add a commission earning!
      DEMO_COMMISSIONS.unshift({
        id: 'comm-' + Date.now(),
        entryType: 'EARNING',
        periodMonth: act.periodMonth,
        level: 2,
        baseAmount: act.amount,
        rate: '15.00',
        amount: String(Number(act.amount) * 0.15),
        currency: 'LKR',
        status: 'APPROVED',
        payableAt: new Date(Date.now() + 7 * 86400000).toISOString(),
        createdAt: new Date().toISOString(),
        paidAt: null,
        product: act.product,
        customerAccount: act.customerAccount,
        reseller: act.reseller,
        payout: null,
      })
    }
    return res.json({ success: true, data: act, message: 'Tenant successfully activated in SaaS provider!' })
  }

  if (path.includes('/activation-requests/') && path.endsWith('/reject') && method === 'POST') {
    const actId = path.split('/')[2]
    const act = DEMO_ACTIVATIONS.find((a) => a.id === actId)
    if (act) {
      act.status = 'REJECTED'
      act.rejectionReason = req.body?.reason || 'Payment could not be verified.'
    }
    return res.json({ success: true, data: act, message: 'Activation request rejected.' })
  }

  // 13. Bank Slips Register
  if (path === '/bank-slips' && method === 'GET') {
    return res.json({
      success: true,
      data: DEMO_BANK_SLIPS,
      meta: { total: DEMO_BANK_SLIPS.length, page: 1, limit: 20, totalPages: 1 },
    })
  }

  if (path.startsWith('/bank-slips/') && path.endsWith('/verify') && method === 'POST') {
    return res.json({ success: true, message: 'Slip verified successfully.' })
  }

  // 14. Customer Accounts List
  if (path === '/customer-accounts' && method === 'GET') {
    const accounts = DEMO_CUSTOMERS.flatMap((c) =>
      c.accounts.map((a) => ({
        id: a.id,
        status: a.status,
        externalTenantId: a.externalTenantId,
        externalAccountId: 'u-' + a.id,
        activatedAt: '2026-09-12T10:00:00.000Z',
        customer: { id: c.id, displayName: c.displayName },
        product: a.product,
        reseller: { id: 'demo-reseller-id', code: 'RS-7K2F9Q', businessName: 'Apex Mobile & IT Solutions' },
        resellerId: 'demo-reseller-id',
      }))
    )
    return res.json({ success: true, data: accounts, meta: { total: accounts.length, page: 1, limit: 20, totalPages: 1 } })
  }

  if (path.includes('/customer-accounts/') && path.endsWith('/sync') && method === 'POST') {
    return res.json({ success: true, message: 'Account status synced with SaaS provider.' })
  }

  // 15. Commissions Summary, Ledger, Customers, Monthly & Payouts
  if (path === '/commissions/summary') {
    return res.json({
      success: true,
      data: {
        reseller: DEMO_RESELLER.reseller,
        level: { level: 2, name: 'Level 2', ratePercent: 15, activeCustomerCount: DEMO_CUSTOMERS.length, nextLevel: { level: 3, name: 'Level 3', ratePercent: 20, customersNeeded: 8 } },
        levels: DEMO_SETTINGS.commissionLevels,
        commissionPerCustomer: [
          { product: 'Hexalyte Mobile Shop', productCode: 'MOBILE_SHOP', baseAmount: '5500.00', currency: 'LKR', amount: '825.00' },
          { product: 'HexaOne Clothing ERP', productCode: 'FASHION_ERP', baseAmount: '8500.00', currency: 'LKR', amount: '1275.00' },
        ],
        totals: { pending: '5500.00', approved: '6000.00', payable: '8250.00', paid: '36000.00', reversed: '0.00' },
        currentMonth: { periodMonth: '2026-09', earnings: '11500.00' },
        monthlyEarnings: [
          { periodMonth: '2026-04', earnings: '6000.00' },
          { periodMonth: '2026-05', earnings: '8500.00' },
          { periodMonth: '2026-06', earnings: '10000.00' },
          { periodMonth: '2026-07', earnings: '11500.00' },
          { periodMonth: '2026-08', earnings: '11500.00' },
          { periodMonth: '2026-09', earnings: '11500.00' },
        ],
        levelHistory: [],
      },
    })
  }

  if (path === '/commissions' && method === 'GET') {
    return res.json({
      success: true,
      data: DEMO_COMMISSIONS,
      meta: { total: DEMO_COMMISSIONS.length, page: 1, limit: 20, totalPages: 1, netAmount: '825.00' },
    })
  }

  if (path === '/commissions/customers' && method === 'GET') {
    return res.json({
      success: true,
      data: DEMO_CUSTOMERS.map((c) => ({
        customer: { id: c.id, displayName: c.displayName },
        product: c.accounts[0]?.product,
        totalEarned: '2475.00',
        activeMonths: 3,
        lastCommissionAt: '2026-09-28T16:30:00.000Z',
      })),
      meta: { total: DEMO_CUSTOMERS.length },
    })
  }

  if (path === '/commissions/monthly' && method === 'GET') {
    return res.json({
      success: true,
      data: [
        { periodMonth: '2026-09', totalEarnings: '11500.00', customerCount: 8, paidAmount: '0.00', pendingAmount: '11500.00', status: 'IN_PROGRESS' },
        { periodMonth: '2026-08', totalEarnings: '11500.00', customerCount: 8, paidAmount: '11500.00', pendingAmount: '0.00', status: 'PAID' },
        { periodMonth: '2026-07', totalEarnings: '11500.00', customerCount: 8, paidAmount: '11500.00', pendingAmount: '0.00', status: 'PAID' },
      ],
    })
  }

  if (path === '/commissions/payouts' && method === 'GET') {
    return res.json({
      success: true,
      data: [
        { id: 'pay-1', reference: 'PO-202608-01', periodMonth: '2026-08', amount: '11500.00', currency: 'LKR', status: 'PAID', paidAt: '2026-09-05T10:00:00.000Z', transactionReference: 'BANK-TRF-99210' },
        { id: 'pay-2', reference: 'PO-202607-01', periodMonth: '2026-07', amount: '11500.00', currency: 'LKR', status: 'PAID', paidAt: '2026-08-05T10:00:00.000Z', transactionReference: 'BANK-TRF-88190' },
      ],
    })
  }

  if (path === '/admin/commissions/approve' && method === 'POST') {
    DEMO_COMMISSIONS.forEach((c) => {
      if (c.status === 'APPROVED') c.status = 'PAYABLE'
    })
    return res.json({ success: true, data: { approvedCount: 1, totalAmount: '825.00' }, message: 'Commissions approved and marked payable.' })
  }

  if (path === '/admin/commissions/payout' && method === 'POST') {
    DEMO_COMMISSIONS.forEach((c) => {
      if (c.status === 'PAYABLE') c.status = 'PAID'
    })
    return res.json({ success: true, data: { payoutId: 'pay-' + Date.now(), count: 1, totalAmount: '825.00' }, message: 'Payout batch created and processed.' })
  }

  // 16. Audit Logs
  if ((path === '/audit-logs' || path === '/admin/audit-logs') && method === 'GET') {
    return res.json({
      success: true,
      data: [
        { id: 'aud-1', action: 'ACTIVATION_SUBMITTED', actorEmail: 'reseller@hexalyte.com', actorType: 'USER', entityType: 'ActivationRequest', entityId: 'act-1', createdAt: '2026-09-28T16:00:00.000Z', metadata: {} },
        { id: 'aud-2', action: 'AUTH_LOGIN', actorEmail: 'admin@hexalyte.com', actorType: 'USER', entityType: 'User', entityId: 'u-1', createdAt: '2026-09-29T08:00:00.000Z', metadata: {} },
        { id: 'aud-3', action: 'TRIAL_PROVISIONED', actorEmail: 'reseller@hexalyte.com', actorType: 'USER', entityType: 'TrialRequest', entityId: 'tr-1', createdAt: '2026-09-25T10:00:00.000Z', metadata: {} },
      ],
      meta: { total: 3, page: 1, limit: 20, totalPages: 1 },
    })
  }

  if (path === '/audit-logs/facets' && method === 'GET') {
    return res.json({
      success: true,
      data: {
        actions: [
          { value: 'AUTH_LOGIN', count: 12 },
          { value: 'ACTIVATION_SUBMITTED', count: 8 },
          { value: 'TRIAL_PROVISIONED', count: 5 },
          { value: 'RESELLER_APPLICATION_SUBMITTED', count: 3 },
        ],
        entityTypes: [
          { value: 'User', count: 12 },
          { value: 'ActivationRequest', count: 8 },
          { value: 'TrialRequest', count: 5 },
          { value: 'Reseller', count: 3 },
        ],
      },
    })
  }

  // 17. Admin Settings & Update
  if (path === '/admin/settings' && method === 'GET') {
    return res.json({ success: true, data: DEMO_SETTINGS })
  }

  if (path === '/admin/settings' && (method === 'PUT' || method === 'POST')) {
    if (req.body?.companyBankDetails) {
      DEMO_SETTINGS.companyBankDetails.value = req.body.companyBankDetails
    }
    return res.json({ success: true, data: DEMO_SETTINGS, message: 'Platform settings updated successfully.' })
  }

  next()
}
