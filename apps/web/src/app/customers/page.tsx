'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { api, apiRequest, ApiError } from '@/lib/api'
import { formatMoney } from '@/lib/format'
import { ACCOUNT_STATUS_LABELS, type AccountStatus } from '@/lib/dashboard-types'
import type { ResellerProduct } from '@/lib/product-types'
import { ResellerShell } from '@/components/ResellerShell'
import { PageHero } from '@/components/PageHero'
import { KpiGrid, KpiRefCard } from '@/components/ui/KpiRefCard'
import { Pagination } from '@/components/ui/Pagination'
import { Modal } from '@/components/ui/Modal'

// ─── Types ────────────────────────────────────────────────────────────────────

interface CustomerTrialRequestSummary {
  id: string
  status: 'PENDING' | 'SUBMITTED' | 'PROVISIONED' | 'FAILED' | 'CANCELLED'
  errorMessage: string | null
  errorRetryable: boolean | null
  attempts: number
  createdAt: string
}

interface CustomerActivationRequestSummary {
  id: string
  reference: string
  status: 'PENDING_REVIEW' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' | 'APPLIED' | 'CANCELLED'
  submittedAt: string
}

interface CustomerAccountSummary {
  id: string
  status: AccountStatus
  externalTenantId: string | null
  product: {
    id: string
    code: string
    name: string
    monthlyPrice: string
    currency: string
  }
  trialRequests?: CustomerTrialRequestSummary[]
  activationRequests?: CustomerActivationRequestSummary[]
}

interface CustomerItem {
  id: string
  customerCode?: string | null
  displayName: string
  accounts: CustomerAccountSummary[]
}

interface PaginationMeta {
  total: number
  page: number
  limit: number
  totalPages: number
  /** Account counts computed by the server for the current search/product scope (not just this page). */
  pipelineCounts?: { active: number; trial: number; inReview: number }
}

interface FlatCustomerRow {
  customer: CustomerItem
  account: CustomerAccountSummary | null
  state: ReturnType<typeof getAccountDisplayState>
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Maps AccountStatus to the correct badge CSS class used in globals.css */
function accountBadgeClass(status: AccountStatus): string {
  switch (status) {
    case 'ACTIVE':      return 'badge sub-ACTIVE'
    case 'TRIAL':       return 'badge sub-TRIAL'
    case 'PENDING':     return 'badge sub-PENDING'
    case 'SUSPENDED':   return 'badge sub-SUSPENDED'
    case 'CANCELLED':   return 'badge sub-CANCELLED'
    default:            return 'badge SUSPENDED'
  }
}

function getAccountDisplayState(a: CustomerAccountSummary | null) {
  if (!a) {
    return {
      label: 'Pending Setup',
      badgeClass: 'badge sub-PENDING',
      kind: 'PENDING_SETUP' as const,
      hasOpenActivation: false,
      trial: undefined,
      activation: undefined,
    }
  }

  const latestTrial = a.trialRequests?.[0]
  const latestActivation = a.activationRequests?.[0]
  const hasOpenActivation = Boolean(
    latestActivation && ['PENDING_REVIEW', 'UNDER_REVIEW', 'APPROVED'].includes(latestActivation.status)
  )

  if (a.status === 'ACTIVE') {
    return {
      label: 'Active (Paid)',
      badgeClass: 'badge sub-ACTIVE',
      kind: 'ACTIVE' as const,
      hasOpenActivation: false,
      trial: latestTrial,
      activation: latestActivation,
    }
  }

  if (hasOpenActivation) {
    return {
      label: 'Activation in Review',
      badgeClass: 'badge sub-PENDING',
      kind: 'ACTIVATION_REVIEW' as const,
      hasOpenActivation: true,
      trial: latestTrial,
      activation: latestActivation,
    }
  }

  if (a.status === 'TRIAL') {
    return {
      label: 'Trial',
      badgeClass: 'badge sub-TRIAL',
      kind: 'TRIAL' as const,
      hasOpenActivation: false,
      trial: latestTrial,
      activation: latestActivation,
    }
  }

  if (a.status === 'PENDING') {
    if (latestTrial && (latestTrial.status === 'SUBMITTED' || latestTrial.status === 'PENDING')) {
      return {
        label: 'Setting Up',
        badgeClass: 'badge sub-PENDING',
        kind: 'TRIAL_PENDING' as const,
        hasOpenActivation: false,
        trial: latestTrial,
        activation: latestActivation,
      }
    }
    if (latestTrial && latestTrial.status === 'FAILED') {
      return {
        label: 'Provisioning Failed',
        badgeClass: 'badge sub-CANCELLED',
        kind: 'TRIAL_FAILED' as const,
        hasOpenActivation: false,
        trial: latestTrial,
        activation: latestActivation,
      }
    }
    return {
      label: 'Pending Setup',
      badgeClass: 'badge sub-PENDING',
      kind: 'PENDING_SETUP' as const,
      hasOpenActivation: false,
      trial: latestTrial,
      activation: latestActivation,
    }
  }

  return {
    label: ACCOUNT_STATUS_LABELS[a.status] || a.status,
    badgeClass: accountBadgeClass(a.status),
    kind: a.status,
    hasOpenActivation: false,
    trial: latestTrial,
    activation: latestActivation,
  }
}

/** Derive a deterministic accent colour for the customer avatar from their name. */
const AVATAR_PALETTES: [string, string][] = [
  ['rgba(99,102,241,0.18)', '#818cf8'],
  ['rgba(16,185,129,0.16)', '#34d399'],
  ['rgba(245,158,11,0.16)', '#fbbf24'],
  ['rgba(168,85,247,0.17)', '#c084fc'],
  ['rgba(6,182,212,0.16)', '#38bdf8'],
  ['rgba(239,68,68,0.15)', '#f87171'],
]

function CustomerAvatar({ name }: { name: string }) {
  const letter = (name || '?').trim()[0].toUpperCase()
  const code = name.charCodeAt(0)
  const [bg, fg] = AVATAR_PALETTES[code % AVATAR_PALETTES.length]
  return (
    <div
      aria-hidden
      style={{
        width: '36px',
        height: '36px',
        borderRadius: '9px',
        background: bg,
        border: `1px solid ${fg}44`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: fg,
        fontWeight: 800,
        fontSize: '0.9rem',
        flexShrink: 0,
        fontFamily: 'inherit',
      }}
    >
      {letter}
    </div>
  )
}

function ProductIcon({ code }: { code: string }) {
  const letter = (code || 'P')[0].toUpperCase()
  return (
    <div
      aria-hidden
      style={{
        width: '28px',
        height: '28px',
        borderRadius: '7px',
        background: 'rgba(99, 102, 241, 0.14)',
        border: '1px solid rgba(99, 102, 241, 0.28)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--primary-light)',
        fontWeight: 700,
        fontSize: '0.75rem',
        flexShrink: 0,
      }}
    >
      {letter}
    </div>
  )
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = (e: React.MouseEvent) => {
    e.stopPropagation()
    navigator.clipboard?.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button
      type="button"
      onClick={copy}
      title={copied ? 'Copied to clipboard!' : label}
      style={{
        background: 'none',
        border: 'none',
        padding: '2px 4px',
        cursor: 'pointer',
        color: copied ? '#10b981' : 'var(--muted)',
        display: 'inline-flex',
        alignItems: 'center',
        fontSize: '0.72rem',
        borderRadius: '4px',
        transition: 'color 0.15s ease',
      }}
    >
      {copied ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  )
}

// ─── Skeleton rows ────────────────────────────────────────────────────────────

function SkeletonRow() {
  return (
    <tr style={{ animation: 'pulse 1.6s ease-in-out infinite' }}>
      <td style={{ paddingLeft: '1.25rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
          <div style={{ width: '36px', height: '36px', borderRadius: '9px', background: 'var(--surface-hover)', flexShrink: 0 }} />
          <div>
            <div style={{ width: '130px', height: '13px', borderRadius: '5px', background: 'var(--surface-hover)', marginBottom: '6px' }} />
            <div style={{ width: '80px', height: '11px', borderRadius: '5px', background: 'var(--surface-hover)' }} />
          </div>
        </div>
      </td>
      <td>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <div style={{ width: '28px', height: '28px', borderRadius: '7px', background: 'var(--surface-hover)', flexShrink: 0 }} />
          <div>
            <div style={{ width: '130px', height: '13px', borderRadius: '5px', background: 'var(--surface-hover)', marginBottom: '6px' }} />
            <div style={{ width: '70px', height: '10px', borderRadius: '5px', background: 'var(--surface-hover)' }} />
          </div>
        </div>
      </td>
      <td>
        <div style={{ width: '100px', height: '22px', borderRadius: '9999px', background: 'var(--surface-hover)' }} />
      </td>
      <td className="nowrap">
        <div style={{ width: '85px', height: '14px', borderRadius: '5px', background: 'var(--surface-hover)' }} />
      </td>
      <td style={{ textAlign: 'right', paddingRight: '1.25rem' }}>
        <div style={{ display: 'inline-flex', justifyContent: 'flex-end' }}>
          <div style={{ width: '88px', height: '30px', borderRadius: '8px', background: 'var(--surface-hover)' }} />
        </div>
      </td>
    </tr>
  )
}

// ─── Main Page Component ──────────────────────────────────────────────────────

export default function ResellerCustomersPage() {
  const [customers, setCustomers] = useState<CustomerItem[]>([])
  const [products, setProducts] = useState<ResellerProduct[]>([])
  const [meta, setMeta] = useState<PaginationMeta | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [productFilter, setProductFilter] = useState<string>('')
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  // Account details modal state
  const [selectedAccountModal, setSelectedAccountModal] = useState<{
    customer: CustomerItem
    account: CustomerAccountSummary
  } | null>(null)

  useEffect(() => {
    api<ResellerProduct[]>('/products')
      .then((data) => {
        if (Array.isArray(data)) setProducts(data)
      })
      .catch(() => {})
  }, [])

  // Changing a filter always returns to the first page of the new result set
  function applyStatus(value: string) {
    setStatusFilter(value)
    setPage(1)
  }
  function applyProduct(value: string) {
    setProductFilter(value)
    setPage(1)
  }

  // Debounce search input — wait 350 ms after last keystroke before fetching
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [debouncedSearch, setDebouncedSearch] = useState('')

  function handleSearchChange(value: string) {
    setSearch(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setPage(1)
      setDebouncedSearch(value)
    }, 350)
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const params = new URLSearchParams()
    if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim())
    if (statusFilter) params.set('status', statusFilter)
    if (productFilter) params.set('productId', productFilter)
    params.set('page', String(page))
    params.set('limit', '50')
    apiRequest<CustomerItem[]>(`/customers?${params.toString()}`)
      .then((envelope) => {
        if (!cancelled) {
          setCustomers(envelope.data)
          setMeta(envelope.meta ?? null)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          // Nothing from an earlier answer is left next to the error; the alert offers Retry.
          setCustomers([])
          setMeta(null)
          setError(err instanceof ApiError ? err.message : 'Failed to load customers')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [debouncedSearch, statusFilter, productFilter, page, attempt])

  // Flatten customers into account rows
  const allRows: FlatCustomerRow[] = useMemo(() => {
    return customers.flatMap((c): FlatCustomerRow[] => {
      if (c.accounts.length === 0) {
        return [
          {
            customer: c,
            account: null,
            state: getAccountDisplayState(null),
          },
        ]
      }
      return c.accounts.map((a) => ({
        customer: c,
        account: a,
        state: getAccountDisplayState(a),
      }))
    })
  }, [customers])

  // KPI counts come from the server (whole result set for the current search/product), never from just this page
  const totalPortfoliosCount = meta?.total ?? 0
  const activePaidCount = meta?.pipelineCounts?.active ?? 0
  const trialCustomersCount = meta?.pipelineCounts?.trial ?? 0
  const inReviewCount = meta?.pipelineCounts?.inReview ?? 0

  // Rows are already filtered by the server (status / product), so nothing is filtered again here
  const filteredRows = allRows

  const hasActiveFilters = Boolean(debouncedSearch.trim() || statusFilter || productFilter)
  // While the first answer is awaited, and after a failed load, the counts are unknown: "—", never a made-up 0.
  const kpiUnknown = Boolean(error) || (loading && customers.length === 0)

  function resetFilters() {
    setSearch('')
    setDebouncedSearch('')
    setStatusFilter('')
    setProductFilter('')
    setPage(1)
  }

  return (
    <ResellerShell>
      {(user) => {
        const canDemo = user.permissions.includes('demos:create')
        const canActivate = user.permissions.includes('activations:create')

        return (
          <main className="container">
            {/* ── Compact Scenic Hero Banner with Embedded Translucent KPIs ── */}
            <PageHero
              tag="CLIENT PORTFOLIO"
              title="My Customers"
              subtitle="All business customer portfolios registered under your partner account and their active SaaS subscriptions."
              icon={
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
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
              {/* ── 4 Customer Portfolio KPI Summary Cards (Glass over Scenic Background) ── */}
              <KpiGrid count={4}>
                <KpiRefCard
                  label="Total Portfolios"
                  value={kpiUnknown ? '—' : totalPortfoliosCount}
                  badge="Customers"
                  desc="Registered client businesses"
                  accent="indigo"
                  active={statusFilter === '' && productFilter === ''}
                  onClick={() => {
                    applyStatus('')
                    applyProduct('')
                  }}
                  title="Show all customer portfolios"
                  icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>}
                />
                <KpiRefCard
                  label="Active (Paid)"
                  value={kpiUnknown ? '—' : activePaidCount}
                  badge="Subscriptions"
                  badgeTone="positive"
                  desc="Paid, active SaaS accounts"
                  accent="emerald"
                  active={statusFilter === 'ACTIVE'}
                  onClick={() => applyStatus(statusFilter === 'ACTIVE' ? '' : 'ACTIVE')}
                  title="Filter by Active (Paid) subscriptions"
                  icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>}
                />
                <KpiRefCard
                  label="Trial Customers"
                  value={kpiUnknown ? '—' : trialCustomersCount}
                  badge="Trial"
                  desc="Ready to activate on a paid plan"
                  accent="amber"
                  active={statusFilter === 'TRIAL'}
                  onClick={() => applyStatus(statusFilter === 'TRIAL' ? '' : 'TRIAL')}
                  title="Filter by trial customers"
                  icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>}
                />
                <KpiRefCard
                  label="In Review"
                  value={kpiUnknown ? '—' : inReviewCount}
                  badge="Verification"
                  desc="Payment review in progress"
                  accent="violet"
                  active={statusFilter === 'ACTIVATION_REVIEW'}
                  onClick={() => applyStatus(statusFilter === 'ACTIVATION_REVIEW' ? '' : 'ACTIVATION_REVIEW')}
                  title="Filter by activations in review"
                  icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>}
                />
              </KpiGrid>
            </PageHero>

            {/* ── Balanced Search & Filter Toolbar ── */}
            <div className="filter-bar">
              {/* Search Field */}
              <div className="field inline search-field">
                <label htmlFor="customer-search">Search</label>
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
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <input
                    id="customer-search"
                    type="search"
                    placeholder="Search by customer name, code or shop…"
                    value={search}
                    onChange={(e) => handleSearchChange(e.target.value)}
                    aria-label="Search customers"
                  />
                  {loading && (
                    <div style={{ position: 'absolute', right: '0.75rem', display: 'flex', alignItems: 'center' }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: 'spin 0.8s linear infinite', color: 'var(--muted)' }}>
                        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                      </svg>
                    </div>
                  )}
                </div>
              </div>

              {/* Status Filter */}
              <div className="field inline">
                <label htmlFor="customer-status-filter">Status</label>
                <select
                  id="customer-status-filter"
                  value={statusFilter}
                  onChange={(e) => applyStatus(e.target.value)}
                  aria-label="Filter by subscription status"
                >
                  <option value="">All Statuses</option>
                  <option value="ACTIVE">Active (Paid)</option>
                  <option value="TRIAL">Trial</option>
                  <option value="ACTIVATION_REVIEW">Activation in Review</option>
                  <option value="PENDING_SETUP">Pending Setup</option>
                  <option value="TRIAL_FAILED">Provisioning Failed</option>
                </select>
              </div>

              {/* SaaS Product Filter */}
              <div className="field inline">
                <label htmlFor="customer-product-filter">SaaS Product</label>
                <select
                  id="customer-product-filter"
                  value={productFilter}
                  onChange={(e) => applyProduct(e.target.value)}
                  aria-label="Filter by SaaS product"
                >
                  <option value="">All Products</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Filter Actions */}
              <div className="filter-actions">
                {hasActiveFilters && (
                  <button
                    type="button"
                    onClick={resetFilters}
                    className="btn link small"
                    style={{ fontSize: '0.82rem', padding: '0 0.35rem' }}
                  >
                    Reset Filters
                  </button>
                )}
                {!error && (
                  <span className="muted small" style={{ whiteSpace: 'nowrap', fontWeight: 500 }}>
                    Showing {filteredRows.length} account{filteredRows.length === 1 ? '' : 's'} on this page
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

            {/* ── Table Card ── */}
            {!error && (
              <div
                style={{
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)',
                  overflow: 'hidden',
                  boxShadow: 'var(--shadow)',
                }}
              >
                {/* Table scroll wrapper */}
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ minWidth: '720px' }}>
                    <thead>
                      <tr>
                        <th style={{ paddingLeft: '1.25rem' }}>Customer</th>
                        <th>Product</th>
                        <th>Status</th>
                        <th className="nowrap">Monthly Value</th>
                        <th className="sticky-actions" style={{ textAlign: 'right', paddingRight: '1.25rem' }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {/* Skeleton rows while loading initial data */}
                      {loading && customers.length === 0 && (
                        Array.from({ length: 5 }).map((_, i) => <SkeletonRow key={i} />)
                      )}

                      {/* Actual Rows */}
                      {!loading &&
                        filteredRows.map(({ customer: c, account: a, state }) => {
                          const rowKey = a ? `${c.id}-${a.id}` : `${c.id}-unlinked`

                          return (
                            <tr key={rowKey}>
                              {/* 1. Customer */}
                              <td style={{ paddingLeft: '1.25rem' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                                  <CustomerAvatar name={c.displayName} />
                                  <div style={{ minWidth: 0 }}>
                                    <div
                                      style={{
                                        fontWeight: 700,
                                        color: 'var(--text-heading)',
                                        fontSize: '0.92rem',
                                        whiteSpace: 'nowrap',
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        maxWidth: '190px',
                                      }}
                                    >
                                      {c.displayName}
                                    </div>
                                    <div
                                      className="mono small"
                                      style={{
                                        fontSize: '0.72rem',
                                        marginTop: '0.15rem',
                                        color: 'var(--primary-light)',
                                        fontWeight: 600,
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: '0.25rem',
                                      }}
                                    >
                                      <span>{c.customerCode || `${c.id.slice(0, 8)}…`}</span>
                                    </div>
                                  </div>
                                </div>
                              </td>

                              {/* 2. Product */}
                              <td>
                                {a ? (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                                    <ProductIcon code={a.product.code} />
                                    <div style={{ minWidth: 0 }}>
                                      <div style={{ fontWeight: 600, color: 'var(--text-heading)', fontSize: '0.88rem' }}>
                                        {a.product.name}
                                      </div>
                                      {a.externalTenantId ? (
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', marginTop: '0.15rem' }}>
                                          <span
                                            className="mono muted small"
                                            style={{ fontSize: '0.72rem' }}
                                            title={`Tenant ID: ${a.externalTenantId}`}
                                          >
                                            {a.externalTenantId.length > 22
                                              ? `${a.externalTenantId.slice(0, 22)}…`
                                              : a.externalTenantId}
                                          </span>
                                          <CopyButton text={a.externalTenantId} label="Copy tenant reference" />
                                        </div>
                                      ) : (
                                        <div className="mono muted small" style={{ fontSize: '0.72rem', marginTop: '0.15rem' }}>
                                          {a.product.code}
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                ) : (
                                  <span className="muted small">—</span>
                                )}
                              </td>

                              {/* 3. Status */}
                              <td>
                                <span className={state.badgeClass} style={{ fontSize: '0.72rem', whiteSpace: 'nowrap' }}>
                                  {state.label}
                                </span>
                              </td>

                              {/* 4. Monthly Value */}
                              <td className="nowrap">
                                {a ? (
                                  <span style={{ fontWeight: 700, color: 'var(--text-heading)', fontSize: '0.9rem' }}>
                                    {formatMoney(a.product.monthlyPrice, a.product.currency)}
                                    <span className="muted small" style={{ fontWeight: 400, marginLeft: '0.25rem' }}>/mo</span>
                                  </span>
                                ) : (
                                  <span className="muted small">—</span>
                                )}
                              </td>

                              {/* 5. Actions */}
                              <td className="sticky-actions" style={{ textAlign: 'right', paddingRight: '1.25rem', whiteSpace: 'nowrap' }}>
                                {/* Active (Paid): View Account */}
                                {a && state.kind === 'ACTIVE' && (
                                  <button
                                    type="button"
                                    className="btn secondary small"
                                    onClick={() => setSelectedAccountModal({ customer: c, account: a })}
                                    title="View customer account and tenant details"
                                  >
                                    View Account
                                  </button>
                                )}

                                {/* Trial customer: Activate opens the existing Paid Activation request flow */}
                                {a && state.kind === 'TRIAL' && (
                                  canActivate ? (
                                    <Link
                                      href={`/activations/new?customerId=${c.id}&productId=${a.product.id}`}
                                      className="btn small"
                                      title="Activate paid subscription"
                                    >
                                      Activate
                                    </Link>
                                  ) : null
                                )}

                                {/* Activation in Review: Check Status */}
                                {a && state.kind === 'ACTIVATION_REVIEW' && state.activation && (
                                  <Link
                                    href={`/activations/${state.activation.id}`}
                                    className="btn secondary small"
                                    title={`Check status for activation ${state.activation.reference}`}
                                  >
                                    Check Status
                                  </Link>
                                )}

                                {/* Setting Up / Pending Setup / Provisioning Failed: handled by Hexalyte, no seller action */}
                                {(!a || state.kind === 'PENDING_SETUP' || state.kind === 'TRIAL_PENDING' || state.kind === 'TRIAL_FAILED') && (
                                  <span className="muted small">—</span>
                                )}

                                {/* Fallback for other states (e.g., SUSPENDED, CANCELLED): View Account */}
                                {a && ['SUSPENDED', 'CANCELLED'].includes(state.kind) && (
                                  <button
                                    type="button"
                                    className="btn secondary small"
                                    onClick={() => setSelectedAccountModal({ customer: c, account: a })}
                                    title="View customer account details"
                                  >
                                    View Account
                                  </button>
                                )}
                              </td>
                            </tr>
                          )
                        })}
                    </tbody>
                  </table>
                </div>

                {/* Empty state inside table card */}
                {!loading && filteredRows.length === 0 && (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: '3.5rem 2rem',
                      textAlign: 'center',
                      gap: '0.85rem',
                      animation: 'fadeIn 0.25s ease-out',
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
                        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                        <circle cx="9" cy="7" r="4" />
                        <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                      </svg>
                    </div>
                    <div>
                      <strong style={{ color: 'var(--text-heading)', fontSize: '1.05rem', display: 'block', marginBottom: '0.3rem' }}>
                        {hasActiveFilters ? 'No customer accounts match your filters' : 'No customers yet'}
                      </strong>
                      <span style={{ color: 'var(--muted)', fontSize: '0.88rem' }}>
                        {hasActiveFilters
                          ? 'Try adjusting your search criteria or resetting the active filters.'
                          : 'Customers appear here once a demo request you submitted is confirmed.'}
                      </span>
                    </div>
                    {hasActiveFilters ? (
                      <button type="button" onClick={resetFilters} className="btn secondary small" style={{ marginTop: '0.25rem' }}>
                        Clear Filters
                      </button>
                    ) : (
                      canDemo && (
                        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem', flexWrap: 'wrap', justifyContent: 'center' }}>
                          <Link href="/demo-requests/new" className="btn small">
                            New Demo Request
                          </Link>
                        </div>
                      )
                    )}
                  </div>
                )}

                {/* Pagination footer */}
                {meta && !loading && (
                  <Pagination meta={meta} onPage={(p) => setPage(p)} noun="customer portfolios" busy={loading} />
                )}
              </div>
            )}

            {/* ── View Customer Account Details Modal ── */}
            {selectedAccountModal && (
              <Modal label={`${selectedAccountModal.customer.displayName} account details`} onClose={() => setSelectedAccountModal(null)}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.15rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <CustomerAvatar name={selectedAccountModal.customer.displayName} />
                      <div>
                        <h2 id="account-detail-title" style={{ margin: 0, fontSize: '1.2rem', color: 'var(--text-heading)' }}>
                          {selectedAccountModal.customer.displayName}
                        </h2>
                        <p className="muted small" style={{ margin: '0.15rem 0 0' }}>
                          {selectedAccountModal.account.product.name} Subscription Portfolio
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn secondary small"
                      style={{ padding: '0.3rem 0.55rem', minWidth: 'auto', border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '1.1rem' }}
                      onClick={() => setSelectedAccountModal(null)}
                      aria-label="Close dialog"
                    >
                      ✕
                    </button>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', fontSize: '0.88rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
                      <span className="muted">Customer ID</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        <span className="mono" style={{ fontWeight: 600, color: 'var(--primary-light)' }}>
                          {selectedAccountModal.customer.customerCode || selectedAccountModal.customer.id}
                        </span>
                        <CopyButton text={selectedAccountModal.customer.customerCode || selectedAccountModal.customer.id} label="Copy Customer ID" />
                      </div>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
                      <span className="muted">Business Name</span>
                      <span style={{ fontWeight: 600, color: 'var(--text-heading)' }}>{selectedAccountModal.customer.displayName}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
                      <span className="muted">SaaS Product</span>
                      <span style={{ fontWeight: 600, color: 'var(--text-heading)' }}>
                        {selectedAccountModal.account.product.name} ({selectedAccountModal.account.product.code})
                      </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
                      <span className="muted">Account Status</span>
                      <span className={accountBadgeClass(selectedAccountModal.account.status)}>
                        {selectedAccountModal.account.status === 'ACTIVE' ? 'Active (Paid)' : ACCOUNT_STATUS_LABELS[selectedAccountModal.account.status]}
                      </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
                      <span className="muted">SaaS Tenant Reference</span>
                      {selectedAccountModal.account.externalTenantId ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                          <span className="mono" style={{ fontWeight: 600, color: 'var(--text-heading)' }}>
                            {selectedAccountModal.account.externalTenantId}
                          </span>
                          <CopyButton text={selectedAccountModal.account.externalTenantId} label="Copy Tenant Reference" />
                        </div>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
                      <span className="muted">Monthly Subscription</span>
                      <span style={{ fontWeight: 700, color: 'var(--primary-light)' }}>
                        {formatMoney(selectedAccountModal.account.product.monthlyPrice, selectedAccountModal.account.product.currency)} / mo
                      </span>
                    </div>
                    {selectedAccountModal.account.activationRequests?.[0] && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
                        <span className="muted">Latest Activation</span>
                        <Link
                          href={`/activations/${selectedAccountModal.account.activationRequests[0].id}`}
                          style={{ color: 'var(--primary-light)', textDecoration: 'underline', fontWeight: 600 }}
                        >
                          {selectedAccountModal.account.activationRequests[0].reference} ({selectedAccountModal.account.activationRequests[0].status})
                        </Link>
                      </div>
                    )}
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1.5rem' }}>
                    <button
                      type="button"
                      className="btn secondary"
                      onClick={() => setSelectedAccountModal(null)}
                    >
                      Close
                    </button>
                  </div>
              </Modal>
            )}
          </main>
        )
      }}
    </ResellerShell>
  )
}
