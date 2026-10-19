'use client'

import type { KeyboardEvent, ReactNode } from 'react'

/** Props that make any element act as a keyboard-operable toggle button (Enter / Space). */
export function kpiButtonProps(onClick: () => void, pressed: boolean) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    'aria-pressed': pressed,
    onClick,
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.target !== e.currentTarget) return // ignore keys pressed inside nested controls
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onClick()
      }
    },
  }
}

/** Keyboard handler for tiles that already have an onClick: Enter/Space activate it. */
export function kpiKeyDown(e: KeyboardEvent<HTMLElement>) {
  if (e.target !== e.currentTarget) return
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    e.currentTarget.click()
  }
}

const ACTIVE_COLORS = {
  indigo: 'rgba(37, 99, 235, 0.45)',
  amber: 'rgba(245, 158, 11, 0.5)',
  violet: 'rgba(168, 85, 247, 0.5)',
  emerald: 'rgba(16, 185, 129, 0.5)',
} as const

type Accent = keyof typeof ACTIVE_COLORS

interface KpiRefCardProps {
  label: string
  value: ReactNode
  /** Short pill in the footer, e.g. "Queue". */
  badge?: string
  badgeTone?: 'neutral' | 'positive'
  /** One-line description next to the pill. */
  desc?: string
  icon?: ReactNode
  accent?: Accent
  /** When provided the tile becomes a filter toggle. */
  onClick?: () => void
  active?: boolean
  title?: string
}

/**
 * The single KPI tile used on list pages. With `onClick` it is a keyboard-operable toggle
 * (focusable, Enter/Space, `aria-pressed`); without it, it is a plain read-only tile.
 */
export function KpiRefCard({
  label,
  value,
  badge,
  badgeTone = 'neutral',
  desc,
  icon,
  accent = 'indigo',
  onClick,
  active = false,
  title,
}: KpiRefCardProps) {
  const interactive = onClick ? kpiButtonProps(onClick, active) : {}
  return (
    <div
      className="card kpi-ref"
      title={title}
      style={{ ['--kpi-active' as string]: ACTIVE_COLORS[accent] }}
      {...interactive}
    >
      <div className="kpi-ref-top">
        <span className="kpi-ref-label">{label}</span>
        {icon && <div className={`kpi-ref-icon ${accent}`}>{icon}</div>}
      </div>
      <div className="kpi-ref-main">
        <div className="kpi-ref-value">{value}</div>
      </div>
      {(badge || desc) && (
        <div className="kpi-ref-footer">
          {badge && <span className={`kpi-ref-badge ${badgeTone}`}>{badge}</span>}
          {desc && <span className="kpi-ref-desc">{desc}</span>}
        </div>
      )}
    </div>
  )
}

/**
 * Grid for KPI tiles. Pass the tile count so odd counts (3, 5, 6) balance across rows instead
 * of leaving an orphaned tile (see the `.kpi-grid[data-count]` rules in globals.css).
 */
export function KpiGrid({ count, children }: { count: number; children: ReactNode }) {
  return (
    <div className="kpi-grid" data-count={count}>
      {children}
    </div>
  )
}
