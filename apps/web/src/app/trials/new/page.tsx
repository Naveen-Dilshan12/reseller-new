'use client'

import { buildWhatsAppUrl } from '@/lib/whatsapp'
import { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { formatMoney } from '@/lib/format'
import { trialLabel, type ResellerProduct } from '@/lib/product-types'
import {
  emptyShopDetails,
  validateShopDetails,
  type TrialOutcomeResult,
  type ShopDetails,
} from '@/lib/trial-types'
import { ResellerShell } from '@/components/ResellerShell'
import { PageHero } from '@/components/PageHero'
import {
  Store,
  PackageCheck,
  Cpu,
  CheckCircle2,
  ArrowRight,
  ArrowLeft,
  Copy,
  ExternalLink,
  MessageSquare,
  Key,
  RefreshCw,
  AlertCircle,
  Eye,
  EyeOff,
  Check,
  Sparkles,
  ShieldCheck,
  Building2,
  Phone,
  Mail,
  User,
  Lock,
} from 'lucide-react'

function generateSecurePassword(): string {
  const uppers = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const lowers = 'abcdefghijkmnpqrstuvwxyz'
  const digits = '23456789'
  const specials = '!@#$%&*?'
  let pwd = ''
  pwd += uppers[Math.floor(Math.random() * uppers.length)]
  pwd += lowers[Math.floor(Math.random() * lowers.length)]
  pwd += digits[Math.floor(Math.random() * digits.length)]
  pwd += specials[Math.floor(Math.random() * specials.length)]
  const all = uppers + lowers + digits + specials
  for (let i = 0; i < 8; i++) {
    pwd += all[Math.floor(Math.random() * all.length)]
  }
  return pwd.split('').sort(() => Math.random() - 0.5).join('')
}

function NewTrialWizard() {
  const searchParams = useSearchParams()
  const initialProductId = searchParams.get('productId') || ''

  const [currentStep, setCurrentStep] = useState<1 | 2 | 3 | 4>(1)
  const [shop, setShop] = useState<ShopDetails>(emptyShopDetails)
  const [showPassword, setShowPassword] = useState(false)
  const [products, setProducts] = useState<ResellerProduct[] | null>(null)
  const [productId, setProductId] = useState(initialProductId)

  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<TrialOutcomeResult | null>(null)

  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  useEffect(() => {
    api<ResellerProduct[]>('/products')
      .then((data) => {
        setProducts(data)
        if (initialProductId && data.some((p) => p.id === initialProductId)) {
          setProductId(initialProductId)
        } else if (data.length > 0 && !productId) {
          const firstAvailable = data.find((p) => p.canCreateTrial) || data[0]
          setProductId(firstAvailable.id)
        }
      })
      .catch(() => setProducts([]))
  }, [initialProductId]) // eslint-disable-line react-hooks/exhaustive-deps

  const selectedProduct = products?.find((p) => p.id === productId)

  const handleCopy = (text: string, key: string) => {
    navigator.clipboard.writeText(text)
    setCopiedKey(key)
    setTimeout(() => setCopiedKey(null), 2500)
  }

  // ── Step 1 Navigation ──
  const proceedToStep2 = () => {
    const v = validateShopDetails(shop)
    if (Object.keys(v).length > 0) {
      setErrors(v)
      return
    }

    // Auto-generate secure password if blank
    let finalPassword = shop.password?.trim()
    if (!finalPassword) {
      finalPassword = generateSecurePassword()
      setShop((prev) => ({ ...prev, password: finalPassword }))
    }

    setErrors({})
    setFormError(null)
    setCurrentStep(2)
  }

  // ── Step 3 Provisioning ──
  const runProvisioning = async () => {
    if (!productId) {
      setFormError('Please select a SaaS product plan')
      return
    }

    setBusy(true)
    setFormError(null)
    setCurrentStep(3)

    try {
      const payload = {
        productId,
        owner: {
          shopName: shop.shopName.trim(),
          ownerName: shop.ownerName.trim(),
          email: shop.email.trim().toLowerCase(),
          phone: shop.phone.trim(),
          password: shop.password?.trim() || undefined,
        },
      }

      const res = await api<TrialOutcomeResult>('/trials', {
        method: 'POST',
        body: JSON.stringify(payload),
      })

      setResult(res)

      if (res.outcome === 'PROVISIONED' || res.outcome === 'SUBMITTED') {
        setCurrentStep(4)
      } else if (res.outcome === 'FAILED') {
        setFormError(res.message || 'Provisioning failed with the SaaS integration')
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setFormError(err.errors.length && !err.errors[0].includes(': ') ? err.errors[0] : err.message)
      } else {
        setFormError(err instanceof Error ? err.message : 'Could not provision the trial account')
      }
    } finally {
      setBusy(false)
    }
  }

  // Compute URLs and WhatsApp details for Step 4
  const shopSlug = useMemo(() => {
    const name = shop.shopName || ''
    const tenantId = result?.provisioning?.externalTenantId || result?.trial.customerAccount.externalTenantId || ''
    const clean = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    return clean || tenantId.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  }, [shop.shopName, result])

  const loginUrl = useMemo(() => {
    if (result?.provisioning?.loginUrl) return result.provisioning.loginUrl
    if (!selectedProduct) return 'https://app.hexalyte.com/login'
    switch (selectedProduct.code) {
      case 'MOBILE_SHOP': return 'https://mobileshop.hexalyte.com/login'
      case 'FASHION_ERP': return 'https://clothingerp.hexalyte.com/login'
      case 'SALON': return 'https://salon.hexalyte.com/login'
      case 'SUPERMARKET': return 'https://pos.hexalyte.com/login'
      default: return 'https://app.hexalyte.com/login'
    }
  }, [result, selectedProduct])

  const shopUrl = useMemo(() => {
    if (result?.provisioning?.shopUrl) return result.provisioning.shopUrl
    if (!selectedProduct) return `https://${shopSlug}.hexalyte.com`
    switch (selectedProduct.code) {
      case 'MOBILE_SHOP': return `https://${shopSlug}.mobileshop.hexalyte.com`
      case 'FASHION_ERP': return `https://${shopSlug}.clothingerp.hexalyte.com`
      case 'SALON': return `https://${shopSlug}.salon.hexalyte.com`
      case 'SUPERMARKET': return `https://${shopSlug}.pos.hexalyte.com`
      default: return `https://${shopSlug}.hexalyte.com`
    }
  }, [result, selectedProduct, shopSlug])

  const welcomeMessage = useMemo(() => {
    const shopTitle = shop.shopName || 'your store'
    const planTitle = selectedProduct?.name || 'Hexalyte SaaS'
    return `🎉 Welcome to ${shopTitle}!

Your ${planTitle} free trial account has been provisioned and is ready.

🌐 Shop URL: ${shopUrl}
🔐 Login URL: ${loginUrl}
👤 Username: ${shop.email}
🔑 Temporary Password: ${shop.password}

Log in today to set up your store and start exploring all features!`
  }, [shop, selectedProduct, shopUrl, loginUrl])

  const whatsappLink = useMemo(() => buildWhatsAppUrl(shop.phone, welcomeMessage), [shop.phone, welcomeMessage])

  return (
    <>
      {/* ── Stepper Navigation ── */}
      <div className="steps" role="navigation" aria-label="Trial Account Setup Steps">
        <div className={`step ${currentStep === 1 ? 'active' : currentStep > 1 ? 'done' : ''}`}>
          <Store size={16} />
          <span>1. Shop Details</span>
        </div>
        <div className={`step ${currentStep === 2 ? 'active' : currentStep > 2 ? 'done' : ''}`}>
          <PackageCheck size={16} />
          <span>2. Select Plan</span>
        </div>
        <div
          className={`step ${
            currentStep === 3
              ? formError
                ? 'failed'
                : 'active'
              : currentStep > 3
              ? 'done'
              : ''
          }`}
        >
          <Cpu size={16} />
          <span>3. Provision Tenant</span>
        </div>
        <div className={`step ${currentStep === 4 ? 'done active' : ''}`}>
          <CheckCircle2 size={16} />
          <span>4. Done</span>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════════
          STEP 1: SHOP DETAILS
          Collects Shop Name, Owner Name, Email, Phone, Password (optional)
          ══════════════════════════════════════════════════════════════════════════ */}
      {currentStep === 1 && (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', marginBottom: '1.25rem' }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: '10px',
                background: 'rgba(37, 99, 235, 0.12)',
                color: 'var(--primary-light)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Building2 size={20} />
            </div>
            <div>
              <h2 style={{ margin: 0, fontSize: '1.25rem' }}>Step 1 — Shop Details</h2>
              <p className="muted small" style={{ margin: 0 }}>
                Enter the client&apos;s shop and owner contact details. This registers the customer and provisions their store.
              </p>
            </div>
          </div>

          <div className="grid-2" style={{ gap: '1rem' }}>
            {/* Shop Name */}
            <div className="field">
              <label htmlFor="shop-name">
                Shop Name <span style={{ color: 'var(--danger, #ef4444)' }}>*</span>
              </label>
              <div style={{ position: 'relative' }}>
                <input
                  id="shop-name"
                  type="text"
                  placeholder="e.g. Kandy Mobile Hub"
                  value={shop.shopName}
                  onChange={(e) => setShop((s) => ({ ...s, shopName: e.target.value }))}
                  aria-invalid={Boolean(errors.shopName)}
                  style={{ width: '100%' }}
                />
              </div>
              {errors.shopName ? (
                <span className="error small">{errors.shopName}</span>
              ) : (
                <span className="hint">The trading or business name for the shop</span>
              )}
            </div>

            {/* Owner Name */}
            <div className="field">
              <label htmlFor="owner-name">
                Owner Name <span style={{ color: 'var(--danger, #ef4444)' }}>*</span>
              </label>
              <div style={{ position: 'relative' }}>
                <input
                  id="owner-name"
                  type="text"
                  placeholder="e.g. Nimal Perera"
                  value={shop.ownerName}
                  onChange={(e) => setShop((s) => ({ ...s, ownerName: e.target.value }))}
                  aria-invalid={Boolean(errors.ownerName)}
                  style={{ width: '100%' }}
                />
              </div>
              {errors.ownerName ? (
                <span className="error small">{errors.ownerName}</span>
              ) : (
                <span className="hint">Primary contact person &amp; tenant administrator</span>
              )}
            </div>

            {/* Email */}
            <div className="field">
              <label htmlFor="owner-email">
                Email <span style={{ color: 'var(--danger, #ef4444)' }}>*</span>
              </label>
              <div style={{ position: 'relative' }}>
                <input
                  id="owner-email"
                  type="email"
                  placeholder="e.g. nimal@example.lk"
                  value={shop.email}
                  onChange={(e) => setShop((s) => ({ ...s, email: e.target.value }))}
                  aria-invalid={Boolean(errors.email)}
                  style={{ width: '100%' }}
                />
              </div>
              {errors.email ? (
                <span className="error small">{errors.email}</span>
              ) : (
                <span className="hint">Login username and email address for account alerts</span>
              )}
            </div>

            {/* Phone */}
            <div className="field">
              <label htmlFor="owner-phone">
                Phone <span style={{ color: 'var(--danger, #ef4444)' }}>*</span>
              </label>
              <div style={{ position: 'relative' }}>
                <input
                  id="owner-phone"
                  type="tel"
                  placeholder="e.g. 0771234567 or +94771234567"
                  value={shop.phone}
                  onChange={(e) => setShop((s) => ({ ...s, phone: e.target.value }))}
                  aria-invalid={Boolean(errors.phone)}
                  style={{ width: '100%' }}
                />
              </div>
              {errors.phone ? (
                <span className="error small">{errors.phone}</span>
              ) : (
                <span className="hint">Mobile number for WhatsApp onboarding and notifications</span>
              )}
            </div>
          </div>

          {/* Password (Optional) */}
          <div className="field" style={{ marginTop: '0.75rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label htmlFor="owner-password">
                Password <span className="muted small">(optional; auto-generate securely if blank)</span>
              </label>
              <button
                type="button"
                className="btn secondary small"
                style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem', gap: '0.3rem' }}
                onClick={() => {
                  const generated = generateSecurePassword()
                  setShop((s) => ({ ...s, password: generated }))
                  setShowPassword(true)
                }}
              >
                <Sparkles size={12} />
                <span>Auto-Generate</span>
              </button>
            </div>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <input
                id="owner-password"
                type={showPassword ? 'text' : 'password'}
                placeholder="Leave blank to auto-generate a secure password"
                value={shop.password || ''}
                onChange={(e) => setShop((s) => ({ ...s, password: e.target.value }))}
                style={{ width: '100%', paddingRight: '2.5rem' }}
              />
              <button
                type="button"
                onClick={() => setShowPassword((p) => !p)}
                style={{
                  position: 'absolute',
                  right: '0.75rem',
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--muted)',
                  cursor: 'pointer',
                  padding: '0.25rem',
                  display: 'flex',
                  alignItems: 'center',
                }}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            {errors.password ? (
              <span className="error small">{errors.password}</span>
            ) : (
              <span className="hint">If left empty, a secure password will be automatically generated for the owner upon proceeding.</span>
            )}
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1.75rem' }}>
            <button className="btn" type="button" onClick={proceedToStep2} style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'center' }}>
              <span>Continue to Select Plan</span>
              <ArrowRight size={16} />
            </button>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════════
          STEP 2: SELECT PLAN
          Contains ONLY:
          - Available SaaS product/plan selection
          - Actual configured plan pricing and feature details
          - Selected plan's trial terms
          NO shop summary card, NO customer dropdown, NO duplicate fields
          ══════════════════════════════════════════════════════════════════════════ */}
      {currentStep === 2 && (
        <>
          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', marginBottom: '1.25rem' }}>
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: '10px',
                  background: 'rgba(37, 99, 235, 0.12)',
                  color: 'var(--primary-light)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <PackageCheck size={20} />
              </div>
              <div>
                <h2 style={{ margin: 0, fontSize: '1.25rem' }}>Step 2 — Select Plan</h2>
                <p className="muted small" style={{ margin: 0 }}>
                  Choose from your enabled Hexalyte SaaS products to start an instant zero-commitment trial.
                </p>
              </div>
            </div>

            {!products ? (
              <p className="muted">Loading available plans…</p>
            ) : products.length === 0 ? (
              <p className="muted">No products are enabled for your partner account.</p>
            ) : (
              <div className="product-grid">
                {products.map((p) => {
                  const isSelected = productId === p.id
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={`card product-card selectable ${isSelected ? 'selected' : ''}`}
                      disabled={!p.canCreateTrial}
                      onClick={() => setProductId(p.id)}
                      aria-pressed={isSelected}
                      style={{ textAlign: 'left', cursor: p.canCreateTrial ? 'pointer' : 'not-allowed' }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <h3 style={{ margin: '0 0 0.35rem 0' }}>{p.name}</h3>
                        {isSelected && (
                          <span
                            style={{
                              width: 22,
                              height: 22,
                              borderRadius: '50%',
                              background: 'var(--primary)',
                              color: '#fff',
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              flexShrink: 0,
                            }}
                          >
                            <Check size={14} />
                          </span>
                        )}
                      </div>
                      <div className="muted small" style={{ marginBottom: '0.75rem', lineHeight: '1.4' }}>
                        {p.description || 'Full-featured enterprise SaaS product.'}
                      </div>
                      <div className="price" style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '0.4rem' }}>
                        {formatMoney(p.monthlyPrice, p.currency)}{' '}
                        <span className="muted small" style={{ fontWeight: 400 }}>
                          / month after trial
                        </span>
                      </div>
                      <div className="small" style={{ color: p.canCreateTrial ? 'var(--primary-light)' : 'var(--muted)' }}>
                        {p.canCreateTrial ? trialLabel(p) : p.reason}
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {/* Selected Plan's Trial Terms Card */}
          {selectedProduct && (
            <div
              className="card"
              style={{
                background: 'rgba(37, 99, 235, 0.04)',
                border: '1px solid rgba(37, 99, 235, 0.2)',
                borderRadius: '12px',
                padding: '1.25rem',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', marginBottom: '0.75rem' }}>
                <ShieldCheck size={18} style={{ color: 'var(--primary-light)' }} />
                <strong style={{ color: 'var(--text-heading)' }}>
                  {selectedProduct.name} — Trial Terms &amp; Conditions
                </strong>
              </div>
              <ul style={{ margin: 0, paddingLeft: '1.25rem', color: 'var(--text-secondary)', fontSize: '0.88rem', lineHeight: '1.6' }}>
                <li>
                  <strong>{selectedProduct.trialDays ? `${selectedProduct.trialDays}-Day Free Trial` : 'Zero-Commitment Trial'}:</strong> Full access to all product modules and features from day one.
                </li>
                <li>
                  <strong>No Upfront Payment:</strong> Partner and shop owner incur zero charges during the trial period.
                </li>
                <li>
                  <strong>Direct Tenant Provisioning:</strong> Instant tenant provisioning with dedicated workspace and isolated customer database.
                </li>
                <li>
                  <strong>Seamless Upgrade:</strong> Convert to paid activation at any time using bank slip transfer verified by Hexalyte Admin without data loss.
                </li>
              </ul>
            </div>
          )}

          {formError && <div className="alert error">{formError}</div>}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '1.5rem' }}>
            <button
              className="btn secondary"
              type="button"
              onClick={() => setCurrentStep(1)}
              style={{ display: 'inline-flex', gap: '0.4rem', alignItems: 'center' }}
            >
              <ArrowLeft size={16} />
              <span>Back to Shop Details</span>
            </button>
            <button
              className="btn"
              type="button"
              onClick={runProvisioning}
              disabled={busy || !selectedProduct?.canCreateTrial}
              style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'center' }}
            >
              <span>Confirm &amp; Provision Tenant</span>
              <ArrowRight size={16} />
            </button>
          </div>
        </>
      )}

      {/* ══════════════════════════════════════════════════════════════════════════
          STEP 3: PROVISION TENANT
          Handles customer identity matching, creation/linkage, SaaS tenant provisioning,
          failure retry, and error presentation.
          ══════════════════════════════════════════════════════════════════════════ */}
      {currentStep === 3 && (
        <div className="card" style={{ textAlign: 'center', padding: '3rem 2rem' }}>
          {busy ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1.25rem' }}>
              <div
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: '50%',
                  border: '3px solid rgba(37, 99, 235, 0.2)',
                  borderTopColor: 'var(--primary)',
                  animation: 'spin 1s linear infinite',
                }}
              />
              <h2 style={{ margin: 0, fontSize: '1.4rem' }}>Provisioning SaaS Tenant…</h2>
              <p className="muted small" style={{ margin: 0, maxWidth: '440px', lineHeight: '1.5' }}>
                Connecting to {selectedProduct?.name || 'SaaS'} to configure shop records, verify customer mapping, and provision your genuine tenant.
              </p>

              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.5rem',
                  marginTop: '1rem',
                  textAlign: 'left',
                  background: 'var(--surface-hover)',
                  padding: '1rem 1.5rem',
                  borderRadius: '10px',
                  width: '100%',
                  maxWidth: '420px',
                  fontSize: '0.85rem',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--primary-light)' }}>
                  <Check size={14} />
                  <span>Matching / Linking customer record</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--primary-light)' }}>
                  <Check size={14} />
                  <span>Preparing customer account mapping</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--primary-light)' }}>
                  <RefreshCw size={14} className="spin" />
                  <span>Calling SaaS provisioning service…</span>
                </div>
              </div>
            </div>
          ) : formError ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1.25rem' }}>
              <div
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: '50%',
                  background: 'rgba(239, 68, 68, 0.12)',
                  color: 'var(--danger, #ef4444)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <AlertCircle size={32} />
              </div>
              <h2 style={{ margin: 0, fontSize: '1.4rem', color: 'var(--danger, #ef4444)' }}>
                Provisioning Failed
              </h2>
              <div
                className="alert error"
                style={{ maxWidth: '540px', width: '100%', textAlign: 'left', margin: 0 }}
              >
                {formError}
              </div>
              <p className="muted small" style={{ margin: 0, maxWidth: '480px' }}>
                No active tenant was created. Your shop details and plan selections have been preserved so you can safely retry or adjust your inputs.
              </p>

              <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem', flexWrap: 'wrap', justifyContent: 'center' }}>
                <button
                  className="btn secondary"
                  type="button"
                  onClick={() => setCurrentStep(1)}
                  style={{ display: 'inline-flex', gap: '0.4rem', alignItems: 'center' }}
                >
                  <ArrowLeft size={16} />
                  <span>Edit Shop Details</span>
                </button>
                <button
                  className="btn secondary"
                  type="button"
                  onClick={() => setCurrentStep(2)}
                  style={{ display: 'inline-flex', gap: '0.4rem', alignItems: 'center' }}
                >
                  <span>Change Plan</span>
                </button>
                <button
                  className="btn"
                  type="button"
                  onClick={runProvisioning}
                  style={{ display: 'inline-flex', gap: '0.4rem', alignItems: 'center' }}
                >
                  <RefreshCw size={16} />
                  <span>Retry Provisioning</span>
                </button>
              </div>
            </div>
          ) : null}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════════
          STEP 4: DONE
          Reuse existing SaaS onboarding completion design:
          - Tenant Onboarded confirmation only after actual provisioning success
          - Shop name and selected plan
          - Actual login URL and shop URL
          - Owner login details, handled securely
          - Welcome message preview
          - Copy Message and Send via WhatsApp actions
          ══════════════════════════════════════════════════════════════════════════ */}
      {currentStep === 4 && result && (
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {/* Tenant Onboarded / Trial Saved Confirmation Header */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.85rem',
              paddingBottom: '1.25rem',
              borderBottom: '1px solid var(--border)',
            }}
          >
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: '50%',
                background: result.outcome === 'PROVISIONED' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(245, 158, 11, 0.15)',
                color: result.outcome === 'PROVISIONED' ? '#10B981' : '#F59E0B',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              {result.outcome === 'PROVISIONED' ? <CheckCircle2 size={28} /> : <Cpu size={28} />}
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                <h2 style={{ margin: 0, fontSize: '1.45rem', color: 'var(--text-heading)' }}>
                  {result.outcome === 'PROVISIONED' ? 'Tenant Onboarded Successfully' : 'Trial Request Saved & Submitted'}
                </h2>
                <span className={result.outcome === 'PROVISIONED' ? 'badge sub-ACTIVE' : 'badge sub-PENDING'}>
                  {result.outcome === 'PROVISIONED' ? 'PROVISIONED & ACTIVE' : 'PENDING FULFILMENT'}
                </span>
              </div>
              <p className="muted small" style={{ margin: '0.2rem 0 0 0' }}>
                {result.outcome === 'PROVISIONED'
                  ? 'The trial tenant has been provisioned and linked to your partner account.'
                  : 'Customer and trial records are registered in Central Platform. SaaS tenant is awaiting fulfilment.'}
              </p>
            </div>
          </div>

          {/* Shop Name & Selected Plan Details Grid */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: '1rem',
              background: 'var(--surface-hover)',
              padding: '1.25rem',
              borderRadius: '10px',
            }}
          >
            <div>
              <div className="muted small">Customer ID</div>
              <strong className="mono" style={{ color: 'var(--primary-light)', fontSize: '1.05rem' }}>
                {result.provisioning?.customerCode || result.trial.customerAccount.customer.customerCode || '—'}
              </strong>
            </div>

            <div>
              <div className="muted small">Shop Name</div>
              <strong style={{ color: 'var(--text-heading)', fontSize: '1.05rem' }}>
                {result.provisioning?.shopName || shop.shopName}
              </strong>
            </div>

            <div>
              <div className="muted small">Selected Plan</div>
              <strong style={{ color: 'var(--text-heading)', fontSize: '1.05rem' }}>
                {selectedProduct?.name || result.trial.product.name}
              </strong>
            </div>

            <div>
              <div className="muted small">Trial Status</div>
              <span style={{ fontWeight: 600, color: result.outcome === 'PROVISIONED' ? '#10B981' : '#F59E0B' }}>
                {result.outcome === 'PROVISIONED' ? 'Active Trial (Provisioned)' : 'Pending Manual Fulfilment'}
              </span>
            </div>

            <div>
              <div className="muted small">External Tenant ID</div>
              <span className="mono" style={{ fontSize: '0.9rem', color: result.provisioning?.externalTenantId ? 'var(--primary-light)' : 'var(--muted)' }}>
                {result.provisioning?.externalTenantId || result.trial.customerAccount.externalTenantId || 'Pending SaaS Confirmation'}
              </span>
            </div>
          </div>

          {/* Provisioned Tenant Credentials & Actions */}
          {result.outcome === 'PROVISIONED' && (
            <>
              {/* Actual Login URL and Shop URL */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                  gap: '1rem',
                }}
              >
            <div
              style={{
                border: '1px solid var(--border)',
                borderRadius: '10px',
                padding: '1rem',
                background: 'var(--surface)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
                <span className="muted small" style={{ fontWeight: 600 }}>Login URL</span>
                <button
                  type="button"
                  className="btn secondary small"
                  style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem', gap: '0.25rem' }}
                  onClick={() => handleCopy(loginUrl, 'loginUrl')}
                >
                  {copiedKey === 'loginUrl' ? <Check size={12} /> : <Copy size={12} />}
                  <span>{copiedKey === 'loginUrl' ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <a
                  href={loginUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mono"
                  style={{
                    color: 'var(--primary-light)',
                    wordBreak: 'break-all',
                    fontSize: '0.88rem',
                    textDecoration: 'underline',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.3rem',
                  }}
                >
                  <span>{loginUrl}</span>
                  <ExternalLink size={12} />
                </a>
              </div>
            </div>

            <div
              style={{
                border: '1px solid var(--border)',
                borderRadius: '10px',
                padding: '1rem',
                background: 'var(--surface)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
                <span className="muted small" style={{ fontWeight: 600 }}>Storefront / Shop URL</span>
                <button
                  type="button"
                  className="btn secondary small"
                  style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem', gap: '0.25rem' }}
                  onClick={() => handleCopy(shopUrl, 'shopUrl')}
                >
                  {copiedKey === 'shopUrl' ? <Check size={12} /> : <Copy size={12} />}
                  <span>{copiedKey === 'shopUrl' ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <a
                  href={shopUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mono"
                  style={{
                    color: 'var(--primary-light)',
                    wordBreak: 'break-all',
                    fontSize: '0.88rem',
                    textDecoration: 'underline',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.3rem',
                  }}
                >
                  <span>{shopUrl}</span>
                  <ExternalLink size={12} />
                </a>
              </div>
            </div>
          </div>

          {/* Owner Login Details (Handled Securely) */}
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: '10px',
              padding: '1.25rem',
              background: 'rgba(37, 99, 235, 0.03)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
              <Key size={16} style={{ color: 'var(--primary-light)' }} />
              <strong style={{ color: 'var(--text-heading)' }}>Owner Login Credentials</strong>
            </div>

            <div className="grid-2" style={{ gap: '1rem' }}>
              <div>
                <div className="muted small">Owner Username / Email</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.2rem' }}>
                  <span className="mono" style={{ fontSize: '0.95rem' }}>{shop.email}</span>
                  <button
                    type="button"
                    className="btn secondary small"
                    style={{ padding: '0.15rem 0.4rem', fontSize: '0.75rem' }}
                    onClick={() => handleCopy(shop.email, 'email')}
                  >
                    {copiedKey === 'email' ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>

              <div>
                <div className="muted small">Temporary Password</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.2rem' }}>
                  <span className="mono" style={{ fontSize: '0.95rem' }}>
                    {showPassword ? shop.password : '••••••••••••'}
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowPassword((p) => !p)}
                    className="btn secondary small"
                    style={{ padding: '0.15rem 0.4rem', fontSize: '0.75rem' }}
                  >
                    {showPassword ? 'Hide' : 'Show'}
                  </button>
                  <button
                    type="button"
                    className="btn secondary small"
                    style={{ padding: '0.15rem 0.4rem', fontSize: '0.75rem' }}
                    onClick={() => handleCopy(shop.password || '', 'pwd')}
                  >
                    {copiedKey === 'pwd' ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Welcome Message Preview & Actions */}
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: '10px',
              padding: '1.25rem',
              background: 'var(--surface)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <MessageSquare size={16} style={{ color: '#10B981' }} />
                <strong style={{ color: 'var(--text-heading)' }}>Welcome Message Preview</strong>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  type="button"
                  className="btn secondary small"
                  onClick={() => handleCopy(welcomeMessage, 'msg')}
                  style={{ display: 'inline-flex', gap: '0.3rem', alignItems: 'center' }}
                >
                  {copiedKey === 'msg' ? <Check size={14} /> : <Copy size={14} />}
                  <span>{copiedKey === 'msg' ? 'Message Copied!' : 'Copy Message'}</span>
                </button>
                {whatsappLink ? (
                <a
                  href={whatsappLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn small"
                  style={{
                    display: 'inline-flex',
                    gap: '0.35rem',
                    alignItems: 'center',
                    background: '#25D366',
                    borderColor: '#25D366',
                    color: '#fff',
                  }}
                >
                  <MessageSquare size={14} />
                  <span>Send via WhatsApp</span>
                </a>
                ) : (
                  <span className="muted small">Enter a valid mobile number to enable WhatsApp.</span>
                )}
              </div>
            </div>

            <textarea
              readOnly
              rows={8}
              value={welcomeMessage}
              style={{
                width: '100%',
                fontSize: '0.85rem',
                fontFamily: 'inherit',
                lineHeight: '1.5',
                resize: 'none',
                background: 'var(--surface-hover)',
                color: 'var(--text)',
                borderRadius: '8px',
                padding: '0.75rem',
                border: '1px solid var(--border)',
              }}
            />
          </div>
        </>
      )}

      {/* Central Platform Saved / Manual Fulfilment Notice */}
      {result.outcome === 'SUBMITTED' && (
        <div
          style={{
            background: 'var(--surface-hover)',
            border: '1px solid var(--border)',
            borderRadius: '10px',
            padding: '1.25rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.65rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#F59E0B', fontWeight: 600, fontSize: '0.98rem' }}>
            <Cpu size={18} />
            <span>Central Platform Records Successfully Saved</span>
          </div>
          <p style={{ margin: 0, fontSize: '0.88rem', lineHeight: '1.5', color: 'var(--text)' }}>
            {result.message}
          </p>
          <p className="muted small" style={{ margin: 0, lineHeight: '1.5' }}>
            The customer record is now live in <strong>My Customers</strong> and this trial request has been recorded in <strong>Free Trials</strong>. Because this SaaS product is operating in manual fulfilment mode, external login credentials and tenant access URLs will appear once administrative fulfilment is confirmed.
          </p>
        </div>
      )}

      {/* Bottom Actions */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem', marginTop: '0.5rem' }}>
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <Link href="/customers" className="btn secondary">
                View in My Customers
              </Link>
              <Link href="/trials" className="btn secondary">
                View All Trials
              </Link>
            </div>
            <button
              className="btn"
              type="button"
              onClick={() => {
                setCurrentStep(1)
                setShop(emptyShopDetails)
                setResult(null)
                setFormError(null)
              }}
            >
              Provision Another Trial
            </button>
          </div>
        </div>
      )}
    </>
  )
}

export default function NewTrialPage() {
  return (
    <ResellerShell>
      {() => (
        <main className="container">
          {/* ── Compact Scenic Hero Banner (No KPIs on Creation Wizard Flow) ── */}
          <PageHero
            tag="TRIAL OPERATIONS"
            title="New Trial Account"
            subtitle="Register a client shop and provision an instant zero-commitment trial across Hexalyte SaaS products."
            icon={
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
              </svg>
            }
            actions={
              <Link
                href="/trials"
                className="btn secondary small"
                style={{ display: 'inline-flex', gap: '0.45rem', alignItems: 'center', fontWeight: 600 }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <line x1="19" y1="12" x2="5" y2="12" />
                  <polyline points="12 19 5 12 12 5" />
                </svg>
                <span>Back to Free Trials</span>
              </Link>
            }
          />

          {/* ── Centered, Proportional Wizard Layout ── */}
          <div style={{ maxWidth: '1000px', margin: '0 auto' }}>
            <Suspense fallback={<p className="muted">Loading trial form…</p>}>
              <NewTrialWizard />
            </Suspense>
          </div>
        </main>
      )}
    </ResellerShell>
  )
}
