'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { api, apiRequest, ApiError } from '@/lib/api'
import { useAdminUser } from '@/lib/admin-context'
import { formatDate, formatMoney, monthLabel } from '@/lib/format'
import { ACTIVATION_STATUS_LABELS } from '@/lib/activation-types'
import { humanizeAction, type AdminDashboard } from '@/lib/admin-types'
import type { DemoPipelineCounts } from '@/lib/demo-types'

interface ModernKpiProps {
  label: string
  value: React.ReactNode
  hint?: React.ReactNode
  href?: string
  icon: React.ReactNode
  iconBg: string
  accentColor?: string
}

function ModernKpi({ label, value, hint, href, icon, iconBg, accentColor }: ModernKpiProps) {
  const content = (
    <div
      style={{
        background: '#0f1523',
        borderRadius: '14px',
        padding: '0.95rem 1.1rem',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.35)',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.3rem',
        transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
        position: 'relative',
        overflow: 'hidden',
        // Every tile fills its grid cell, so a row of tiles is always the same height.
        height: '100%',
        minHeight: '6.6rem',
        boxSizing: 'border-box',
      }}
    >
      {accentColor && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: '3px',
            background: accentColor,
            boxShadow: `0 0 10px ${accentColor}`,
          }}
        />
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span
          style={{
            fontSize: '0.7rem',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            color: '#94a3b8',
          }}
        >
          {label}
        </span>
        <div
          style={{
            width: '32px',
            height: '32px',
            borderRadius: '9px',
            background: iconBg,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '1px solid rgba(255, 255, 255, 0.06)',
          }}
        >
          {icon}
        </div>
      </div>

      <div
        style={{
          // Money values ("Rs. 12,345.00") are long; keep them on one line inside narrower tiles.
          fontSize: typeof value === 'string' && value.length > 8 ? 'clamp(1.1rem, 0.7rem + 0.9vw, 1.35rem)' : '1.5rem',
          fontWeight: 800,
          // The tile is dark in both themes, so its text is a fixed light colour: --text-heading is dark in Light mode.
          color: '#f8fafc',
          letterSpacing: '-0.03em',
          lineHeight: 1.15,
          fontVariantNumeric: 'tabular-nums',
          overflowWrap: 'anywhere',
        }}
      >
        {value}
      </div>

      {hint && (
        <div style={{ fontSize: '0.74rem', color: '#94a3b8', fontWeight: 500, marginTop: 'auto', paddingTop: '0.1rem' }}>
          {hint}
        </div>
      )}
    </div>
  )

  if (href) {
    return (
      <Link href={href} style={{ textDecoration: 'none', display: 'block', height: '100%' }}>
        {content}
      </Link>
    )
  }
  return content
}

const ago = (iso: string) => {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  return days <= 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`
}

/** Same header for every dashboard panel: icon + title + one-line purpose on the left, a link or chip on the right. */
function PanelHeader({ icon, title, subtitle, action }: { icon: string; title: string; subtitle: string; action?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem 1rem', marginBottom: '0.85rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', minWidth: 0 }}>
        <span style={{ fontSize: '1.05rem' }}>{icon}</span>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ margin: 0, fontSize: '1rem' }}>{title}</h3>
          <p className="muted small" style={{ margin: '0.1rem 0 0', fontSize: '0.78rem' }}>
            {subtitle}
          </p>
        </div>
      </div>
      {action}
    </div>
  )
}

const panelLinkStyle: React.CSSProperties = { fontWeight: 600, whiteSpace: 'nowrap' }

/** One list row, shared by the queues and the activity feed so they line up. */
const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  flexWrap: 'wrap',
  gap: '0.4rem 0.85rem',
  padding: '0.55rem 0.85rem',
  borderRadius: '10px',
  background: 'rgba(255, 255, 255, 0.025)',
  border: '1px solid rgba(255, 255, 255, 0.06)',
}

/** Panels in a row share the row height; the body grows so short lists don't leave the card looking cut off. */
const panelStyle: React.CSSProperties = { margin: 0, padding: '1.1rem 1.25rem', display: 'flex', flexDirection: 'column' }

export default function AdminDashboardPage() {
  const admin = useAdminUser()
  const can = (p: string) => admin.permissions.includes(p)
  const [data, setData] = useState<AdminDashboard | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [demoCounts, setDemoCounts] = useState<DemoPipelineCounts | null>(null)

  useEffect(() => {
    api<AdminDashboard>('/dashboard/admin')
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load dashboard'))
  }, [])

  // Total / in-progress demo request counts come from the existing list endpoint's pipeline counts.
  // Best effort: if it fails, the Demo Requests card still shows the pending count from the dashboard payload.
  const canReadDemos = can('demos:read')
  useEffect(() => {
    if (!canReadDemos) return
    apiRequest<unknown[]>('/demo-requests?limit=1&page=1')
      .then((r) => setDemoCounts((r.meta as unknown as { pipelineCounts?: DemoPipelineCounts } | undefined)?.pipelineCounts ?? null))
      .catch(() => setDemoCounts(null))
  }, [canReadDemos])

  if (error) {
    return (
      <div>
        <div className="alert error">{error}</div>
      </div>
    )
  }

  if (!data) {
    return (
      <div>
        <p className="muted">Loading dashboard…</p>
      </div>
    )
  }

  const { kpis, queue, attention, sections } = data
  const money = (v: string) => formatMoney(v, kpis.commission?.currency ?? 'LKR')
  const maxTrend = Math.max(1, ...data.activationTrend.map((t) => t.count))
  const trendTotal = data.activationTrend.reduce((sum, t) => sum + t.count, 0)
  // Failed trials are no longer surfaced: the Admin trial list was replaced by Demo Requests, so there is nothing to open.
  const hasAttention = attention.integrationErrors.length > 0 || attention.failedActivations > 0

  // Demo Requests card: pending count from the dashboard payload; total / in-progress from the list endpoint's counts.
  const demoPending = sections.pendingDemoRequests ?? demoCounts?.pending ?? 0
  const demoHint = demoCounts
    ? `Pending review · ${demoCounts.total} total · ${demoCounts.approved + demoCounts.demoCreated} in progress`
    : 'Pending review'
  // Tile count drives the balanced grid (see `.kpi-grid[data-count]` in globals.css).
  const kpiCount = 5 + (canReadDemos ? 1 : 0) + (kpis.commission ? 2 : 0)

  const tiles = [
    { href: '/admin/resellers', label: 'Partners', count: sections.resellers, note: `${sections.pendingApplications} pending review`, icon: '👥', permission: 'resellers:read' },
    { href: '/admin/products', label: 'SaaS Products', count: sections.products, note: 'Catalogue, pricing & partner APIs', icon: '📦', permission: 'products:manage' },
    { href: '/admin/customer-accounts', label: 'Customers & Mapping', count: sections.customers, note: 'Mapped tenants & live status', icon: '🏢', permission: 'accounts:read' },
    { href: '/admin/activations', label: 'Activation Requests', count: sections.openActivations, note: 'Payment reviews & approvals', icon: '🛡️', permission: 'activations:read' },
    { href: '/admin/demo-requests', label: 'Demo Requests', count: sections.pendingDemoRequests, note: 'Pending manual demo requests', icon: '🧩', permission: 'demos:read' },
    { href: '/admin/bank-slips', label: 'Bank Slips Register', count: sections.bankSlips, note: 'Encrypted slips storage', icon: '🧾', permission: 'bankslips:read' },
    { href: '/admin/commissions', label: 'Commissions & Payouts', count: null, note: 'Batch approvals & payouts', icon: '💰', permission: 'commissions:read' },
    { href: '/admin/notifications', label: 'Notifications', count: sections.unreadNotifications, note: 'System alerts', icon: '🔔' },
    { href: '/admin/audit-logs', label: 'Audit Logs', count: null, note: 'Append-only audit trail', icon: '📜', permission: 'audit:read' },
    { href: '/admin/settings', label: 'Platform Settings', count: null, note: 'Commission tiers & bank details', icon: '⚙️', permission: 'settings:read' },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '1.45rem', color: 'var(--text-heading)' }}>Platform Overview</h1>
          <p className="muted small" style={{ margin: '0.2rem 0 0', fontSize: '0.8rem' }}>
            Hexalyte Central Partner Operations · {monthLabel(data.period)}
          </p>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.65rem' }}>
          <Link href="/admin/activations" className="btn small">
            Review Activations ({kpis.pendingActivations.total})
          </Link>
          <Link href="/admin/reseller-applications" className="btn secondary small">
            Applications ({kpis.pendingApprovals})
          </Link>
          {canReadDemos && (
            <Link href="/admin/demo-requests" className="btn secondary small">
              Demo Requests ({demoPending})
            </Link>
          )}
        </div>
      </div>

      {/* Attention Alert if any */}
      {hasAttention && (
        <div className="alert warning" style={{ borderRadius: '14px' }}>
          <strong>⚠️ Immediate Attention Required:</strong>
          {attention.failedActivations > 0 && (
            <Link href="/admin/activations" style={{ textDecoration: 'underline', marginLeft: '0.5rem' }}>
              {attention.failedActivations} approved request(s) failed in SaaS
            </Link>
          )}
          {attention.integrationErrors.map((p) => (
            <Link key={p.id} href={`/admin/products/${p.id}`} style={{ textDecoration: 'underline', marginLeft: '0.5rem' }}>
              {p.name} integration error
            </Link>
          ))}
        </div>
      )}

      {/* KPI Cards Grid: existing .kpi-grid rules keep rows full (4 + 4 wide, 2 per row on tablet, 1 on phones) */}
      <div className="kpi-grid" data-count={kpiCount} style={{ marginBottom: 0, gap: '0.8rem', gridAutoRows: '1fr' }}>
        <ModernKpi
          label="Total Partners"
          value={kpis.totalResellers}
          hint={kpis.suspendedResellers ? `${kpis.suspendedResellers} suspended` : 'All verified active'}
          href="/admin/resellers"
          accentColor="#6366f1"
          iconBg="rgba(99, 102, 241, 0.15)"
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#818cf8" strokeWidth="2">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          }
        />

        <ModernKpi
          label="Pending Approvals"
          value={kpis.pendingApprovals}
          hint={kpis.pendingApprovals > 0 ? `${kpis.pendingApprovals} awaiting KYC review` : 'No pending reviews'}
          href="/admin/reseller-applications"
          accentColor="#f59e0b"
          iconBg="rgba(245, 158, 11, 0.15)"
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          }
        />

        <ModernKpi
          label="Active Customers"
          value={kpis.activeCustomers}
          hint={`${kpis.activeSubscriptions} active subscriptions`}
          href="/admin/customer-accounts"
          accentColor="#10b981"
          iconBg="rgba(16, 185, 129, 0.15)"
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
          }
        />

        {canReadDemos && (
          <ModernKpi
            label="Demo Requests"
            value={demoPending}
            hint={demoHint}
            href="/admin/demo-requests"
            accentColor="#a855f7"
            iconBg="rgba(168, 85, 247, 0.15)"
            icon={
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#c084fc" strokeWidth="2">
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M3 9h18" />
                <path d="m9 15 2 2 4-4" />
              </svg>
            }
          />
        )}

        <ModernKpi
          label="Pending Activations"
          value={kpis.pendingActivations.total}
          hint={`${kpis.pendingActivations.pendingReview} new · ${kpis.pendingActivations.underReview} in review`}
          href="/admin/activations"
          accentColor="#f97316"
          iconBg="rgba(249, 115, 22, 0.15)"
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fb923c" strokeWidth="2">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
              <path d="m9 12 2 2 4-4" />
            </svg>
          }
        />

        <ModernKpi
          label="Monthly Subscriptions"
          value={kpis.monthlyActivations}
          hint={`Paid subscriptions in ${monthLabel(data.period)}`}
          accentColor="#06b6d4"
          iconBg="rgba(6, 182, 212, 0.15)"
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" strokeWidth="2">
              <rect width="18" height="18" x="3" y="4" rx="2" />
              <line x1="16" x2="16" y1="2" y2="6" />
              <line x1="8" x2="8" y1="2" y2="6" />
              <line x1="3" x2="21" y1="10" y2="10" />
            </svg>
          }
        />

        {kpis.commission && (
          <>
            <ModernKpi
              label="Pending Commission"
              value={money(kpis.commission.pending)}
              hint={`${money(kpis.commission.payable)} payable now · ${kpis.commission.awaitingApprovalCount} to approve`}
              href="/admin/commissions"
              accentColor="#ec4899"
              iconBg="rgba(236, 72, 153, 0.15)"
              icon={
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f472b6" strokeWidth="2">
                  <line x1="12" x2="12" y1="2" y2="22" />
                  <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                </svg>
              }
            />

            <ModernKpi
              label="Paid Commission"
              value={money(kpis.commission.paid)}
              hint={`${money(kpis.commission.paidThisMonth)} paid this month`}
              href="/admin/commissions"
              accentColor="#10b981"
              iconBg="rgba(16, 185, 129, 0.15)"
              icon={
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2">
                  <rect width="20" height="14" x="2" y="5" rx="2" />
                  <line x1="2" x2="22" y1="10" y2="10" />
                </svg>
              }
            />
          </>
        )}
      </div>

      {/* Work queues: both panels share one header, row style and height */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(420px, 100%), 1fr))', gap: '1rem' }}>
        {/* Queue 1: Activations to Handle */}
        {queue.activations && (
          <div className="card" style={panelStyle}>
            <PanelHeader
              icon="🛡️"
              title="Activation Requests to Handle"
              subtitle="Payment reviews & approvals waiting on you"
              action={
                <Link href="/admin/activations" className="small" style={panelLinkStyle}>
                  View all ({kpis.pendingActivations.total})
                </Link>
              }
            />

            {queue.activations.length === 0 ? (
              <p className="muted small" style={{ margin: 'auto 0', padding: '1rem 0', textAlign: 'center' }}>
                All clear! No activation requests waiting for review.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
                {queue.activations.map((a) => (
                  <div key={a.id} style={rowStyle}>
                    <div style={{ minWidth: 0, flex: '1 1 14rem' }}>
                      <Link href={`/admin/activations/${a.id}`} style={{ fontWeight: 700, color: 'var(--text-heading)' }}>
                        {a.customerAccount.customer.displayName}
                      </Link>
                      <div className="muted small" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.15rem 0.5rem', alignItems: 'center', marginTop: '0.2rem' }}>
                        <span className="mono">{a.reference}</span>
                        <span>·</span>
                        <span>{a.product.name}</span>
                        <span>·</span>
                        <strong className="admin-dash-amount">{formatMoney(a.amount, a.currency)}</strong>
                      </div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.35rem' }}>
                      <span className={`badge act-${a.status}`}>{ACTIVATION_STATUS_LABELS[a.status]}</span>
                      <span className="small muted">{ago(a.submittedAt)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Queue 2: Partner Applications */}
        {queue.applications && (
          <div className="card" style={panelStyle}>
            <PanelHeader
              icon="📝"
              title="Pending Partner Applications"
              subtitle="KYC reviews waiting on you"
              action={
                <Link href="/admin/reseller-applications" className="small" style={panelLinkStyle}>
                  View all ({kpis.pendingApprovals})
                </Link>
              }
            />

            {queue.applications.length === 0 ? (
              <p className="muted small" style={{ margin: 'auto 0', padding: '1rem 0', textAlign: 'center' }}>
                No partner applications waiting for approval.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
                {queue.applications.map((r) => (
                  <div key={r.id} style={rowStyle}>
                    <div style={{ minWidth: 0, flex: '1 1 14rem' }}>
                      <Link href={`/admin/reseller-applications/${r.id}`} style={{ fontWeight: 700, color: 'var(--text-heading)' }}>
                        {r.businessName}
                      </Link>
                      <div className="muted small" style={{ marginTop: '0.2rem' }}>
                        {r.fullName} · <span className="mono">{r.code}</span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <span className="small muted">{ago(r.submittedAt)}</span>
                      <Link href={`/admin/reseller-applications/${r.id}`} className="btn secondary small">
                        Review
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Trend & activity: same header and card treatment; the trend bars spread to match the feed's height */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(420px, 100%), 1fr))', gap: '1rem' }}>
        {/* Subscription Activations Trend Chart */}
        <div className="card" style={panelStyle}>
          <PanelHeader
            icon="📈"
            title="Subscription Activations Trend"
            subtitle="Verified monthly payments (Last 6 months)"
            action={
              <span
                className="admin-dash-chip"
                style={{
                  fontSize: '0.76rem',
                  fontWeight: 700,
                  padding: '0.25rem 0.65rem',
                  borderRadius: '8px',
                  whiteSpace: 'nowrap',
                }}
              >
                Peak: {maxTrend} / mo
              </span>
            }
          />

          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-around', gap: '0.55rem' }}>
            {data.activationTrend.map((t) => {
              const pct = Math.round((t.count / maxTrend) * 100)
              return (
                <div key={t.periodMonth} style={{ display: 'flex', alignItems: 'center', gap: '0.9rem' }}>
                  <span style={{ width: '85px', flexShrink: 0, fontSize: '0.84rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                    {monthLabel(t.periodMonth)}
                  </span>
                  <div
                    style={{
                      flex: 1,
                      height: '14px',
                      background: 'var(--toggle-bg)',
                      borderRadius: '9999px',
                      overflow: 'hidden',
                      position: 'relative',
                    }}
                  >
                    <div
                      style={{
                        width: `${pct}%`,
                        height: '100%',
                        background: 'linear-gradient(90deg, #4f46e5 0%, #a855f7 100%)',
                        borderRadius: '9999px',
                        boxShadow: '0 0 12px rgba(99, 102, 241, 0.5)',
                        transition: 'width 0.4s ease',
                      }}
                    />
                  </div>
                  <span style={{ width: '45px', flexShrink: 0, textAlign: 'right', fontWeight: 700, fontSize: '0.9rem', color: 'var(--text-heading)' }}>
                    {t.count}
                  </span>
                </div>
              )
            })}
          </div>

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: '0.5rem 1rem',
              marginTop: '0.9rem',
              paddingTop: '0.75rem',
              borderTop: '1px solid var(--border)',
            }}
          >
            <span className="muted small">
              This month <strong style={{ color: 'var(--text-heading)' }}>{kpis.monthlyActivations}</strong>
            </span>
            <span className="muted small">
              6-month total <strong style={{ color: 'var(--text-heading)' }}>{trendTotal}</strong>
            </span>
          </div>
        </div>

        {/* Recent Admin Activity */}
        {data.recentAudit && (
          <div className="card" style={panelStyle}>
            <PanelHeader
              icon="📜"
              title="Recent Platform Activity"
              subtitle="Tamper-proof append-only audit trail"
              action={
                <Link href="/admin/audit-logs" className="small" style={panelLinkStyle}>
                  Full Audit Log
                </Link>
              }
            />

            {data.recentAudit.length === 0 ? (
              <p className="muted small" style={{ margin: 'auto 0', padding: '1rem 0', textAlign: 'center' }}>No activity logged yet.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
                {data.recentAudit.map((a) => (
                  <div key={a.id} style={rowStyle}>
                    <div style={{ minWidth: 0, flex: '1 1 10rem' }}>
                      <div style={{ fontWeight: 600, fontSize: '0.88rem', color: 'var(--text-heading)' }}>
                        {humanizeAction(a.action)}
                      </div>
                      <div className="muted small" style={{ fontSize: '0.78rem', overflowWrap: 'anywhere' }}>
                        {a.actorEmail ?? a.actorType.toLowerCase()}
                      </div>
                    </div>
                    <span className="muted small" style={{ fontSize: '0.76rem', whiteSpace: 'nowrap' }}>
                      {formatDate(a.createdAt)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Admin Sections Quick Directory */}
      <div>
        <h3 style={{ margin: '0.25rem 0 0.8rem', fontSize: '1.05rem', color: 'var(--text-heading)' }}>Platform Management Directory</h3>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(min(220px, 100%), 1fr))',
            gap: '0.75rem',
          }}
        >
          {tiles
            .filter((t) => !t.permission || can(t.permission))
            .map((t) => (
              <Link
                key={t.href}
                href={t.href}
                className="card"
                style={{
                  margin: 0,
                  padding: '0.75rem 1rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.75rem',
                  textDecoration: 'none',
                  color: 'inherit',
                  borderRadius: '12px',
                }}
              >
                <span style={{ fontSize: '1.3rem' }}>{t.icon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <strong style={{ fontSize: '0.88rem', color: 'var(--text-heading)' }}>{t.label}</strong>
                    {t.count !== null && (
                      <span
                        className="admin-dash-chip"
                        style={{
                          fontSize: '0.75rem',
                          fontWeight: 800,
                          padding: '0.15rem 0.5rem',
                          borderRadius: '6px',
                        }}
                      >
                        {t.count}
                      </span>
                    )}
                  </div>
                  <div className="muted small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.note}
                  </div>
                </div>
              </Link>
            ))}
        </div>
      </div>
    </div>
  )
}
