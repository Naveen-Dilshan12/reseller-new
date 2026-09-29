'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { api, ApiError } from '@/lib/api'
import { useAdminUser } from '@/lib/admin-context'
import { formatDate, formatMoney, monthLabel } from '@/lib/format'
import { ACTIVATION_STATUS_LABELS } from '@/lib/activation-types'
import { humanizeAction, type AdminDashboard } from '@/lib/admin-types'

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
        borderRadius: '16px',
        padding: '1.35rem 1.45rem',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.4)',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.45rem',
        transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
        position: 'relative',
        overflow: 'hidden',
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
            fontSize: '0.74rem',
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
            width: '38px',
            height: '38px',
            borderRadius: '11px',
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
          fontSize: '1.85rem',
          fontWeight: 800,
          color: '#ffffff',
          letterSpacing: '-0.03em',
          lineHeight: 1.15,
        }}
      >
        {value}
      </div>

      {hint && (
        <div style={{ fontSize: '0.78rem', color: '#94a3b8', fontWeight: 500 }}>
          {hint}
        </div>
      )}
    </div>
  )

  if (href) {
    return (
      <Link href={href} style={{ textDecoration: 'none' }}>
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

export default function AdminDashboardPage() {
  const admin = useAdminUser()
  const can = (p: string) => admin.permissions.includes(p)
  const [data, setData] = useState<AdminDashboard | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api<AdminDashboard>('/dashboard/admin')
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load dashboard'))
  }, [])

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
  const hasAttention =
    attention.failedTrials7d > 0 ||
    attention.integrationErrors.length > 0 ||
    attention.failedActivations > 0

  const tiles = [
    { href: '/admin/resellers', label: 'Resellers', count: sections.resellers, note: `${sections.pendingApplications} pending review`, icon: '👥', permission: 'resellers:read' },
    { href: '/admin/products', label: 'SaaS Products', count: sections.products, note: 'Catalogue, pricing & partner APIs', icon: '📦', permission: 'products:manage' },
    { href: '/admin/customer-accounts', label: 'Customers & Mapping', count: sections.customers, note: 'Mapped tenants & live status', icon: '🏢', permission: 'accounts:read' },
    { href: '/admin/trials', label: 'Trial Requests', count: sections.trials, note: 'SaaS provisioning requests', icon: '⚡', permission: 'trials:read' },
    { href: '/admin/activations', label: 'Activation Requests', count: sections.openActivations, note: 'Payment reviews & approvals', icon: '🛡️', permission: 'activations:read' },
    { href: '/admin/bank-slips', label: 'Bank Slips Register', count: sections.bankSlips, note: 'Encrypted slips storage', icon: '🧾', permission: 'bankslips:read' },
    { href: '/admin/commissions', label: 'Commissions & Payouts', count: null, note: 'Batch approvals & payouts', icon: '💰', permission: 'commissions:read' },
    { href: '/admin/notifications', label: 'Notifications', count: sections.unreadNotifications, note: 'System alerts', icon: '🔔' },
    { href: '/admin/audit-logs', label: 'Audit Logs', count: null, note: 'Append-only audit trail', icon: '📜', permission: 'audit:read' },
    { href: '/admin/settings', label: 'Platform Settings', count: null, note: 'Commission tiers & bank details', icon: '⚙️', permission: 'settings:read' },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.75rem' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '1.75rem', color: '#ffffff' }}>Platform Overview</h1>
          <p className="muted small" style={{ margin: '0.25rem 0 0' }}>
            Hexalyte Central Reseller Operations · {monthLabel(data.period)}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.65rem' }}>
          <Link href="/admin/activations" className="btn small">
            Review Activations ({kpis.pendingActivations.total})
          </Link>
          <Link href="/admin/reseller-applications" className="btn secondary small">
            Applications ({kpis.pendingApprovals})
          </Link>
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
          {attention.failedTrials7d > 0 && (
            <Link href="/admin/trials" style={{ textDecoration: 'underline', marginLeft: '0.5rem' }}>
              {attention.failedTrials7d} failed trial(s) in last 7 days
            </Link>
          )}
        </div>
      )}

      {/* KPI Cards Grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
          gap: '1.1rem',
        }}
      >
        <ModernKpi
          label="Total Resellers"
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

        <ModernKpi
          label="Trial Accounts"
          value={kpis.trialAccounts}
          hint="Currently in free trial"
          href="/admin/trials"
          accentColor="#a855f7"
          iconBg="rgba(168, 85, 247, 0.15)"
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#c084fc" strokeWidth="2">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
          }
        />

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

      {/* Middle Operations Panels */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: '1.35rem' }}>
        {/* Queue 1: Activations to Handle */}
        {queue.activations && (
          <div className="card" style={{ margin: 0, padding: '1.4rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.15rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                <span style={{ fontSize: '1.2rem' }}>🛡️</span>
                <h3 style={{ margin: 0 }}>Activation Requests to Handle</h3>
              </div>
              <Link href="/admin/activations" className="small" style={{ fontWeight: 600 }}>
                View all ({queue.activations.length})
              </Link>
            </div>

            {queue.activations.length === 0 ? (
              <p className="muted small" style={{ padding: '1.5rem 0', textAlign: 'center' }}>
                All clear! No activation requests waiting for review.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                {queue.activations.map((a) => (
                  <div
                    key={a.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '0.85rem 1rem',
                      borderRadius: '12px',
                      background: 'rgba(255, 255, 255, 0.025)',
                      border: '1px solid rgba(255, 255, 255, 0.06)',
                    }}
                  >
                    <div>
                      <Link href={`/admin/activations/${a.id}`} style={{ fontWeight: 700, color: '#ffffff' }}>
                        {a.customerAccount.customer.displayName}
                      </Link>
                      <div className="muted small" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.2rem' }}>
                        <span className="mono">{a.reference}</span>
                        <span>·</span>
                        <span>{a.product.name}</span>
                        <span>·</span>
                        <strong style={{ color: '#34d399' }}>{formatMoney(a.amount, a.currency)}</strong>
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

        {/* Queue 2: Reseller Applications */}
        {queue.applications && (
          <div className="card" style={{ margin: 0, padding: '1.4rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.15rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                <span style={{ fontSize: '1.2rem' }}>📝</span>
                <h3 style={{ margin: 0 }}>Pending Reseller Applications</h3>
              </div>
              <Link href="/admin/reseller-applications" className="small" style={{ fontWeight: 600 }}>
                View all ({queue.applications.length})
              </Link>
            </div>

            {queue.applications.length === 0 ? (
              <p className="muted small" style={{ padding: '1.5rem 0', textAlign: 'center' }}>
                No reseller applications waiting for approval.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                {queue.applications.map((r) => (
                  <div
                    key={r.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '0.85rem 1rem',
                      borderRadius: '12px',
                      background: 'rgba(255, 255, 255, 0.025)',
                      border: '1px solid rgba(255, 255, 255, 0.06)',
                    }}
                  >
                    <div>
                      <Link href={`/admin/reseller-applications/${r.id}`} style={{ fontWeight: 700, color: '#ffffff' }}>
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

      {/* Visual Chart & Activity Feed */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: '1.35rem' }}>
        {/* Subscription Activations Trend Chart */}
        <div className="card" style={{ margin: 0, padding: '1.45rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.35rem' }}>
            <div>
              <h3 style={{ margin: 0 }}>Subscription Activations Trend</h3>
              <p className="muted small" style={{ margin: '0.2rem 0 0' }}>Verified monthly payments (Last 6 months)</p>
            </div>
            <span
              style={{
                fontSize: '0.76rem',
                fontWeight: 700,
                color: '#818cf8',
                background: 'rgba(99, 102, 241, 0.15)',
                border: '1px solid rgba(99, 102, 241, 0.3)',
                padding: '0.25rem 0.65rem',
                borderRadius: '8px',
              }}
            >
              Peak: {maxTrend} / mo
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
            {data.activationTrend.map((t) => {
              const pct = Math.round((t.count / maxTrend) * 100)
              return (
                <div key={t.periodMonth} style={{ display: 'flex', alignItems: 'center', gap: '0.9rem' }}>
                  <span style={{ width: '85px', fontSize: '0.84rem', fontWeight: 600, color: '#94a3b8' }}>
                    {monthLabel(t.periodMonth)}
                  </span>
                  <div
                    style={{
                      flex: 1,
                      height: '20px',
                      background: 'rgba(255, 255, 255, 0.05)',
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
                  <span style={{ width: '45px', textAlign: 'right', fontWeight: 700, fontSize: '0.9rem', color: '#ffffff' }}>
                    {t.count}
                  </span>
                </div>
              )
            })}
          </div>
        </div>

        {/* Recent Admin Activity */}
        {data.recentAudit && (
          <div className="card" style={{ margin: 0, padding: '1.45rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.35rem' }}>
              <div>
                <h3 style={{ margin: 0 }}>Recent Platform Activity</h3>
                <p className="muted small" style={{ margin: '0.2rem 0 0' }}>Tamper-proof append-only audit trail</p>
              </div>
              <Link href="/admin/audit-logs" className="small" style={{ fontWeight: 600 }}>
                Full Audit Log
              </Link>
            </div>

            {data.recentAudit.length === 0 ? (
              <p className="muted small" style={{ padding: '1.5rem 0', textAlign: 'center' }}>No activity logged yet.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                {data.recentAudit.map((a) => (
                  <div
                    key={a.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '0.75rem 0.95rem',
                      borderRadius: '10px',
                      background: 'rgba(255, 255, 255, 0.025)',
                      border: '1px solid rgba(255, 255, 255, 0.06)',
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 600, fontSize: '0.88rem', color: '#ffffff' }}>
                        {humanizeAction(a.action)}
                      </div>
                      <div className="muted small" style={{ fontSize: '0.78rem' }}>
                        {a.actorEmail ?? a.actorType.toLowerCase()}
                      </div>
                    </div>
                    <span className="muted small" style={{ fontSize: '0.76rem' }}>
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
        <h3 style={{ margin: '0.5rem 0 1.1rem', fontSize: '1.2rem', color: '#ffffff' }}>Platform Management Directory</h3>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
            gap: '0.9rem',
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
                  padding: '1.15rem 1.25rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.9rem',
                  textDecoration: 'none',
                  color: 'inherit',
                  borderRadius: '14px',
                }}
              >
                <span style={{ fontSize: '1.6rem' }}>{t.icon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <strong style={{ fontSize: '0.94rem', color: '#ffffff' }}>{t.label}</strong>
                    {t.count !== null && (
                      <span
                        style={{
                          fontSize: '0.75rem',
                          fontWeight: 800,
                          background: 'rgba(99, 102, 241, 0.15)',
                          color: '#818cf8',
                          border: '1px solid rgba(99, 102, 241, 0.3)',
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
