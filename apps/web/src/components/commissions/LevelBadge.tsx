'use client'

import type { CommissionLevel } from '@/lib/commission-types'

/**
 * Achievement badges for partner levels. Only the look is fixed here (Level 1–5 each have their
 * own metal and icon; any level above 5 reuses the Level 5 look). The level names, thresholds and
 * commission rates are never defined in this file: they always come from the Admin-managed levels.
 */
const STYLES = [
  { key: 'none', metal: 'No badge yet' },
  { key: 'l1', metal: 'Bronze' },
  { key: 'l2', metal: 'Silver' },
  { key: 'l3', metal: 'Gold' },
  { key: 'l4', metal: 'Platinum' },
  { key: 'l5', metal: 'Diamond' },
] as const

export function levelStyle(level: number | null | undefined) {
  if (!level || level < 1) return STYLES[0]
  return STYLES[Math.min(level, 5)]
}

const ICON_PROPS = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

/** One distinct glyph per level so the badges differ in shape as well as colour. */
function Glyph({ level, size }: { level: number | null | undefined; size: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true, ...ICON_PROPS }
  switch (level && level >= 1 ? Math.min(level, 5) : 0) {
    case 1: // shield
      return (
        <svg {...common}>
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
        </svg>
      )
    case 2: // star
      return (
        <svg {...common}>
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      )
    case 3: // medal
      return (
        <svg {...common}>
          <circle cx="12" cy="9" r="6" />
          <path d="m8.5 14.5-1.5 7 5-3 5 3-1.5-7" />
        </svg>
      )
    case 4: // crown
      return (
        <svg {...common}>
          <path d="m3 7 4.5 4L12 4l4.5 7L21 7l-2 12H5L3 7Z" />
        </svg>
      )
    case 5: // gem
      return (
        <svg {...common}>
          <path d="M6 3h12l4 6-10 13L2 9l4-6Z" />
          <path d="M11 3 8 9l4 13 4-13-3-6" />
          <path d="M2 9h20" />
        </svg>
      )
    default: // locked / no level
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v4l2 2" />
        </svg>
      )
  }
}

const SIZES = { sm: 28, md: 40, lg: 64, xl: 96 } as const

/**
 * The badge medal, optionally with the level name beside it.
 * `locked` greys it out (a level the seller has not reached yet).
 */
export function LevelBadge({
  level,
  name,
  size = 'md',
  locked = false,
  showName = false,
}: {
  level: number | null | undefined
  name?: string | null
  size?: keyof typeof SIZES
  locked?: boolean
  showName?: boolean
}) {
  const style = levelStyle(level)
  const px = SIZES[size]
  const title = name && name !== `Level ${level}` ? `Level ${level} · ${name}` : `Level ${level}`
  const label = level ? `${title} (${style.metal} badge)${locked ? ', not reached yet' : ''}` : 'No level yet'
  return (
    <span className={`lvl-badge ${style.key} ${size} ${locked ? 'locked' : ''}`} title={label}>
      <span className="lvl-medal" role="img" aria-label={label} style={{ width: px, height: px }}>
        <Glyph level={level} size={Math.round(px * 0.5)} />
      </span>
      {showName && (
        <span className="lvl-badge-text">
          <strong>{name ?? (level ? `Level ${level}` : 'No level yet')}</strong>
          <span>{level ? `L${level} · ${style.metal}` : 'Earn your first customer'}</span>
        </span>
      )}
    </span>
  )
}

/**
 * Every configured level as an achievement badge: reached ones are lit, the current one is
 * highlighted, the rest are locked. Thresholds and rates are shown exactly as configured.
 */
export function LevelLadder({
  levels,
  currentLevel,
  justReached = null,
}: {
  levels: CommissionLevel[]
  currentLevel: number | null
  /** A level reached recently: its badge gets a "New" tag. */
  justReached?: number | null
}) {
  if (!levels.length) return null
  const sorted = [...levels].sort((a, b) => a.level - b.level)
  return (
    <ol className="lvl-ladder" aria-label="Partner level badges">
      {sorted.map((l) => {
        const reached = currentLevel !== null && l.level <= currentLevel
        const current = currentLevel === l.level
        return (
          <li key={l.level} className={`lvl-ladder-item ${current ? 'current' : ''} ${reached ? 'reached' : 'locked'}`}>
            {justReached === l.level && <span className="lvl-new">New</span>}
            <LevelBadge level={l.level} name={l.name} size="md" locked={!reached} />
            <strong className="lvl-ladder-name">{l.name}</strong>
            <span className="lvl-ladder-meta">
              {l.minActiveCustomers}
              {l.maxActiveCustomers === null ? '+' : `–${l.maxActiveCustomers}`} customers
            </span>
            <span className="lvl-ladder-rate">{Number(l.ratePercent)}%</span>
          </li>
        )
      })}
    </ol>
  )
}
