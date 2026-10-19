'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { api, ApiError } from '@/lib/api'
import { formatMoney } from '@/lib/format'
import type { ResellerProduct } from '@/lib/product-types'
import type { CommissionLevel } from '@/lib/commission-types'
import { ResellerShell } from '@/components/ResellerShell'
import { PageHero } from '@/components/PageHero'

// ─── Product vertical metadata & features ─────────────────────────────────────

const PRODUCT_METADATA: Record<string, { industry: string; features: string[] }> = {
  FASHION_ERP: {
    industry: 'Apparel & Retail ERP',
    features: ['Barcode POS Billing', 'Size & Color Matrix', 'Multi-Branch Inventory Sync'],
  },
  MOBILE_SHOP: {
    industry: 'Mobile Retail & Repair POS',
    features: ['IMEI Serial Number Tracking', 'Repair Job Work-Orders', 'Warranty & Customer SMS'],
  },
  SALON: {
    industry: 'Salon & Spa Management',
    features: ['Appointment Scheduling', 'Stylist Commission Tracking', 'Client Packages & Loyalty'],
  },
  SUPERMARKET: {
    industry: 'Supermarket & Grocery POS',
    features: ['High-Speed Barcode Checkout', 'Weighing Scale Integration', 'Batch & Expiry Date Alerts'],
  },
}

// ─── Skeleton loader ─────────────────────────────────────────────────────────

function ProductCardSkeleton() {
  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: '1.5rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.85rem',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem' }}>
        <div style={{ display: 'flex', gap: '0.65rem', alignItems: 'center', flex: 1 }}>
          <div style={{ width: '44px', height: '44px', borderRadius: '12px', background: 'var(--surface-hover)', flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <div style={{ width: '70px', height: '12px', borderRadius: '6px', background: 'var(--surface-hover)', marginBottom: '6px' }} />
            <div style={{ width: '140px', height: '18px', borderRadius: '6px', background: 'var(--surface-hover)' }} />
          </div>
        </div>
        <div style={{ width: '80px', height: '22px', borderRadius: '9999px', background: 'var(--surface-hover)' }} />
      </div>
      <div style={{ width: '50%', height: '28px', borderRadius: '6px', background: 'var(--surface-hover)', margin: '0.5rem 0' }} />
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.85rem', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={{ width: '100%', height: '12px', borderRadius: '6px', background: 'var(--surface-hover)' }} />
        <div style={{ width: '85%', height: '12px', borderRadius: '6px', background: 'var(--surface-hover)' }} />
      </div>
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: '1rem', marginTop: 'auto', display: 'flex', gap: '0.65rem' }}>
        <div style={{ flex: 1, height: '36px', borderRadius: '9px', background: 'var(--surface-hover)' }} />
        <div style={{ flex: 1, height: '36px', borderRadius: '9px', background: 'var(--surface-hover)' }} />
      </div>
    </div>
  )
}

// ─── Product icon pill ────────────────────────────────────────────────────────

const ICON_PALETTES: [string, string][] = [
  ['rgba(99,102,241,0.18)', '#818cf8'],
  ['rgba(16,185,129,0.16)', '#34d399'],
  ['rgba(245,158,11,0.16)', '#fbbf24'],
  ['rgba(168,85,247,0.17)', '#c084fc'],
  ['rgba(6,182,212,0.16)', '#38bdf8'],
  ['rgba(239,68,68,0.15)', '#f87171'],
]

function ProductIconPill({ code }: { code: string }) {
  const [bg, fg] = ICON_PALETTES[code.charCodeAt(0) % ICON_PALETTES.length]
  return (
    <div
      aria-hidden
      style={{
        width: '44px',
        height: '44px',
        borderRadius: '12px',
        background: bg,
        border: `1px solid ${fg}44`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: fg,
        fontWeight: 800,
        fontSize: '1.1rem',
        flexShrink: 0,
        letterSpacing: '-0.02em',
        fontFamily: 'inherit',
      }}
    >
      {(code || '?')[0].toUpperCase()}
    </div>
  )
}

// ─── Commission rates (real values from the admin-managed levels) ─────────────

type RateRange = { min: number; max: number }

/** Lowest and highest rate across the commission levels; null when they are not available. */
function rateRangeOf(levels: CommissionLevel[] | null): RateRange | null {
  const rates = (levels ?? []).map((l) => Number(l.ratePercent)).filter((n) => Number.isFinite(n))
  return rates.length ? { min: Math.min(...rates), max: Math.max(...rates) } : null
}

const percentText = (r: RateRange) => (r.min === r.max ? `${r.min}%` : `${r.min}% – ${r.max}%`)

/** Same formula as the backend ledger: price × rate ÷ 100, to 2 decimals. */
const commissionAt = (price: number, rate: number) => Math.round(price * rate) / 100

// ─── Product card ─────────────────────────────────────────────────────────────

function ProductCard({
  product,
  canDemo,
  canActivate,
  rates,
}: {
  product: ResellerProduct
  canDemo: boolean
  canActivate: boolean
  rates: RateRange | null
}) {
  const { id, code, name, description, monthlyPrice, currency } = product
  // Marketing copy exists only for known product codes; nothing is invented for others
  const meta = PRODUCT_METADATA[code] || { industry: '', features: [] as string[] }

  const price = Number(monthlyPrice)
  const hasPrice = Number.isFinite(price) && price > 0

  // What one active customer on this product earns per month: price × the real commission rates
  let commissionText = '—'
  if (rates && hasPrice) {
    const low = formatMoney(commissionAt(price, rates.min), currency)
    const high = formatMoney(commissionAt(price, rates.max), currency)
    commissionText = `${percentText(rates)} (${rates.min === rates.max ? low : `${low} – ${high}`} /mo)`
  }

  return (
    <div className="product-card">
      {/* Top: icon + code */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.85rem', marginBottom: '0.85rem' }}>
        <ProductIconPill code={code} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap', marginBottom: '0.25rem' }}>
            <span className="mono small muted" style={{ fontWeight: 600 }}>{code}</span>
          </div>
          <h3 style={{ margin: 0, fontSize: '1.18rem', fontWeight: 700, color: 'var(--text-heading)', lineHeight: 1.25 }}>
            {name}
          </h3>
          {meta.industry && (
            <span style={{ fontSize: '0.74rem', color: 'var(--primary-light)', fontWeight: 600 }}>
              {meta.industry}
            </span>
          )}
        </div>
      </div>

      {/* Price & Earning Potential */}
      <div style={{ margin: '0.4rem 0 0.85rem' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.35rem' }}>
          <span
            style={{
              fontSize: '1.55rem',
              fontWeight: 800,
              color: 'var(--primary-light)',
              letterSpacing: '-0.03em',
              lineHeight: 1.1,
            }}
          >
            {formatMoney(monthlyPrice, currency)}
          </span>
          <span className="muted small">/ month</span>
        </div>

        {/* Partner Margin Pill */}
        {hasPrice && (
          <div
            className="product-commission-pill"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.35rem',
              marginTop: '0.45rem',
              padding: '0.22rem 0.6rem',
              borderRadius: '6px',
              fontSize: '0.72rem',
              fontWeight: 700,
              letterSpacing: '0.02em',
            }}
          >
            <span>Partner commission: {commissionText}</span>
          </div>
        )}
      </div>

      {/* Description */}
      <p
        className="muted small"
        style={{
          margin: '0 0 0.85rem',
          lineHeight: 1.55,
          color: 'var(--text-secondary)',
        }}
      >
        {description}
      </p>

      {/* Feature Capabilities */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginBottom: '1.25rem' }}>
        {meta.features.map((feat) => (
          <span key={feat} className="product-feature-tag">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--primary-light)' }} aria-hidden>
              <polyline points="20 6 9 17 4 12" />
            </svg>
            {feat}
          </span>
        ))}
      </div>

      {/* Divider */}
      <div style={{ borderTop: '1px solid var(--border)', margin: 'auto 0 1rem' }} />

      {/* Actions: Demo Request + Paid Activation only; equal-width buttons pinned to the card bottom */}
      {(canDemo || canActivate) && (
        <div className="product-card-actions">
          {canDemo && (
            <Link href={`/demo-requests/new?productId=${id}`} className="btn">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M3 9h18" />
                <path d="m9 15 2 2 4-4" />
              </svg>
              Request Demo
            </Link>
          )}

          {canActivate && (
            <Link href={`/activations/new?productId=${id}`} className="btn secondary">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
                <path d="m9 12 2 2 4-4" />
              </svg>
              Activate Paid
            </Link>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyProducts({ filtered }: { filtered: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '4rem 2rem',
        background: 'var(--surface)',
        borderRadius: 'var(--radius)',
        border: '1px dashed var(--border)',
        textAlign: 'center',
        gap: '0.85rem',
        animation: 'fadeIn 0.25s ease-out',
        marginBottom: '1.5rem',
      }}
    >
      <div
        style={{
          width: '50px',
          height: '50px',
          borderRadius: '14px',
          background: 'rgba(37, 99, 235, 0.12)',
          border: '1px solid rgba(37, 99, 235, 0.25)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--primary-light)',
        }}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="m7.5 4.27 9 5.15" />
          <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
          <path d="m3.3 7 8.7 5 8.7-5" />
          <path d="M12 22V12" />
        </svg>
      </div>
      <div>
        <strong style={{ color: 'var(--text-heading)', fontSize: '1.05rem', display: 'block', marginBottom: '0.3rem' }}>
          {filtered ? 'No products match your search' : 'No products in your catalogue'}
        </strong>
        <span style={{ color: 'var(--muted)', fontSize: '0.88rem' }}>
          {filtered
            ? 'Try a different search term or reset your filters.'
            : 'No SaaS products have been assigned to your partner account yet. Contact your Hexalyte administrator.'}
        </span>
      </div>
    </div>
  )
}

// ─── Main Products Page ───────────────────────────────────────────────────────

export default function ResellerProductsPage() {
  const [products, setProducts] = useState<ResellerProduct[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [search, setSearch] = useState('')
  // Commission levels (admin-editable). null = not loaded yet or unavailable, shown as "—", never a guess.
  const [levels, setLevels] = useState<CommissionLevel[] | null>(null)

  useEffect(() => {
    api<CommissionLevel[]>('/commissions/levels')
      .then((res) => setLevels(Array.isArray(res) ? res : null))
      .catch(() => setLevels(null))
  }, [])

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    api<ResellerProduct[]>('/products')
      .then((data) => active && setProducts(data))
      .catch((err) => active && setError(err instanceof ApiError ? err.message : 'Failed to load products'))
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [attempt])

  const filtered = useMemo(() => {
    let result = products
    const q = search.trim().toLowerCase()
    if (q) {
      result = result.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.code.toLowerCase().includes(q) ||
          (p.description ?? '').toLowerCase().includes(q) ||
          (PRODUCT_METADATA[p.code]?.industry ?? '').toLowerCase().includes(q),
      )
    }
    return result
  }, [products, search])

  const hasActiveFilters = Boolean(search.trim())
  // While the catalogue is awaited, and after a failed load, the product count is unknown: "—", never a made-up 0.
  const countUnknown = loading || Boolean(error)

  // Catalogue KPIs come from the real product prices and commission levels
  const rates = rateRangeOf(levels)
  const priced = products.filter((p) => Number(p.monthlyPrice) > 0)
  const prices = priced.map((p) => Number(p.monthlyPrice))
  const minPrice = prices.length ? Math.min(...prices) : null
  const singleCurrency = new Set(priced.map((p) => p.currency)).size === 1
  const pricesDiffer = prices.length > 1 && Math.max(...prices) !== Math.min(...prices)
  const subscriptionValue =
    loading || minPrice === null || !singleCurrency
      ? '—'
      : `${pricesDiffer ? 'From ' : ''}${formatMoney(minPrice, priced[0].currency)}`

  return (
    <ResellerShell>
      {(user) => {
        const canDemo = user.permissions.includes('demos:create')
        const canActivate = user.permissions.includes('activations:create')

        return (
          <main className="container">
            {/* ── Compact Scenic Hero Banner with Embedded Translucent KPIs ── */}
            <PageHero
              tag="CATALOGUE"
              title="SaaS Products"
              subtitle="Explore the Hexalyte SaaS suite available in your partner catalogue. Request a demo for a prospect or submit verified paid activations."
              icon={
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m7.5 4.27 9 5.15" />
                  <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
                  <path d="m3.3 7 8.7 5 8.7-5" />
                  <path d="M12 22V12" />
                </svg>
              }
              actions={
                <>
                  {canDemo && (
                    <Link href="/demo-requests/new" className="btn small" style={{ display: 'inline-flex', gap: '0.4rem', alignItems: 'center', fontWeight: 600 }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <rect x="3" y="4" width="18" height="16" rx="2" />
                        <path d="M3 9h18" />
                        <path d="m9 15 2 2 4-4" />
                      </svg>
                      <span>New Demo Request</span>
                    </Link>
                  )}
                  {canActivate && (
                    <Link href="/activations/new" className="btn secondary small" style={{ display: 'inline-flex', gap: '0.4rem', alignItems: 'center', fontWeight: 600 }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
                        <path d="m9 12 2 2 4-4" />
                      </svg>
                      <span>New Activation</span>
                    </Link>
                  )}
                </>
              }
            >
              {/* ── 4 Catalogue Overview KPI Cards (Glass over Scenic Background) ── */}
              <div className="kpi-grid" data-count={3}>
                {/* Card 1: Catalogue Solutions */}
                <div className="card kpi-ref">
                  <div className="kpi-ref-top">
                    <span className="kpi-ref-label">Active Solutions</span>
                    <div className="kpi-ref-icon indigo">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="m7.5 4.27 9 5.15" />
                        <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
                        <path d="m3.3 7 8.7 5 8.7-5" />
                        <path d="M12 22V12" />
                      </svg>
                    </div>
                  </div>
                  <div className="kpi-ref-main">
                    <div className="kpi-ref-value">{countUnknown ? '—' : `${products.length} Products`}</div>
                  </div>
                  <div className="kpi-ref-footer">
                    <span className="kpi-ref-badge positive">Production</span>
                    <span className="kpi-ref-desc">Cloud vertical ERP suites</span>
                  </div>
                </div>

                {/* Card 2: Base Subscription Rate */}
                <div className="card kpi-ref">
                  <div className="kpi-ref-top">
                    <span className="kpi-ref-label">Subscription Rate</span>
                    <div className="kpi-ref-icon emerald">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <line x1="12" y1="1" x2="12" y2="23" />
                        <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                      </svg>
                    </div>
                  </div>
                  <div className="kpi-ref-main">
                    <div className="kpi-ref-value">{subscriptionValue}</div>
                  </div>
                  <div className="kpi-ref-footer">
                    <span className="kpi-ref-badge neutral">Per month</span>
                    <span className="kpi-ref-desc">{pricesDiffer ? 'Varies by product' : 'Billed monthly'}</span>
                  </div>
                </div>

                {/* Card 3: Partner Margin */}
                <div className="card kpi-ref">
                  <div className="kpi-ref-top">
                    <span className="kpi-ref-label">Partner Margin</span>
                    <div className="kpi-ref-icon violet">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
                        <polyline points="16 7 22 7 22 13" />
                      </svg>
                    </div>
                  </div>
                  <div className="kpi-ref-main">
                    <div className="kpi-ref-value">{rates ? percentText(rates) : '—'}</div>
                  </div>
                  <div className="kpi-ref-footer">
                    <span className="kpi-ref-badge positive">Recurring</span>
                    <span className="kpi-ref-desc">{rates ? 'Monthly commission payout' : 'Rates unavailable'}</span>
                  </div>
                </div>
              </div>
            </PageHero>

            {/* ── Balanced Search & Filter Toolbar ── */}
            <div className="filter-bar">
              <div className="field inline search-field">
                <label htmlFor="prod-search">Search</label>
                <div className="filter-search-wrap">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ position: 'absolute', left: '0.75rem', color: 'var(--text-secondary)', pointerEvents: 'none', zIndex: 1 }}
                    aria-hidden="true"
                  >
                    <circle cx="11" cy="11" r="8" />
                    <path d="m21 21-4.35-4.35" />
                  </svg>
                  <input
                    id="prod-search"
                    type="text"
                    placeholder="Search by product name, code or industry vertical…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
              </div>

              <div className="filter-actions">
                {hasActiveFilters && (
                  <button
                    type="button"
                    className="btn link small"
                    onClick={() => setSearch('')}
                    style={{ padding: '0.4rem 0.5rem', whiteSpace: 'nowrap' }}
                  >
                    Clear filters
                  </button>
                )}
                {!countUnknown && (
                  <span className="small muted" style={{ whiteSpace: 'nowrap' }}>
                    Showing {filtered.length} of {products.length} products
                  </span>
                )}
              </div>
            </div>

            {/* ── Error state ── */}
            {error && (
              <div className="alert error" role="alert" style={{ marginBottom: '1.25rem' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <span>{error}</span>
                <button type="button" className="btn secondary small" onClick={() => setAttempt((n) => n + 1)} disabled={loading}>
                  Retry
                </button>
              </div>
            )}

            {/* ── Loading skeletons ── */}
            {loading && (
              <div className="product-grid">
                {Array.from({ length: 3 }).map((_, i) => (
                  <ProductCardSkeleton key={i} />
                ))}
              </div>
            )}

            {/* ── Enhanced Product Grid ── */}
            {!loading && !error && (
              filtered.length === 0 ? (
                <EmptyProducts filtered={hasActiveFilters} />
              ) : (
                <div className="product-grid">
                  {filtered.map((p) => (
                    <ProductCard key={p.id} product={p} canDemo={canDemo} canActivate={canActivate} rates={rates} />
                  ))}
                </div>
              )
            )}
          </main>
        )
      }}
    </ResellerShell>
  )
}
