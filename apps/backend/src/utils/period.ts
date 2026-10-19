import { z } from 'zod'
import { env } from '../config/env'

/** Billing month in YYYY-MM. */
export const periodMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM')

export function periodMonthOf(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: env.BUSINESS_TIMEZONE, year: 'numeric', month: '2-digit' })
    .formatToParts(date)
  const year = parts.find((p) => p.type === 'year')!.value
  const month = parts.find((p) => p.type === 'month')!.value
  return `${year}-${month}`
}

/** The calendar date (YYYY-MM-DD) in business time (see `periodMonthOf`), which can differ from the UTC date. */
export function businessDateOf(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: env.BUSINESS_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date)
  const part = (type: string) => parts.find((p) => p.type === type)!.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

export function shiftPeriod(period: string, months: number): string {
  const [y, m] = period.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + months, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * Billing months a paid activation request or a manual subscription event may cover: last month through two months
 * ahead of `current` (business time, see `periodMonthOf`).
 */
export function billingWindow(current: string = periodMonthOf()): { from: string; to: string } {
  return { from: shiftPeriod(current, -1), to: shiftPeriod(current, 2) }
}

/** The last `count` months ending with `end`, oldest first. */
export function recentPeriods(count: number, end: string = periodMonthOf()): string[] {
  return Array.from({ length: count }, (_, i) => shiftPeriod(end, i - count + 1))
}
