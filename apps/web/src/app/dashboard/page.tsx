'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { api, ApiError } from '@/lib/api'
import type { CurrentUser } from '@/lib/auth'
import { formatDate, formatMoney } from '@/lib/format'
import type { CommissionLevel } from '@/lib/commission-types'
import type { ResellerDashboard } from '@/lib/dashboard-types'
import { ResellerShell } from '@/components/ResellerShell'
import { useLanguage } from '@/lib/i18n'
import { useAppearance } from '@/lib/appearance'
import { welcomeHeading } from '@/lib/appearance-utils'
import { LevelBadge, LevelLadder } from '@/components/commissions/LevelBadge'
import { recentLevelUp } from '@/components/commissions/LevelUpCelebration'
import { usePartnerSummaryContext } from '@/components/commissions/PartnerSummaryContext'

// ─── Localized Month & Date Helpers ──────────────────────────────────────────

const SI_MONTHS = ['ජන', 'පෙබ', 'මාර්', 'අප්‍රේ', 'මැයි', 'ජූනි', 'ජූලි', 'අගෝ', 'සැප්', 'ඔක්', 'නොවැ', 'දෙසැ']

function getDefaultMonths(count = 6): string[] {
  const months: string[] = []
  const now = new Date()
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }
  return months
}

function formatMonthLabel(monthStr: string, lang: 'en' | 'si'): string {
  const parts = monthStr.split('-').map(Number)
  if (parts.length < 2) return monthStr
  const [, month] = parts
  if (lang === 'si') {
    return SI_MONTHS[month - 1] || monthStr
  }
  const date = new Date(Date.UTC(2026, month - 1, 1))
  return date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })
}

function formatDisplayDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function translateStatus(status: string, t: (k: string) => string): string {
  const key = `status.${status}`
  const translated = t(key)
  return translated === key ? status.replace(/_/g, ' ') : translated
}

function getStatusPill(status: string, t: (k: string) => string) {
  const s = (status || '').toUpperCase()
  const label = translateStatus(status, t)
  if (s === 'ACTIVE' || s === 'APPROVED' || s === 'COMPLETED') {
    return <span className="dash-pill-emerald">{label}</span>
  }
  if (s.includes('PENDING') || s.includes('PROCESSING') || s.includes('SAAS') || s.includes('REVIEW')) {
    return <span className="dash-pill-blue">{label}</span>
  }
  if (s === 'TRIAL') {
    return <span className="dash-pill-amber">{label}</span>
  }
  return <span className="dash-pill-muted">{label}</span>
}

// ─── Primary KPI Card V2 Component ───────────────────────────────────────────

function KpiCardV2({
  label,
  value,
  sub,
  href,
  icon,
  accent,
}: {
  label: string
  value: React.ReactNode
  sub: string
  href?: string
  icon: React.ReactNode
  accent: 'blue' | 'emerald' | 'amber' | 'purple'
}) {
  const content = (
    <div className={`kpi-card-v2 accent-${accent}`}>
      <div className="kpi-card-v2-left">
        <div className={`kpi-card-v2-icon ${accent}`}>{icon}</div>
        <div className="kpi-card-v2-body">
          <span className="kpi-card-v2-label">{label}</span>
          <span className="kpi-card-v2-value">{value}</span>
          <span className="kpi-card-v2-sub">{sub}</span>
        </div>
      </div>
      <span className="kpi-card-v2-arrow" aria-hidden="true">&rsaquo;</span>
    </div>
  )

  return href ? (
    <Link href={href} style={{ textDecoration: 'none', color: 'inherit' }}>
      {content}
    </Link>
  ) : (
    content
  )
}

// ─── Customer Growth Line Chart (SVG) ─────────────────────────────────────────

function CustomerGrowthChart({
  data,
  lang,
  t,
}: {
  data: { month: string; count: number }[]
  lang: 'en' | 'si'
  t: (k: string) => string
}) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)

  const chartData = data && data.length > 0 ? data : getDefaultMonths(6).map((m) => ({ month: m, count: 0 }))
  const counts = chartData.map((d) => d.count)
  // Axis top: at least 6, rounded up to a multiple of 3 so the 4 ticks (0, ⅓, ⅔, top) are whole numbers.
  // The tick labels are derived from this same value, so they always match the plotted line.
  const maxCount = Math.max(Math.ceil(Math.max(...counts, 6) / 3) * 3, 6)

  const svgW = 500
  const svgH = 185
  const padL = 35
  const padR = 25
  const padT = 20
  const padB = 35
  const chartW = svgW - padL - padR
  const chartH = svgH - padT - padB

  const n = chartData.length || 1
  const stepX = n > 1 ? chartW / (n - 1) : chartW

  const points = chartData.map((d, i) => {
    const x = padL + i * stepX
    const y = padT + chartH - (d.count / maxCount) * chartH
    return { x, y, count: d.count, month: d.month }
  })

  const lineD = points.length > 0 ? points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ') : ''
  const areaD = points.length > 0 ? `${lineD} L ${points[points.length - 1].x.toFixed(1)} ${padT + chartH} L ${points[0].x.toFixed(1)} ${padT + chartH} Z` : ''

  const yTicks = [maxCount, (maxCount * 2) / 3, maxCount / 3, 0]

  return (
    <div className="analytics-chart-container" style={{ height: '185px' }}>
      <svg viewBox={`0 0 ${svgW} ${svgH}`} className="analytics-svg" preserveAspectRatio="none">
        <defs>
          <linearGradient id="growthAreaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#2563eb" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#2563eb" stopOpacity="0.0" />
          </linearGradient>
        </defs>

        {/* Gridlines */}
        {yTicks.map((val) => {
          const ratio = val / maxCount
          const y = padT + chartH * (1 - ratio)
          return (
            <g key={val}>
              <line x1={padL} y1={y} x2={padL + chartW} y2={y} stroke="var(--border)" strokeDasharray="3 3" />
              <text x={padL - 10} y={y + 3.5} textAnchor="end" className="chart-axis-text">
                {val}
              </text>
            </g>
          )
        })}

        {/* Area fill & curve */}
        {areaD && <path d={areaD} fill="url(#growthAreaGrad)" />}
        {lineD && <path d={lineD} fill="none" stroke="#2563eb" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />}

        {/* Data points & X-axis labels */}
        {points.map((p, idx) => {
          const isHovered = hoveredIdx === idx
          return (
            <g key={idx} onMouseEnter={() => setHoveredIdx(idx)} onMouseLeave={() => setHoveredIdx(null)}>
              <circle
                cx={p.x}
                cy={p.y}
                r={isHovered ? 5.5 : 4}
                fill="#2563eb"
                stroke="var(--surface)"
                strokeWidth={isHovered ? 2 : 1.5}
                style={{ cursor: 'pointer', transition: 'r 0.15s ease' }}
              />
              {/* X Axis Label */}
              <text x={p.x} y={svgH - 8} textAnchor="middle" className="chart-axis-text">
                {formatMonthLabel(p.month, lang)}
              </text>
              {/* Hover Tooltip */}
              {isHovered && (
                <g>
                  <rect
                    x={Math.max(10, Math.min(svgW - 90, p.x - 45))}
                    y={Math.max(4, p.y - 28)}
                    width="90"
                    height="22"
                    rx="5"
                    fill="var(--surface-elevated)"
                    stroke="var(--border)"
                    strokeWidth="1"
                  />
                  <text
                    x={Math.max(10, Math.min(svgW - 90, p.x - 45)) + 45}
                    y={Math.max(4, p.y - 28) + 14}
                    textAnchor="middle"
                    style={{ fontSize: '10.5px', fontWeight: 700, fill: 'var(--text-heading)' }}
                  >
                    {p.count} {t('dash.analytics.customers')}
                  </text>
                </g>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

// ─── Commission Earnings Bar Chart (SVG) ──────────────────────────────────────

function CommissionEarningsChart({
  data,
  lang,
  t,
}: {
  data: { month: string; earned: string; paid: string }[] | null
  lang: 'en' | 'si'
  t: (k: string) => string
}) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)

  const chartData = data && data.length > 0 ? data : getDefaultMonths(6).map((m) => ({ month: m, earned: '0', paid: '0' }))
  const numericEarned = chartData.map((d) => Number(d.earned) || 0)
  const numericPaid = chartData.map((d) => Number(d.paid) || 0)
  // Axis top: at least 5k, rounded up to a multiple of 5k; tick labels are derived from the same value
  const maxVal = Math.ceil(Math.max(...numericEarned, ...numericPaid, 5000) / 5000) * 5000

  const svgW = 500
  const svgH = 185
  const padL = 40
  const padR = 25
  const padT = 20
  const padB = 35
  const chartW = svgW - padL - padR
  const chartH = svgH - padT - padB

  const n = chartData.length || 1
  const stepX = chartW / n
  const barW = Math.min(12, stepX * 0.22)
  const barGap = 3

  const compact = (v: number) => (v >= 1000 ? `${v / 1000}k` : String(v))
  const yTicks = [1, 0.6, 0].map((ratio) => ({ label: compact(maxVal * ratio), ratio }))

  return (
    <div className="analytics-chart-container" style={{ height: '185px' }}>
      <svg viewBox={`0 0 ${svgW} ${svgH}`} className="analytics-svg" preserveAspectRatio="none">
        {/* Gridlines */}
        {yTicks.map((tick) => {
          const y = padT + chartH * (1 - tick.ratio)
          return (
            <g key={tick.label}>
              <line x1={padL} y1={y} x2={padL + chartW} y2={y} stroke="var(--border)" strokeDasharray="3 3" />
              <text x={padL - 10} y={y + 3.5} textAnchor="end" className="chart-axis-text">
                {tick.label}
              </text>
            </g>
          )
        })}

        {/* Bars */}
        {chartData.map((item, idx) => {
          const earned = Number(item.earned) || 0
          const paid = Number(item.paid) || 0
          const hEarned = maxVal > 0 ? (earned / maxVal) * chartH : 0
          const hPaid = maxVal > 0 ? (paid / maxVal) * chartH : 0

          const centerX = padL + idx * stepX + stepX / 2
          const xEarned = centerX - barW - barGap / 2
          const xPaid = centerX + barGap / 2
          const yEarned = padT + chartH - hEarned
          const yPaid = padT + chartH - hPaid

          const isHovered = hoveredIdx === idx

          return (
            <g key={idx} onMouseEnter={() => setHoveredIdx(idx)} onMouseLeave={() => setHoveredIdx(null)}>
              {/* Earned Bar (Hexalyte Blue #2563EB) */}
              {hEarned > 0 ? (
                <rect x={xEarned} y={yEarned} width={barW} height={hEarned} fill="#2563eb" rx="3" />
              ) : (
                <line x1={xEarned} y1={padT + chartH} x2={xEarned + barW} y2={padT + chartH} stroke="rgba(37, 99, 235, 0.3)" strokeWidth="1" />
              )}

              {/* Paid Bar (Muted Gold #F59E0B) */}
              {hPaid > 0 ? (
                <rect x={xPaid} y={yPaid} width={barW} height={hPaid} fill="#f59e0b" rx="3" />
              ) : (
                <line x1={xPaid} y1={padT + chartH} x2={xPaid + barW} y2={padT + chartH} stroke="rgba(245, 158, 11, 0.3)" strokeWidth="1" />
              )}

              {/* X Axis Label */}
              <text x={centerX} y={svgH - 8} textAnchor="middle" className="chart-axis-text">
                {formatMonthLabel(item.month, lang)}
              </text>

              {/* Hover Tooltip */}
              {isHovered && (
                <g>
                  <rect
                    x={Math.max(10, Math.min(svgW - 140, centerX - 65))}
                    y={Math.max(4, Math.min(yEarned, yPaid) - 34)}
                    width="130"
                    height="30"
                    rx="6"
                    fill="var(--surface-elevated)"
                    stroke="var(--border)"
                    strokeWidth="1"
                  />
                  <text
                    x={Math.max(10, Math.min(svgW - 140, centerX - 65)) + 65}
                    y={Math.max(4, Math.min(yEarned, yPaid) - 34) + 14}
                    textAnchor="middle"
                    style={{ fontSize: '10px', fill: '#3b82f6', fontWeight: 600 }}
                  >
                    {t('dash.analytics.earned')}: {formatMoney(earned, 'LKR')}
                  </text>
                  <text
                    x={Math.max(10, Math.min(svgW - 140, centerX - 65)) + 65}
                    y={Math.max(4, Math.min(yEarned, yPaid) - 34) + 25}
                    textAnchor="middle"
                    style={{ fontSize: '10px', fill: '#f59e0b', fontWeight: 600 }}
                  >
                    {t('dash.analytics.paid')}: {formatMoney(paid, 'LKR')}
                  </text>
                </g>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

// ─── Main Dashboard Page ──────────────────────────────────────────────────────

function Dashboard({ user }: { user: CurrentUser }) {
  const { t, language } = useLanguage()
  const partnerSummary = usePartnerSummaryContext()
  // Admin-managed welcome text; falls back to the built-in translation while unset or unavailable.
  // (The hero image is applied for every reseller page by ResellerShell.)
  const appearance = useAppearance()
  const [data, setData] = useState<ResellerDashboard | null>(null)
  const [tierRules, setTierRules] = useState<CommissionLevel[]>([])
  const [tierRulesFailed, setTierRulesFailed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let active = true
    api<CommissionLevel[]>('/commissions/levels')
      .then((res) => {
        if (!active) return
        if (Array.isArray(res)) setTierRules(res)
        else setTierRulesFailed(true)
      })
      // Rates come from the admin-editable settings; if they can't be loaded we say so
      // instead of showing built-in numbers that may no longer be true.
      .catch(() => active && setTierRulesFailed(true))
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    if (!user.reseller || user.reseller.status !== 'ACTIVE') {
      setData({
        reseller: {
          id: user.reseller?.id || '',
          code: user.reseller?.code || '',
          businessName: user.reseller?.businessName || user.name,
        },
        products: [],
        filters: { from: null, to: null, productId: null },
        kpis: {
          level: {
            level: null,
            name: null,
            activeCount: 0,
            nextLevel: { name: 'Level 1', customersNeeded: 1 },
            ratePercent: '0',
          },
          activeCustomers: 0,
          totalCustomers: 0,
          trialCustomers: 0,
          activeSubscriptions: 0,
          pendingActivationRequests: 0,
          commission: { currency: 'LKR', thisMonth: '0.00', pending: '0.00', paid: '0.00' },
        },
        period: {
          newCustomers: 0,
          trialsCreated: 0,
          activationsSubmitted: 0,
          commissionEarned: '0.00',
          commissionPaid: '0.00',
        },
        recent: { customers: [], trials: [], activations: [], commissions: [] },
        analytics: { customerGrowth: [], commissionEarnings: [] },
      })
      setLoading(false)
      setError(null)
      return
    }

    setLoading(true)
    setError(null)
    api<ResellerDashboard>('/dashboard/reseller')
      .then((d) => {
        if (cancelled) return
        setData(d)
      })
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : t('dash.error.load')))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [user.reseller, user.name, t, attempt])

  const formattedUserName = user.name
    ? user.name
        .split(' ')
        .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1).toLowerCase() : ''))
        .join(' ')
    : user.name

  // The welcome hero needs nothing from the dashboard request, so it stays on screen while that request is pending, has failed
  // or is being retried. Only the data sections below it are replaced by the loading text or the error with its Retry.
  const hero = (
    <div className="dash-welcome-hero-v2">
      <div className="dash-hero-content">
        <span className="dash-hero-greeting">{t('dash.hero.greeting')}</span>
        <h1 className="dash-hero-title">{welcomeHeading(language, appearance, formattedUserName, t('dash.hero.welcome', { name: formattedUserName }))}</h1>
        <p className="dash-hero-subtitle">{t('dash.hero.subtitle')}</p>
      </div>

      {user.permissions.includes('demos:create') && (
        <div className="dash-hero-actions">
          <Link href="/demo-requests/new" className="dash-primary-btn">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M3 9h18" />
              <path d="m9 15 2 2 4-4" />
            </svg>
            <span>{t('dash.newDemoRequestBtn')}</span>
          </Link>
        </div>
      )}
    </div>
  )

  if (!data) {
    return (
      <>
        <div className="dash-hero-kpi-backdrop">{hero}</div>
        {error ? (
          <div className="alert error" role="alert">
            {error}{' '}
            <button className="btn secondary small" onClick={() => setAttempt((n) => n + 1)}>
              {t('common.retry')}
            </button>
          </div>
        ) : (
          <p className="muted" style={{ padding: '1rem 0' }}>{t('common.loading')}</p>
        )}
      </>
    )
  }

  const { kpis, recent, analytics } = data
  const level = kpis.level

  // Partner tier rates. The CURRENT rate is the server's own figure from /dashboard/reseller.
  // The NEXT level's rate comes from the live (admin-editable) commission settings; if those
  // could not be loaded it is shown as "—" instead of a built-in guess that may be out of date.
  const asPercent = (rate: string | number | null | undefined): string | null =>
    rate === null || rate === undefined || rate === '' ? null : `${Number(rate)}%`

  const settingsRateFor = (name: string): string | null => {
    const match = tierRules.find((r) => r.name.toLowerCase() === name.toLowerCase())
    return match ? asPercent(match.ratePercent) : null
  }

  const currentCount = level.activeCount ?? 0
  const neededForNext = level.nextLevel?.customersNeeded ?? 0
  const targetNext = currentCount + neededForNext
  const progressPercent = !level.nextLevel
    ? 100
    : targetNext > 0
      ? Math.min(100, Math.max(0, Math.round((currentCount / targetNext) * 100)))
      : 0

  const currentLevelName =
    level.level !== null
      ? (level.name ?? `Level ${level.level}`)
      : currentCount > 0
        ? (level.name ?? 'Level 1')
        : t('dash.growth.standardPartner')

  const currentCommissionRate =
    level.level === null && currentCount === 0 ? '0%' : (asPercent(level.ratePercent) ?? '—')

  const nextLevelName = level.nextLevel ? level.nextLevel.name : t('dash.growth.maxLevelReached')

  // A level reached in the last two weeks (from the backend's recorded level history) is marked as new.
  const justReachedLevel = recentLevelUp(partnerSummary)?.toLevel ?? null
  // Levels are numbered 1, 2, 3… without gaps, so the next level is always the current one + 1.
  const nextBadgeLevel = level.nextLevel ? (level.level ?? 0) + 1 : null

  const nextCommissionRate = level.nextLevel
    ? (settingsRateFor(level.nextLevel.name) ?? (currentCount === 0 ? (asPercent(level.ratePercent) ?? '—') : '—'))
    : '—'

  // Commission already paid out to this reseller (NOT total earned: pending/payable are separate)
  const commissionPaidAmount = kpis.commission?.paid ? Number(kpis.commission.paid) : 0

  // Recent paid-activation requests for the activity panel (up to 5 items)
  const recentActivations = (recent.activations || [])
    .map((ac) => ({
      id: ac.id,
      customerName: ac.customerAccount?.customer?.displayName || '—',
      productName: ac.product?.name || '—',
      date: ac.submittedAt,
      status: ac.status,
      href: `/activations/${ac.id}`,
    }))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 5)

  return (
    <>
      {/* ── Hero + KPI Backdrop (single landscape background) ── */}
      <div className="dash-hero-kpi-backdrop">
        {/* ── Welcome Hero Banner ── */}
        {hero}

        {/* ── 4 Primary KPI Cards in One Row (glass cards over landscape) ── */}
        <div className="kpi-grid-v2">
          <KpiCardV2
            label={t('dash.kpi.totalCustomers')}
            value={kpis.totalCustomers}
            sub={t('dash.kpi.totalCustomersHint')}
            accent="blue"
            icon={
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            }
          />
          <KpiCardV2
            label={t('dash.kpi.activeCustomers')}
            value={kpis.activeCustomers}
            sub={t('dash.kpi.activeCustomersHintPlural', { count: kpis.activeCustomers })}
            accent="emerald"
            icon={
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <polyline points="9 12 12 15 16 10" />
              </svg>
            }
          />
          <KpiCardV2
            label={t('dash.kpi.pendingActivations')}
            value={kpis.pendingActivationRequests ?? 0}
            sub={t('dash.kpi.pendingActivationsHint')}
            href={user.permissions.includes('activations:read') ? '/activations' : undefined}
            accent="amber"
            icon={
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
            }
          />
          <KpiCardV2
            label={t('dash.kpi.commissionPaid')}
            value={formatMoney(commissionPaidAmount, 'LKR')}
            sub={t('dash.kpi.commissionPaidHint')}
            href="/commissions"
            accent="purple"
            icon={
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="1" x2="12" y2="23" />
                <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
              </svg>
            }
          />
        </div>
      </div>

      {/* ── Partner Onboarding Notice (If Pending/Not Active) ── */}
      {(!user.reseller || user.reseller.status !== 'ACTIVE') && (
        <div className="card" style={{ marginBottom: '1.35rem', borderLeft: user.reseller?.status === 'PENDING' ? '4px solid #f59e0b' : '4px solid #2563eb' }}>
          {user.reseller?.status === 'PENDING' ? (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                <strong style={{ fontSize: '1.05rem', color: 'var(--text-heading)' }}>{t('dash.onboarding.underReviewTitle')}</strong>
                <span className="badge PENDING">{t('dash.onboarding.underReviewBadge')}</span>
              </div>
              <p className="muted small" style={{ margin: '0 0 0.8rem' }}>
                {t('dash.onboarding.underReviewDesc', { name: user.reseller?.businessName || '', code: user.reseller?.code || '' })}
              </p>
            </div>
          ) : user.reseller?.status === 'REJECTED' ? (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                <strong style={{ fontSize: '1.05rem', color: '#ef4444' }}>{t('dash.onboarding.rejectedTitle')}</strong>
                <span className="badge REJECTED">{t('dash.onboarding.rejectedBadge')}</span>
              </div>
              <p className="muted small" style={{ margin: '0 0 0.8rem' }}>
                {t('dash.onboarding.rejectedDesc')}
              </p>
              <Link href="/dashboard/become-reseller" className="btn small">
                {t('dash.onboarding.reapplyBtn')}
              </Link>
            </div>
          ) : (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                <strong style={{ fontSize: '1.05rem', color: 'var(--text-heading)' }}>{t('dash.onboarding.verifiedTitle')}</strong>
                <span className="badge ACTIVE">{t('dash.onboarding.verifiedBadge')}</span>
              </div>
              <p className="muted small" style={{ margin: '0 0 0.8rem' }}>
                {t('dash.onboarding.verifiedDesc')}
              </p>
              <Link href="/dashboard/become-reseller" className="btn small">
                {t('dash.onboarding.startAppBtn')}
              </Link>
            </div>
          )}
        </div>
      )}



      {/* ── Partner Level & Growth Progress Card ── */}
      <div className="partner-growth-v2">
        <div className="partner-growth-v2-header">
          <div className="partner-growth-v2-title-group">
            {/* The seller's achievement badge for their current level (look by level, name from the Admin-managed levels) */}
            <LevelBadge level={level.level} name={level.name} size="lg" />
            <div>
              <h3 className="partner-growth-v2-title">{t('dash.growth.title')}</h3>
              <p className="partner-growth-v2-sub">{t('dash.growth.subtitle')}</p>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            {justReachedLevel !== null && <span className="partner-growth-levelup">{t('dash.growth.leveledUp')}</span>}
            <span className="partner-growth-v2-level-badge">{t('dash.growth.qualifying', { count: currentCount })}</span>
          </div>
        </div>

        <div className="partner-growth-v2-boxes">
          {/* Box 1: Current Level & Commission */}
          <div className="partner-growth-box">
            <div className="partner-growth-box-col">
              <span className="partner-growth-box-label">{t('dash.growth.currentLevel')}</span>
              <span className="partner-growth-box-val">{currentLevelName}</span>
            </div>
            <div className="partner-growth-box-col" style={{ alignItems: 'flex-end' }}>
              <span className="partner-growth-box-label">{t('dash.growth.currentCommission')}</span>
              <span className="partner-growth-box-val blue">{currentCommissionRate}</span>
            </div>
          </div>

          {/* Box 2: Next Level & Commission */}
          <div className="partner-growth-box">
            <div className="partner-growth-box-col">
              <span className="partner-growth-box-label">{t('dash.growth.nextLevel')}</span>
              <span className="partner-growth-box-val">{nextLevelName}</span>
            </div>
            <div className="partner-growth-box-col" style={{ alignItems: 'flex-end' }}>
              <span className="partner-growth-box-label">{t('dash.growth.nextCommission')}</span>
              <span className="partner-growth-box-val emerald">{nextCommissionRate}</span>
            </div>
          </div>

          {/* Box 3: Target box */}
          <div className="partner-growth-target-box">
            <div className="partner-growth-target-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            </div>
            <div className="partner-growth-target-main">
              <span className="partner-growth-target-text">
                {level.nextLevel
                  ? t('dash.growth.targetText', { count: neededForNext })
                  : t('dash.growth.topLevelReached', { rate: currentCommissionRate })}
              </span>
              <span className="partner-growth-target-sub">
                {level.nextLevel ? t('dash.growth.toReach', { level: nextLevelName }) : ''}
              </span>
            </div>
          </div>
        </div>

        {/* Progress Bar & Labels */}
        <div className="partner-growth-progress-container">
          {/* current badge → progress → next badge (locked until reached) */}
          <div className="partner-growth-progress-row">
            <LevelBadge level={level.level} name={level.name} size="sm" />
            <div className="partner-growth-track" style={{ flex: 1, minWidth: 0 }}>
              <div className="partner-growth-bar" style={{ width: `${progressPercent}%` }} />
            </div>
            {nextBadgeLevel !== null && <LevelBadge level={nextBadgeLevel} name={level.nextLevel?.name} size="sm" locked />}
          </div>
          <div className="partner-growth-progress-footer">
            <span>
              {level.nextLevel
                ? t('dash.growth.progressCount', { current: currentCount, target: targetNext })
                : t('dash.growth.progressCountFull', { current: currentCount })}
            </span>
            <span style={{ fontWeight: 600 }}>{t('dash.growth.percentComplete', { percent: progressPercent })}</span>
          </div>
        </div>
        {/* Achievement badges: every level the Admin has configured, reached ones lit */}
        {tierRules.length > 0 && (
          <div style={{ marginTop: '1.15rem' }}>
            <div className="small muted" style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.6rem' }}>
              {t('dash.growth.badges')}
            </div>
            <LevelLadder levels={tierRules} currentLevel={level.level} justReached={justReachedLevel} />
          </div>
        )}
        {tierRulesFailed && level.nextLevel && (
          <p className="small muted" role="status" style={{ margin: '0.75rem 0 0' }}>
            {t('dash.rates.unavailable')}
          </p>
        )}
      </div>

      {/* ── Business Analytics: Two Real Data Graphs ── */}
      <section className="analytics-section-v2">
        <div className="analytics-v2-header">
          <div className="analytics-v2-title-group">
            <div className="analytics-v2-icon" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="20" x2="18" y2="10" />
                <line x1="12" y1="20" x2="12" y2="4" />
                <line x1="6" y1="20" x2="6" y2="14" />
              </svg>
            </div>
            <div>
              <h2 className="analytics-v2-title">{t('dash.analytics.title')}</h2>
              <p className="analytics-v2-sub">{t('dash.analytics.subtitle')}</p>
            </div>
          </div>

          {/* The server always returns the last 6 months, so this states the period; it is not a selector. */}
          <div className="analytics-v2-range-label">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="3" y1="10" x2="21" y2="10" />
            </svg>
            <span>{t('dash.analytics.range6m')}</span>
          </div>
        </div>

        <div className="analytics-v2-grid">
          {/* Chart 1: Customer Growth */}
          <div className="analytics-v2-card">
            <div className="analytics-v2-card-head">
              <div className="analytics-v2-card-title-group">
                <div className="analytics-v2-card-icon blue">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                </div>
                <div>
                  <h3 className="analytics-v2-card-title">{t('dash.analytics.customerGrowth')}</h3>
                  <p className="analytics-v2-card-desc">{t('dash.analytics.customerGrowthDesc')}</p>
                </div>
              </div>
              <div className="analytics-v2-legend">
                <div className="analytics-v2-legend-item">
                  <span className="analytics-v2-legend-square" style={{ background: '#2563eb' }} />
                  <span>{t('dash.analytics.customers')}</span>
                </div>
              </div>
            </div>
            <CustomerGrowthChart data={analytics?.customerGrowth || []} lang={language} t={t} />
          </div>

          {/* Chart 2: Commission Earnings */}
          <div className="analytics-v2-card">
            <div className="analytics-v2-card-head">
              <div className="analytics-v2-card-title-group">
                <div className="analytics-v2-card-icon gold">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="1" x2="12" y2="23" />
                    <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                  </svg>
                </div>
                <div>
                  <h3 className="analytics-v2-card-title">{t('dash.analytics.commissions')}</h3>
                  <p className="analytics-v2-card-desc">{t('dash.analytics.commissionsDesc')}</p>
                </div>
              </div>
              <div className="analytics-v2-legend">
                <div className="analytics-v2-legend-item">
                  <span className="analytics-v2-legend-square" style={{ background: '#2563eb' }} />
                  <span>{t('dash.analytics.earned')}</span>
                </div>
                <div className="analytics-v2-legend-item">
                  <span className="analytics-v2-legend-square" style={{ background: '#f59e0b' }} />
                  <span>{t('dash.analytics.paid')}</span>
                </div>
              </div>
            </div>
            <CommissionEarningsChart data={analytics?.commissionEarnings || null} lang={language} t={t} />
          </div>
        </div>
      </section>

      {/* ── Recent Activity: Two Balanced Side-by-Side Panels ── */}
      <div className="activity-v2-grid">
        {/* Panel 1: Recent Customers */}
        <section className="activity-v2-card">
          <div className="activity-v2-head">
            <div className="activity-v2-title-group">
              <div className="activity-v2-icon blue">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              </div>
              <div>
                <h3 className="activity-v2-title">{t('dash.recent.customersTitle')}</h3>
                <p className="activity-v2-desc">{t('dash.recent.customersSub')}</p>
              </div>
            </div>
            <Link href="/customers" className="activity-v2-viewall">
              <span>View All</span>
              <span>&rarr;</span>
            </Link>
          </div>

          {recent.customers.length === 0 ? (
            <div className="analytics-empty-box">
              <p className="small muted" style={{ margin: 0 }}>{t('dash.recent.emptyCustomers')}</p>
            </div>
          ) : (
            <ul className="activity-v2-list">
              {recent.customers.slice(0, 5).map((c) => {
                const initial = c.displayName ? c.displayName.trim()[0]?.toUpperCase() : '—'
                // Real data only: a customer with no SaaS account says so instead of showing a made-up product/status
                const primaryAccount = c.accounts && c.accounts.length > 0 ? c.accounts[0] : null
                const extraAccounts = (c.accounts?.length ?? 0) - 1
                const productName = primaryAccount
                  ? `${primaryAccount.product.name}${extraAccounts > 0 ? ` +${extraAccounts}` : ''}`
                  : t('dash.recent.noAccount')

                return (
                  <li key={c.id} className="activity-v2-item">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minWidth: 0, flex: 1 }}>
                      <div className="activity-v2-avatar">{initial}</div>
                      <div className="activity-v2-main">
                        <span className="activity-v2-name">{c.displayName}</span>
                        <span className="activity-v2-product">{productName}</span>
                      </div>
                    </div>
                    <div className="activity-v2-right">
                      {primaryAccount && getStatusPill(primaryAccount.status, t)}
                      <span className="activity-v2-date">{formatDisplayDate(c.createdAt)}</span>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        {/* Panel 2: Recent Activations */}
        <section className="activity-v2-card">
          <div className="activity-v2-head">
            <div className="activity-v2-title-group">
              <div className="activity-v2-icon gold">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                </svg>
              </div>
              <div>
                <h3 className="activity-v2-title">{t('dash.recent.activityTitle')}</h3>
                <p className="activity-v2-desc">{t('dash.recent.activitySub')}</p>
              </div>
            </div>
            <Link href="/activations" className="activity-v2-viewall">
              <span>View All</span>
              <span>&rarr;</span>
            </Link>
          </div>

          {recentActivations.length === 0 ? (
            <div className="analytics-empty-box">
              <p className="small muted" style={{ margin: 0 }}>{t('dash.recent.emptyActivity')}</p>
            </div>
          ) : (
            <ul className="activity-v2-list">
              {recentActivations.map((item) => {
                const initial = item.customerName ? item.customerName.trim()[0]?.toUpperCase() : '—'

                return (
                  <li key={item.id} className="activity-v2-item">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minWidth: 0, flex: 1 }}>
                      <div className="activity-v2-avatar">{initial}</div>
                      <div className="activity-v2-main">
                        <Link href={item.href} style={{ textDecoration: 'none', color: 'inherit' }}>
                          <span className="activity-v2-name">{item.customerName}</span>
                        </Link>
                        <span className="activity-v2-product">{item.productName}</span>
                      </div>
                    </div>
                    <div className="activity-v2-right">
                      {getStatusPill(item.status, t)}
                      <span className="activity-v2-date">{formatDisplayDate(item.date)}</span>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>
    </>
  )
}

export default function DashboardPage() {
  return (
    <ResellerShell>
      {(user) => (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <Dashboard user={user} />
        </div>
      )}
    </ResellerShell>
  )
}
