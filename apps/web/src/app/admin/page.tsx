'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { api, ApiError } from '@/lib/api'
import { useAdminUser } from '@/lib/admin-context'
import { formatDate, formatMoney, monthLabel } from '@/lib/format'
import { ACTIVATION_STATUS_LABELS } from '@/lib/activation-types'
import { humanizeAction, type AdminDashboard } from '@/lib/admin-types'

function Kpi({ label, value, hint, href, tone }: { label: string; value: React.ReactNode; hint?: React.ReactNode; href?: string; tone?: 'warning' | 'primary' }) {
  const body = (
    <>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {hint && <div className="kpi-hint">{hint}</div>}
    </>
  )
  const className = `card kpi ${tone ?? ''}`
  return href ? (
    <Link href={href} className={`${className} kpi-link`}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  )
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
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load the dashboard'))
  }, [])

  if (error) {
    return (
      <main className="container">
        <div className="alert error">{error}</div>
      </main>
    )
  }
  if (!data) {
    return (
      <main className="container">
        <p className="muted">Loading…</p>
      </main>
    )
  }

  const { kpis, queue, attention, sections } = data
  const money = (v: string) => formatMoney(v, kpis.commission?.currency ?? 'LKR')
  const maxTrend = Math.max(1, ...data.activationTrend.map((t) => t.count))
  const hasAttention = attention.failedTrials7d > 0 || attention.integrationErrors.length > 0 || attention.failedActivations > 0

  const tiles: { href: string; label: string; count: number | null; note: string; permission?: string }[] = [
    { href: '/admin/resellers', label: 'Resellers', count: sections.resellers, note: `${sections.pendingApplications} pending applications`, permission: 'resellers:read' },
    { href: '/admin/products', label: 'SaaS Products', count: sections.products, note: 'Pricing, trials & integrations', permission: 'products:manage' },
    { href: '/admin/customer-accounts', label: 'Customers', count: sections.customers, note: 'Reseller customers & SaaS mapping', permission: 'accounts:read' },
    { href: '/admin/trials', label: 'Trial Requests', count: sections.trials, note: 'Trials created via partner APIs', permission: 'trials:read' },
    { href: '/admin/activations', label: 'Activation Requests', count: sections.openActivations, note: 'Open requests', permission: 'activations:read' },
    { href: '/admin/bank-slips', label: 'Bank Slips', count: sections.bankSlips, note: 'Encrypted, access logged', permission: 'bankslips:read' },
    { href: '/admin/commissions', label: 'Commissions', count: null, note: 'Approve, pay out, reports', permission: 'commissions:read' },
    { href: '/admin/notifications', label: 'Notifications', count: sections.unreadNotifications, note: 'Unread' },
    { href: '/admin/audit-logs', label: 'Audit Logs', count: null, note: 'Every admin action, append-only', permission: 'audit:read' },
    { href: '/admin/settings', label: 'Settings', count: null, note: 'Levels, bank details, system', permission: 'settings:read' },
  ]

  return (
    <main className="container">
      <div className="dash-head">
        <div>
          <h1>Admin dashboard</h1>
          <div className="muted small">
            {admin.name} · {monthLabel(data.period)}
          </div>
        </div>
      </div>

      <div className="kpi-grid">
        <Kpi label="Total resellers" value={kpis.totalResellers} hint={kpis.suspendedResellers ? `${kpis.suspendedResellers} suspended` : 'Active resellers'} href="/admin/resellers" />
        <Kpi
          label="Pending reseller approvals"
          value={kpis.pendingApprovals}
          hint="Applications awaiting review"
          href="/admin/reseller-applications"
          tone={kpis.pendingApprovals > 0 ? 'warning' : undefined}
        />
        <Kpi label="Total active customers" value={kpis.activeCustomers} hint={`${kpis.activeSubscriptions} active subscriptions`} href="/admin/customer-accounts" />
        <Kpi label="Total trial accounts" value={kpis.trialAccounts} href="/admin/trials" />
        <Kpi
          label="Pending activation requests"
          value={kpis.pendingActivations.total}
          hint={`${kpis.pendingActivations.pendingReview} new · ${kpis.pendingActivations.underReview} in review · ${kpis.pendingActivations.awaitingActivation} to activate`}
          href="/admin/activations"
          tone={kpis.pendingActivations.total > 0 ? 'warning' : undefined}
        />
        <Kpi label="Monthly subscription activations" value={kpis.monthlyActivations} hint={`Paid subscriptions for ${monthLabel(data.period)}`} />
        {kpis.commission && (
          <>
            <Kpi
              label="Pending commission"
              value={money(kpis.commission.pending)}
              hint={`${money(kpis.commission.payable)} payable now · ${kpis.commission.awaitingApprovalCount} to approve`}
              href="/admin/commissions"
            />
            <Kpi label="Paid commission" value={money(kpis.commission.paid)} hint={`${money(kpis.commission.paidThisMonth)} this month`} href="/admin/commissions" />
          </>
        )}
      </div>

      {hasAttention && (
        <div className="alert warning attention">
          <strong>Needs attention:</strong>
          {attention.failedActivations > 0 && (
            <Link href="/admin/activations">{attention.failedActivations} approved request(s) failed to activate in the SaaS</Link>
          )}
          {attention.integrationErrors.map((p) => (
            <Link key={p.id} href={`/admin/products/${p.id}`}>
              {p.name} integration error
            </Link>
          ))}
          {attention.failedTrials7d > 0 && <Link href="/admin/trials">{attention.failedTrials7d} failed trial(s) in the last 7 days</Link>}
        </div>
      )}

      <div className="dash-grid">
        {queue.activations && (
          <section className="card panel">
            <div className="panel-head">
              <h2>Activation requests to handle</h2>
              <span className="spacer" />
              <Link href="/admin/activations" className="small">
                View all
              </Link>
            </div>
            {queue.activations.length === 0 ? (
              <p className="muted small empty">Nothing waiting. All activation requests are handled.</p>
            ) : (
              <ul className="recent-list">
                {queue.activations.map((a) => (
                  <li key={a.id}>
                    <div className="recent-main">
                      <Link href={`/admin/activations/${a.id}`}>
                        <strong>{a.customerAccount.customer.displayName}</strong>
                      </Link>
                      <span className="muted small">
                        <span className="mono">{a.reference}</span> · {a.product.name} · {formatMoney(a.amount, a.currency)} · {a.reseller.code}
                      </span>
                    </div>
                    <div className="recent-amount">
                      <span className={`badge act-${a.status}`}>{ACTIVATION_STATUS_LABELS[a.status]}</span>
                      <span className="small muted">{ago(a.submittedAt)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {queue.applications && (
          <section className="card panel">
            <div className="panel-head">
              <h2>Reseller applications</h2>
              <span className="spacer" />
              <Link href="/admin/reseller-applications" className="small">
                View all
              </Link>
            </div>
            {queue.applications.length === 0 ? (
              <p className="muted small empty">No applications waiting for approval.</p>
            ) : (
              <ul className="recent-list">
                {queue.applications.map((r) => (
                  <li key={r.id}>
                    <div className="recent-main">
                      <Link href={`/admin/reseller-applications/${r.id}`}>
                        <strong>{r.businessName}</strong>
                      </Link>
                      <span className="muted small">
                        {r.fullName} · <span className="mono">{r.code}</span>
                      </span>
                    </div>
                    <span className="small muted">{ago(r.submittedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <section className="card panel">
          <div className="panel-head">
            <h2>Subscription activations</h2>
            <span className="spacer" />
            <span className="small muted">Last 6 months</span>
          </div>
          <div className="bars">
            {data.activationTrend.map((t) => (
              <div key={t.periodMonth} className="bar-row">
                <span className="small muted">{monthLabel(t.periodMonth)}</span>
                <div className="bar">
                  <div style={{ width: `${(t.count / maxTrend) * 100}%` }} />
                </div>
                <span className="small">{t.count}</span>
              </div>
            ))}
          </div>
        </section>

        {data.recentAudit && (
          <section className="card panel">
            <div className="panel-head">
              <h2>Recent admin activity</h2>
              <span className="spacer" />
              <Link href="/admin/audit-logs" className="small">
                Audit log
              </Link>
            </div>
            {data.recentAudit.length === 0 ? (
              <p className="muted small empty">No activity yet.</p>
            ) : (
              <ul className="recent-list">
                {data.recentAudit.map((a) => (
                  <li key={a.id}>
                    <div className="recent-main">
                      <strong className="small">{humanizeAction(a.action)}</strong>
                      <span className="muted small">{a.actorEmail ?? a.actorType.toLowerCase()}</span>
                    </div>
                    <span className="small muted" title={new Date(a.createdAt).toLocaleString()}>
                      {formatDate(a.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>

      <h2 style={{ marginTop: '1.75rem' }}>Admin sections</h2>
      <div className="section-grid">
        {tiles
          .filter((t) => !t.permission || can(t.permission))
          .map((t) => (
            <Link key={t.href} href={t.href} className="card section-tile">
              <div className="row">
                <strong>{t.label}</strong>
                <span className="spacer" />
                {t.count !== null && <span className="section-count">{t.count}</span>}
              </div>
              <span className="muted small">{t.note}</span>
            </Link>
          ))}
      </div>
    </main>
  )
}
