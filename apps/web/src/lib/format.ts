export type Money = string | number | null | undefined

export function formatMoney(value: Money, currency = 'LKR'): string {
  const n = Number(value ?? 0)
  const formatted = Math.abs(n).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${n < 0 ? '-' : ''}${currency === 'LKR' ? 'Rs.' : currency} ${formatted}`
}

export function monthLabel(period: string): string {
  const [y, m] = period.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
}

/** The current billing month. Billing months follow business time (see `businessPeriod`), not the browser's local clock. */
export function currentPeriod(): string {
  return businessPeriod()
}

/** Month boundaries for billing follow this clock on the server, whatever the browser's time zone is. */
export const BUSINESS_TIMEZONE = 'Asia/Colombo'

/** The current billing month (YYYY-MM) in business time (Asia/Colombo), not the browser's local month. */
export function businessPeriod(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TIMEZONE, year: 'numeric', month: '2-digit' }).formatToParts(now)
  const year = parts.find((p) => p.type === 'year')!.value
  const month = parts.find((p) => p.type === 'month')!.value
  return `${year}-${month}`
}

/** Today's date (YYYY-MM-DD) in business time (Asia/Colombo), which can differ from the browser's local and UTC dates. */
export function businessDate(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const part = (type: string) => parts.find((p) => p.type === type)!.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

export function shiftPeriod(period: string, months: number): string {
  const [y, m] = period.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + months, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/** Billing months a paid activation or a manual subscription event may cover: last month through two months ahead. */
export function billingWindow(current: string = businessPeriod()): { from: string; to: string } {
  return { from: shiftPeriod(current, -1), to: shiftPeriod(current, 2) }
}

export function formatDate(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleDateString() : '—'
}
