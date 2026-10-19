'use client'

import { useEffect, useRef, useState } from 'react'
import { formatMoney } from '@/lib/format'
import type { CommissionSummary } from '@/lib/commission-types'
import { LevelBadge, levelStyle } from './LevelBadge'

/** A level-up older than this is history, not news. */
const FRESH_MS = 14 * 24 * 3600 * 1000
const CONFETTI_COLORS = ['#f59e0b', '#2563eb', '#10b981', '#c084fc', '#f43f5e', '#38bdf8']

type Change = CommissionSummary['levelHistory'][number]

const storageKey = (resellerId: string) => `hxr_levelup_seen_${resellerId}`

/**
 * The latest level change, if it is a real level-up that the seller is still at, happened recently
 * and has not been acknowledged yet on this browser. Uses the existing level history from
 * /commissions/summary, so nothing is celebrated that the backend did not record.
 */
/**
 * The seller's most recent level change when it was a level-up that they are still at and that
 * happened in the last two weeks (regardless of whether the celebration was dismissed).
 */
export function recentLevelUp(summary: CommissionSummary | null): Change | null {
  const latest = summary?.levelHistory?.[0]
  if (!summary || !latest || latest.toLevel === null) return null
  const wentUp = latest.fromLevel === null || latest.toLevel > latest.fromLevel
  if (!wentUp) return null
  if (summary.level.level !== latest.toLevel) return null
  if (Date.now() - new Date(latest.createdAt).getTime() > FRESH_MS) return null
  return latest
}

function pendingLevelUp(summary: CommissionSummary, resellerId: string): Change | null {
  const latest = recentLevelUp(summary)
  if (!latest) return null
  try {
    if (window.localStorage.getItem(storageKey(resellerId)) === latest.id) return null
  } catch {
    /* storage blocked: it may show again on the next visit, which is harmless */
  }
  return latest
}

export function LevelUpCelebration({ summary, resellerId }: { summary: CommissionSummary | null; resellerId: string | null }) {
  const [change, setChange] = useState<Change | null>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (summary && resellerId) setChange(pendingLevelUp(summary, resellerId))
  }, [summary, resellerId])

  useEffect(() => {
    if (!change) return
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && dismiss()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [change])

  if (!change || !summary || !resellerId) return null

  function dismiss() {
    try {
      window.localStorage.setItem(storageKey(resellerId as string), (change as Change).id)
    } catch {
      /* ignore */
    }
    setChange(null)
  }

  const tier = summary.levels.find((l) => l.level === change.toLevel)
  const tierName = tier?.name ?? `Level ${change.toLevel}`
  const next = summary.level.nextLevel
  const example = summary.commissionPerCustomer[0]
  const metal = levelStyle(change.toLevel).metal

  return (
    <div className="levelup-overlay" role="dialog" aria-modal="true" aria-labelledby="levelup-title" onClick={dismiss}>
      <div className="levelup-confetti" aria-hidden="true">
        {Array.from({ length: 36 }).map((_, i) => (
          <span
            key={i}
            style={{
              left: `${(i * 97) % 100}%`,
              background: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
              animationDelay: `${(i % 9) * 0.12}s`,
              animationDuration: `${2.6 + (i % 5) * 0.35}s`,
              transform: `rotate(${(i * 47) % 360}deg)`,
            }}
          />
        ))}
      </div>
      <div className="levelup-card" onClick={(e) => e.stopPropagation()}>
        <div className="levelup-medal">
          <LevelBadge level={change.toLevel} name={tierName} size="xl" />
        </div>
        <span className="levelup-kicker">Level up!</span>
        <h2 id="levelup-title">You reached {tierName}</h2>
        <p className="levelup-sub">
          {metal} badge unlocked with <strong>{change.activeCustomerCount}</strong> active customer{change.activeCustomerCount === 1 ? '' : 's'}. You now earn{' '}
          <strong>{Number(tier?.ratePercent ?? summary.level.ratePercent)}%</strong> commission on every customer&apos;s monthly subscription.
        </p>
        {example && (
          <p className="levelup-split">
            On {example.product} ({formatMoney(example.baseAmount, example.currency)}/month): you earn{' '}
            <strong className="levelup-you">{formatMoney(example.amount, example.currency)}</strong>, Hexalyte keeps{' '}
            <strong>{formatMoney(example.hexalyteAmount, example.currency)}</strong>.
          </p>
        )}
        <p className="levelup-next">
          {next
            ? `${next.customersNeeded} more active customer${next.customersNeeded === 1 ? '' : 's'} to reach ${next.name} (${Number(next.ratePercent)}%).`
            : 'You have reached the highest level. Thank you for growing with Hexalyte!'}
        </p>
        <button ref={closeRef} type="button" className="btn" onClick={dismiss}>
          Continue
        </button>
      </div>
    </div>
  )
}
