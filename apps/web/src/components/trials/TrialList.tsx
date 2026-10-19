'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { apiRequest, api, ApiError } from '@/lib/api'
import { formatDate } from '@/lib/format'
import {
  emptyOwner,
  getTrialDisplayStatus,
  TRIAL_STATUS_LABELS,
  validateOwner,
  type TrialOutcomeResult,
  type TrialOwner,
  type TrialRequest,
  type TrialStatus,
} from '@/lib/trial-types'
import type { ResellerProduct } from '@/lib/product-types'
import { OwnerFields } from './OwnerFields'
import { PageHero, type PageHeroProps } from '@/components/PageHero'
import { kpiKeyDown } from '@/components/ui/KpiRefCard'
import { Modal } from '@/components/ui/Modal'

interface Props {
  /** Platform-staff view: hides seller-only shortcuts (provision / activate / my customers). */
  isAdminView?: boolean
  showReseller?: boolean
  /** Retry / cancel (reseller users and platform users with trials:create). */
  canAct: boolean
  refreshKey?: number
  heroProps?: Omit<PageHeroProps, 'children'>
}

interface PaginationMeta {
  total: number
  page: number
  limit: number
  totalPages: number
  pipelineCounts?: {
    total: number
    provisioned: number
    processing: number
    manualFulfilment?: number
    failed: number
    converted?: number
  }
}

const canSync = (t: TrialRequest) => {
  const isManual = t.product.integration?.provider === 'MANUAL'
  if (isManual) return false
  return t.status === 'SUBMITTED' || t.status === 'PENDING' || (t.status === 'FAILED' && t.errorRetryable === true)
}

// ─── Customer Avatar & Product Icon Helpers ─────────────────────────────────

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
  const code = (name || '?').charCodeAt(0)
  const [bg, fg] = AVATAR_PALETTES[code % AVATAR_PALETTES.length]
  return (
    <div
      aria-hidden
      style={{
        width: '34px',
        height: '34px',
        borderRadius: '8px',
        background: bg,
        border: `1px solid ${fg}44`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: fg,
        fontWeight: 800,
        fontSize: '0.85rem',
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

function CopyButton({ text }: { text: string }) {
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
      title={copied ? 'Copied to clipboard!' : 'Copy tenant reference'}
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

function SkeletonRow({ showReseller }: { showReseller?: boolean }) {
  return (
    <tr style={{ animation: 'pulse 1.6s ease-in-out infinite' }}>
      <td>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
          <div style={{ width: '34px', height: '34px', borderRadius: '8px', background: 'var(--surface-hover)', flexShrink: 0 }} />
          <div>
            <div style={{ width: '130px', height: '14px', borderRadius: '5px', background: 'var(--surface-hover)', marginBottom: '5px' }} />
            <div style={{ width: '80px', height: '11px', borderRadius: '5px', background: 'var(--surface-hover)' }} />
          </div>
        </div>
      </td>
      <td>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <div style={{ width: '28px', height: '28px', borderRadius: '7px', background: 'var(--surface-hover)', flexShrink: 0 }} />
          <div style={{ width: '110px', height: '14px', borderRadius: '5px', background: 'var(--surface-hover)' }} />
        </div>
      </td>
      {showReseller && (
        <td>
          <div style={{ width: '100px', height: '13px', borderRadius: '5px', background: 'var(--surface-hover)' }} />
        </td>
      )}
      <td>
        <div style={{ width: '90px', height: '22px', borderRadius: '9999px', background: 'var(--surface-hover)' }} />
      </td>
      <td>
        <div style={{ width: '110px', height: '13px', borderRadius: '5px', background: 'var(--surface-hover)' }} />
      </td>
      <td>
        <div style={{ width: '85px', height: '13px', borderRadius: '5px', background: 'var(--surface-hover)' }} />
      </td>
      <td style={{ textAlign: 'right' }}>
        <div style={{ width: '75px', height: '28px', borderRadius: '7px', background: 'var(--surface-hover)', display: 'inline-block' }} />
      </td>
    </tr>
  )
}

function Pagination({ meta, onPage }: { meta: PaginationMeta; onPage: (p: number) => void }) {
  if (meta.totalPages <= 1) return null
  const { page, totalPages, total, limit } = meta
  const from = (page - 1) * limit + 1
  const to = Math.min(page * limit, total)

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0.85rem 1.25rem',
        borderTop: '1px solid var(--border)',
        gap: '0.75rem',
        flexWrap: 'wrap',
      }}
    >
      <span className="muted small">
        Showing {from}–{to} of {total} trial requests
      </span>
      <div style={{ display: 'flex', gap: '0.35rem' }}>
        <button
          className="btn secondary small"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          aria-label="Previous page"
        >
          &larr; Prev
        </button>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: '0 0.65rem',
            fontSize: '0.82rem',
            color: 'var(--muted)',
            fontWeight: 600,
          }}
        >
          {page} / {totalPages}
        </span>
        <button
          className="btn secondary small"
          disabled={page >= totalPages}
          onClick={() => onPage(page + 1)}
          aria-label="Next page"
        >
          Next &rarr;
        </button>
      </div>
    </div>
  )
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function TrialList({ isAdminView, showReseller, canAct, refreshKey, heroProps }: Props) {
  const [items, setItems] = useState<TrialRequest[] | null>(null)
  const [meta, setMeta] = useState<PaginationMeta | null>(null)
  const [products, setProducts] = useState<ResellerProduct[]>([])
  const [status, setStatus] = useState<TrialStatus | ''>('')
  const [productId, setProductId] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  // Retry dialog state
  const [retrying, setRetrying] = useState<TrialRequest | null>(null)
  const [owner, setOwner] = useState<TrialOwner>(emptyOwner)
  const [ownerErrors, setOwnerErrors] = useState<Record<string, string>>({})
  const [dialogError, setDialogError] = useState<string | null>(null)

  // Search debounce (350ms)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [debouncedSearch, setDebouncedSearch] = useState('')

  function handleSearchChange(val: string) {
    setSearch(val)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setPage(1)
      setDebouncedSearch(val)
    }, 350)
  }

  // Load available products for filter dropdown
  useEffect(() => {
    api<ResellerProduct[]>('/products')
      .then((res) => {
        if (Array.isArray(res)) setProducts(res)
      })
      .catch(() => {})
  }, [])

  // Main list fetch
  const load = useCallback(() => {
    let cancelled = false
    setLoading(true)
    const params = new URLSearchParams()
    params.set('page', String(page))
    params.set('limit', '20')
    if (status) params.set('status', status)
    if (productId) params.set('productId', productId)
    if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim())

    apiRequest<TrialRequest[]>(`/trials?${params.toString()}`)
      .then((r) => {
        if (!cancelled) {
          setItems(r.data)
          setMeta(r.meta ?? null)
          setError(null)
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Failed to load trial requests')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [page, status, productId, debouncedSearch])

  useEffect(() => {
    load()
  }, [load, refreshKey])

  const report = (r: TrialOutcomeResult) =>
    setMessage({ kind: r.outcome === 'PROVISIONED' ? 'success' : r.outcome === 'FAILED' ? 'error' : 'info', text: r.message })

  const sync = async (t: TrialRequest) => {
    setBusyId(t.id)
    try {
      report(await api<TrialOutcomeResult>(`/trials/${t.id}/sync`, { method: 'POST' }))
      load()
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof ApiError ? err.message : 'Status check failed' })
    } finally {
      setBusyId(null)
    }
  }

  const cancel = async (t: TrialRequest) => {
    if (!confirm(`Cancel the ${t.product.name} trial request for ${t.customerAccount.customer.displayName}?`)) return
    setBusyId(t.id)
    try {
      await api(`/trials/${t.id}/cancel`, { method: 'POST' })
      setMessage({ kind: 'info', text: 'Trial request cancelled.' })
      load()
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof ApiError ? err.message : 'Cancel failed' })
    } finally {
      setBusyId(null)
    }
  }

  const openRetry = (t: TrialRequest) => {
    setOwner({ ...emptyOwner, businessName: t.customerAccount.customer.displayName })
    setOwnerErrors({})
    setDialogError(null)
    setRetrying(t)
  }

  const submitRetry = async () => {
    if (!retrying) return
    const errors = validateOwner(owner)
    setOwnerErrors(errors)
    if (Object.keys(errors).length) return
    setBusyId(retrying.id)
    setDialogError(null)
    try {
      const result = await api<TrialOutcomeResult>(`/trials/${retrying.id}/retry`, { method: 'POST', body: JSON.stringify({ owner }) })
      report(result)
      setRetrying(null)
      setOwner(emptyOwner)
      load()
    } catch (err) {
      if (err instanceof ApiError) {
        setOwnerErrors(err.fieldErrors())
        setDialogError(err.message)
      } else setDialogError('Retry failed')
    } finally {
      setBusyId(null)
    }
  }

  const resetFilters = () => {
    setStatus('')
    setProductId('')
    setSearch('')
    setDebouncedSearch('')
    setPage(1)
  }

  const hasActiveFilters = Boolean(status || productId || debouncedSearch.trim())

  // Compute quick summary pipeline counts using backend totals if available
  const totalCount = meta?.pipelineCounts?.total ?? meta?.total ?? items?.length ?? 0
  const provisionedCount =
    meta?.pipelineCounts?.provisioned ??
    (items
      ? items.filter((t) => t.status === 'PROVISIONED' && t.customerAccount.status === 'TRIAL' && Boolean(t.customerAccount.externalTenantId)).length
      : 0)
  const processingCount =
    meta?.pipelineCounts?.processing ??
    (items ? items.filter((t) => (t.status === 'SUBMITTED' || t.status === 'PENDING') && t.customerAccount.status !== 'ACTIVE').length : 0)
  const manualFulfilmentCount =
    meta?.pipelineCounts?.manualFulfilment ??
    (items ? items.filter((t) => (t.status === 'SUBMITTED' || t.status === 'PENDING') && t.product.integration?.provider === 'MANUAL').length : 0)
  const failedCount = meta?.pipelineCounts?.failed ?? (items ? items.filter((t) => t.status === 'FAILED').length : 0)

  const kpiGrid = (
    <div className="kpi-grid">
      <div
        className="card kpi-ref"
        role="button"
        tabIndex={0}
        onKeyDown={kpiKeyDown}
        style={{
          cursor: 'pointer',
          borderColor: status === '' ? 'rgba(37, 99, 235, 0.45)' : undefined,
        }}
        onClick={() => {
          setStatus('')
          setPage(1)
        }}
        title="Filter by all trial requests"
      >
        <div className="kpi-ref-top">
          <span className="kpi-ref-label">Total Requests</span>
          <div className="kpi-ref-icon indigo">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </div>
        </div>
        <div className="kpi-ref-main">
          <div className="kpi-ref-value">{loading && !items ? '—' : totalCount}</div>
        </div>
        <div className="kpi-ref-footer">
          <span className="kpi-ref-badge neutral">All Time</span>
          <span className="kpi-ref-desc">Trial requests recorded</span>
        </div>
      </div>

      <div
        className="card kpi-ref"
        role="button"
        tabIndex={0}
        onKeyDown={kpiKeyDown}
        style={{
          cursor: 'pointer',
          borderColor: status === 'PROVISIONED' ? 'rgba(16, 185, 129, 0.45)' : undefined,
        }}
        onClick={() => {
          setStatus('PROVISIONED')
          setPage(1)
        }}
        title="Filter by active trials"
      >
        <div className="kpi-ref-top">
          <span className="kpi-ref-label">Active Trials</span>
          <div className="kpi-ref-icon emerald">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
          </div>
        </div>
        <div className="kpi-ref-main">
          <div className="kpi-ref-value">{loading && !items ? '—' : provisionedCount}</div>
        </div>
        <div className="kpi-ref-footer">
          <span className="kpi-ref-badge positive">Live SaaS</span>
          <span className="kpi-ref-desc">Client testing ongoing</span>
        </div>
      </div>

      <div
        className="card kpi-ref"
        role="button"
        tabIndex={0}
        onKeyDown={kpiKeyDown}
        style={{
          cursor: 'pointer',
          borderColor: status === 'SUBMITTED' ? 'rgba(245, 158, 11, 0.45)' : undefined,
        }}
        onClick={() => {
          setStatus('SUBMITTED')
          setPage(1)
        }}
        title="Filter by processing requests"
      >
        <div className="kpi-ref-top">
          <span className="kpi-ref-label">Processing</span>
          <div className="kpi-ref-icon amber">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
              <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
              <path d="M16 16h5v5" />
            </svg>
          </div>
        </div>
        <div className="kpi-ref-main">
          <div className="kpi-ref-value">{loading && !items ? '—' : processingCount}</div>
        </div>
        <div className="kpi-ref-footer">
          <span className="kpi-ref-badge neutral">
            {manualFulfilmentCount > 0 ? 'Manual' : 'In Progress'}
          </span>
          <span className="kpi-ref-desc">
            {manualFulfilmentCount > 0 ? `${manualFulfilmentCount} manual pending` : 'Awaiting tenant creation'}
          </span>
        </div>
      </div>

      <div
        className="card kpi-ref"
        role="button"
        tabIndex={0}
        onKeyDown={kpiKeyDown}
        style={{
          cursor: 'pointer',
          borderColor: status === 'FAILED' ? 'rgba(239, 68, 68, 0.45)' : undefined,
        }}
        onClick={() => {
          setStatus('FAILED')
          setPage(1)
        }}
        title="Filter by failed requests"
      >
        <div className="kpi-ref-top">
          <span className="kpi-ref-label">Action Required</span>
          <div className="kpi-ref-icon violet" style={{ color: failedCount > 0 ? '#ef4444' : undefined }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
        </div>
        <div className="kpi-ref-main">
          <div className="kpi-ref-value" style={{ color: failedCount > 0 ? '#ef4444' : undefined }}>
            {loading && !items ? '—' : failedCount}
          </div>
        </div>
        <div className="kpi-ref-footer">
          <span className={`kpi-ref-badge ${failedCount > 0 ? 'neutral' : 'positive'}`}>
            {failedCount > 0 ? 'Retry Ready' : 'Clear'}
          </span>
          <span className="kpi-ref-desc">Failed provisioning requests</span>
        </div>
      </div>
    </div>
  )

  return (
    <>
      {heroProps ? <PageHero {...heroProps}>{kpiGrid}</PageHero> : kpiGrid}

      {/* ── Status Toast / Notice Banner ── */}
      {message && (
        <div className={`alert ${message.kind}`} style={{ marginBottom: '1.25rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>{message.text}</span>
          <button type="button" onClick={() => setMessage(null)} className="btn link small" style={{ color: 'inherit', padding: 0 }}>
            Dismiss
          </button>
        </div>
      )}

      {/* ── Error Banner ── */}
      {error && (
        <div className="alert error" style={{ marginBottom: '1.25rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>{error}</span>
          <button type="button" onClick={load} className="btn secondary small">
            Retry
          </button>
        </div>
      )}
      {/* ── Balanced Search & Filter Toolbar ── */}
      <div className="filter-bar">
        <div className="field inline search-field">
          <label htmlFor="tr-search">Search</label>
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
              aria-hidden
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            <input
              id="tr-search"
              type="text"
              placeholder="Customer name, code or tenant ID…"
              value={search}
              onChange={(e) => handleSearchChange(e.target.value)}
            />
          </div>
        </div>

        <div className="field inline" style={{ flex: '1 1 170px', minWidth: '150px', maxWidth: '220px' }}>
          <label htmlFor="tr-status">Status</label>
          <select
            id="tr-status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as TrialStatus | '')
              setPage(1)
            }}
          >
            <option value="">All statuses</option>
            {(Object.keys(TRIAL_STATUS_LABELS) as TrialStatus[]).map((s) => (
              <option key={s} value={s}>
                {TRIAL_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>

        <div className="field inline" style={{ flex: '1 1 190px', minWidth: '160px', maxWidth: '240px' }}>
          <label htmlFor="tr-product">SaaS Product</label>
          <select
            id="tr-product"
            value={productId}
            onChange={(e) => {
              setProductId(e.target.value)
              setPage(1)
            }}
          >
            <option value="">All products</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <div className="filter-actions">
          {loading && items && <span className="small muted">Updating…</span>}
          {hasActiveFilters && (
            <button
              type="button"
              className="btn link small"
              onClick={resetFilters}
              style={{ padding: '0.4rem 0.5rem', whiteSpace: 'nowrap' }}
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {/* ── Table Card Container ── */}
      <div className="trials-table-card">
        <div className="table-wrap" style={{ margin: 0, border: 'none' }}>
          <table className="trials-table">
            <thead>
              <tr>
                <th style={{ width: '22%', minWidth: '180px' }}>Customer</th>
                <th style={{ width: '20%', minWidth: '170px' }}>SaaS Product</th>
                {showReseller && <th style={{ width: '14%', minWidth: '130px' }}>Partner</th>}
                <th style={{ width: '18%', minWidth: '160px' }}>SaaS Tenant Reference</th>
                <th style={{ width: '15%', minWidth: '140px' }}>Trial Status</th>
                <th style={{ width: '15%', minWidth: '140px' }}>Timeline &amp; Dates</th>
                <th style={{ width: '10%', minWidth: '120px', textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && !items ? (
                <>
                  <SkeletonRow showReseller={showReseller} />
                  <SkeletonRow showReseller={showReseller} />
                  <SkeletonRow showReseller={showReseller} />
                  <SkeletonRow showReseller={showReseller} />
                  <SkeletonRow showReseller={showReseller} />
                </>
              ) : !items || items.length === 0 ? (
                <tr>
                  <td colSpan={showReseller ? 7 : 6} style={{ padding: '3.5rem 1.5rem', textAlign: 'center' }}>
                    <div style={{ maxWidth: '420px', margin: '0 auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.75rem' }}>
                      <div
                        style={{
                          width: '48px',
                          height: '48px',
                          borderRadius: '12px',
                          background: 'var(--surface-hover)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          color: 'var(--muted)',
                        }}
                        aria-hidden
                      >
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="12" r="10" />
                          <line x1="8" y1="12" x2="16" y2="12" />
                        </svg>
                      </div>
                      <strong style={{ fontSize: '1rem', color: 'var(--text-heading)' }}>
                        {hasActiveFilters ? 'No matching trial requests' : 'No trial accounts provisioned'}
                      </strong>
                      <p className="muted small" style={{ margin: 0 }}>
                        {hasActiveFilters
                          ? 'No trial requests match the selected search query or filters. Try adjusting your filter parameters.'
                          : 'Prospective clients can test drive Hexalyte SaaS products for up to 14 days with zero upfront commitment.'}
                      </p>
                      {hasActiveFilters ? (
                        <button type="button" onClick={resetFilters} className="btn secondary small" style={{ marginTop: '0.5rem' }}>
                          Clear filters
                        </button>
                      ) : (
                        canAct && !isAdminView && (
                          <Link href="/trials/new" className="btn small" style={{ marginTop: '0.5rem' }}>
                            Provision First Trial
                          </Link>
                        )
                      )}
                    </div>
                  </td>
                </tr>
              ) : (
                items.map((t) => {
                  const isSyncing = busyId === t.id
                  const isFailed = t.status === 'FAILED'
                  const isPaid = t.customerAccount.status === 'ACTIVE'
                  const hasExternalTenant = Boolean(t.customerAccount.externalTenantId)
                  const isGenuinelyProvisioned = t.status === 'PROVISIONED' && hasExternalTenant && Boolean(t.completedAt)
                  const isManual = t.product.integration?.provider === 'MANUAL'
                  const requestedDate = formatDate(t.createdAt)
                  const provisionedDate = isGenuinelyProvisioned && t.completedAt ? formatDate(t.completedAt) : null
                  const statusInfo = getTrialDisplayStatus(t)

                  return (
                    <tr key={t.id}>
                      {/* Customer Column */}
                      <td style={{ verticalAlign: 'middle' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                          <CustomerAvatar name={t.customerAccount.customer.displayName} />
                          <div style={{ minWidth: 0, overflow: 'hidden' }}>
                            <div
                              style={{
                                fontWeight: 700,
                                color: 'var(--text-heading)',
                                fontSize: '0.9rem',
                                lineHeight: 1.25,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                maxWidth: '180px',
                              }}
                              title={t.customerAccount.customer.displayName}
                            >
                              {t.customerAccount.customer.displayName}
                            </div>
                            <div
                              className="mono"
                              style={{
                                fontSize: '0.74rem',
                                color: 'var(--text-secondary)',
                                marginTop: '2px',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {t.customerAccount.customer.customerCode || `Account #${t.customerAccount.id.slice(-6).toUpperCase()}`}
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* Product Column */}
                      <td style={{ verticalAlign: 'middle' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem' }}>
                          <ProductIcon code={t.product.code} />
                          <div style={{ minWidth: 0 }}>
                            <div
                              style={{
                                fontWeight: 600,
                                color: 'var(--text-heading)',
                                fontSize: '0.88rem',
                                lineHeight: 1.25,
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {t.product.name}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', marginTop: '2px' }}>
                              <span className="mono" style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                                {t.product.code}
                              </span>
                              {isManual && (
                                <span
                                  style={{
                                    fontSize: '0.68rem',
                                    color: 'var(--muted)',
                                    fontStyle: 'italic',
                                  }}
                                >
                                  (Manual)
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* Partner Column (Admin view only) */}
                      {showReseller && (
                        <td className="small" style={{ verticalAlign: 'middle' }}>
                          <div style={{ fontWeight: 600, color: 'var(--text-heading)', whiteSpace: 'nowrap' }}>
                            {t.reseller.businessName}
                          </div>
                          <div className="mono" style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: '2px' }}>
                            {t.reseller.code}
                          </div>
                        </td>
                      )}

                      {/* Tenant Reference Column */}
                      <td style={{ verticalAlign: 'middle' }}>
                        {t.customerAccount.externalTenantId ? (
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                            <span
                              className="mono"
                              style={{
                                background: 'var(--surface-elevated)',
                                border: '1px solid var(--border-subtle)',
                                padding: '0.15rem 0.45rem',
                                borderRadius: '5px',
                                fontSize: '0.78rem',
                                color: 'var(--text-heading)',
                                letterSpacing: '0.02em',
                              }}
                            >
                              {t.customerAccount.externalTenantId}
                            </span>
                            <CopyButton text={t.customerAccount.externalTenantId} />
                          </div>
                        ) : (
                          <span
                            style={{
                              fontSize: '0.78rem',
                              color: isPaid ? '#fbbf24' : 'var(--muted)',
                              fontWeight: isPaid ? 600 : 400,
                            }}
                            title={isPaid ? 'Payment verified; external SaaS tenant unverified' : 'Tenant not yet provisioned'}
                          >
                            {isPaid ? 'Unverified' : '—'}
                          </span>
                        )}
                        {t.customerAccount.externalAccountId && (
                          <div className="mono" style={{ fontSize: '0.7rem', color: 'var(--muted)', marginTop: '2px' }}>
                            owner: {t.customerAccount.externalAccountId}
                          </div>
                        )}
                      </td>

                      {/* Status Column */}
                      <td style={{ verticalAlign: 'middle' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', alignItems: 'flex-start' }}>
                          <span className={statusInfo.badgeClass}>
                            {statusInfo.label}
                          </span>
                          {statusInfo.isTenantUnverified && isPaid && (
                            <span style={{ color: '#fbbf24', fontSize: '0.72rem', lineHeight: 1.2, fontWeight: 500 }}>
                              Tenant unverified
                            </span>
                          )}
                          {isFailed && t.errorMessage && (
                            <div
                              style={{
                                color: '#ef4444',
                                fontSize: '0.74rem',
                                maxWidth: '200px',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                lineHeight: 1.25,
                              }}
                              title={t.errorMessage}
                            >
                              {t.errorMessage}
                            </div>
                          )}
                          {t.attempts > 1 && (
                            <span style={{ fontSize: '0.7rem', color: 'var(--muted)' }}>
                              {t.attempts} attempts
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Timeline / Dates Column */}
                      <td style={{ verticalAlign: 'middle' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.8rem', lineHeight: 1.3 }}>
                          <div>
                            <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>Requested: </span>
                            <span style={{ fontWeight: 600, color: 'var(--text-heading)', whiteSpace: 'nowrap' }}>{requestedDate}</span>
                          </div>
                          {provisionedDate && !isPaid && (
                            <div>
                              <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>Active since: </span>
                              <span style={{ fontWeight: 600, color: '#10b981', whiteSpace: 'nowrap' }}>{provisionedDate}</span>
                            </div>
                          )}
                          {isPaid && (
                            <div>
                              <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>Subscription: </span>
                              <span style={{ fontWeight: 600, color: hasExternalTenant ? '#10b981' : '#fbbf24', whiteSpace: 'nowrap' }}>
                                {hasExternalTenant ? 'Active Paid' : 'Payment Verified'}
                              </span>
                            </div>
                          )}
                          {!isGenuinelyProvisioned && !isPaid && (
                            <div style={{ fontSize: '0.72rem', color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                              Starts upon provisioning
                            </div>
                          )}
                          {isGenuinelyProvisioned && !isPaid && (
                            <div style={{ fontSize: '0.72rem', color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                              Duration: 14 days
                            </div>
                          )}
                        </div>
                      </td>

                      {/* Actions Column */}
                      <td style={{ verticalAlign: 'middle', textAlign: 'right' }}>
                        <div style={{ display: 'inline-flex', gap: '0.4rem', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center', whiteSpace: 'nowrap' }}>
                          {canSync(t) && (
                            <button
                              type="button"
                              className="btn secondary small"
                              disabled={isSyncing}
                              onClick={() => sync(t)}
                              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.78rem' }}
                            >
                              {isSyncing ? (
                                <>
                                  <svg
                                    width="12"
                                    height="12"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2.5"
                                    style={{ animation: 'spin 0.8s linear infinite' }}
                                  >
                                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                                  </svg>
                                  <span>Checking…</span>
                                </>
                              ) : (
                                <>
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                                    <path d="M3 3v5h5" />
                                  </svg>
                                  <span>Sync</span>
                                </>
                              )}
                            </button>
                          )}

                          {!canSync(t) && (t.status === 'SUBMITTED' || t.status === 'PENDING') && (
                            <span
                              className="muted small"
                              style={{
                                fontSize: '0.74rem',
                                padding: '0.2rem 0.5rem',
                                borderRadius: '4px',
                                background: 'var(--surface-elevated)',
                                border: '1px solid var(--border-subtle)',
                                color: 'var(--muted)',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '0.3rem',
                              }}
                            >
                              {isManual ? 'Awaiting manual fulfilment' : 'In progress'}
                            </span>
                          )}

                          {canAct && isFailed && (
                            <>
                              <button
                                type="button"
                                className="btn small"
                                disabled={isSyncing}
                                onClick={() => openRetry(t)}
                                style={{ fontSize: '0.78rem' }}
                              >
                                Retry
                              </button>
                              <button
                                type="button"
                                className="btn link small"
                                disabled={isSyncing}
                                onClick={() => cancel(t)}
                                style={{ color: '#ef4444', fontSize: '0.78rem' }}
                              >
                                Cancel
                              </button>
                            </>
                          )}

                          {isGenuinelyProvisioned && !isPaid && canAct && !isAdminView && (
                            <Link
                              href={`/activations/new?productId=${t.product.id}&customerId=${t.customerAccount.customer.customerCode || t.customerAccount.customer.id}`}
                              className="btn link small"
                              style={{ color: 'var(--primary-light)', fontSize: '0.78rem', fontWeight: 600, textDecoration: 'none' }}
                              title="Convert to paid activation"
                            >
                              Activate &rarr;
                            </Link>
                          )}

                          {isPaid && (
                            <Link
                              href={isAdminView ? '/admin/customer-accounts' : '/customers'}
                              className="btn link small"
                              style={{ color: hasExternalTenant ? '#10b981' : '#fbbf24', fontSize: '0.78rem', fontWeight: 600, textDecoration: 'none' }}
                              title={hasExternalTenant ? 'Customer account is paid and active' : 'Payment verified; tenant unverified'}
                            >
                              View Customer &rarr;
                            </Link>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        {/* ── Table Pagination ── */}
        {meta && <Pagination meta={meta} onPage={setPage} />}
      </div>

      {/* ── Privacy-Safe Retry Modal ── */}
      {retrying && (
        <Modal label={'Retry trial provisioning'} onClose={() => setRetrying(null)} wide>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
              <h2 style={{ margin: 0, fontSize: '1.25rem', color: 'var(--text-heading)' }}>
                Retry Trial Provisioning
              </h2>
              <button
                type="button"
                onClick={() => setRetrying(null)}
                className="btn link"
                style={{ padding: '0.2rem', color: 'var(--muted)', fontSize: '1.25rem', lineHeight: 1 }}
                aria-label="Close dialog"
              >
                &times;
              </button>
            </div>

            <p className="small muted" style={{ margin: '0 0 1rem' }}>
              Target Product: <strong>{retrying.product.name}</strong> · Client: <strong>{retrying.customerAccount.customer.displayName}</strong>
              <br />
              For privacy protection, owner details are not retained on our platform. Please re-enter the client contact credentials below to retry SaaS provisioning.
            </p>

            {retrying.errorMessage && (
              <div className="alert warning small" style={{ marginBottom: '1rem' }}>
                <strong>Previous error:</strong> {retrying.errorMessage}
              </div>
            )}

            {dialogError && (
              <div className="alert error small" style={{ marginBottom: '1rem' }}>
                {dialogError}
              </div>
            )}

            <OwnerFields value={owner} errors={ownerErrors} onChange={setOwner} />

            <div className="row" style={{ marginTop: '1.25rem', gap: '0.5rem' }}>
              <span className="spacer" />
              <button
                type="button"
                className="btn secondary"
                onClick={() => setRetrying(null)}
                disabled={busyId === retrying.id}
              >
                Close
              </button>
              <button
                type="button"
                className="btn"
                onClick={submitRetry}
                disabled={busyId === retrying.id}
              >
                {busyId === retrying.id ? 'Provisioning…' : 'Retry Provisioning'}
              </button>
            </div>
        </Modal>
      )}
    </>
  )
}
