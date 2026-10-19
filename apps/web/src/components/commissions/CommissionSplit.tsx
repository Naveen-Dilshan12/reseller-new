'use client'

import { useState } from 'react'
import { formatMoney } from '@/lib/format'
import type { CommissionSummary } from '@/lib/commission-types'
import { LevelBadge } from './LevelBadge'

/** Same formula as the backend ledger: price × rate ÷ 100, to 2 decimals. */
const commissionOf = (price: number, ratePercent: number) => Math.round(price * ratePercent) / 100

/**
 * Where each customer's monthly subscription goes: the seller's commission (the Admin-configured
 * rate of their level) and Hexalyte's remaining amount. Prices come from the product settings and
 * rates/thresholds from the commission levels; nothing is built into this component.
 */
export function CommissionSplit({ summary }: { summary: CommissionSummary }) {
  const products = summary.commissionPerCustomer
  const [selected, setSelected] = useState(0)
  if (!products.length) return null

  const product = products[Math.min(selected, products.length - 1)]
  const price = Number(product.baseAmount)
  const levels = [...summary.levels].sort((a, b) => a.level - b.level)

  return (
    <div className="card" style={{ marginBottom: '1.25rem' }}>
      <h2 style={{ marginTop: 0 }}>Commission split</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        Your commission is your level&apos;s percentage of each customer&apos;s monthly subscription price. The remaining amount stays with
        Hexalyte. Percentages and level thresholds are set by Hexalyte Admin.
      </p>

      <div className="page-grid" style={{ marginBottom: 0 }}>
        {/* At the seller's current level, per product */}
        <div>
          <div className="small muted" style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.6rem' }}>
            At your current level ({Number(summary.level.effectiveRatePercent)}%)
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {products.map((p) => {
              const rate = Number(p.ratePercent)
              return (
                <div key={p.productCode}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap', marginBottom: '0.4rem' }}>
                    <strong>{p.product}</strong>
                    <span className="muted small">{formatMoney(p.baseAmount, p.currency)} / month</span>
                  </div>
                  <div className="split-bar" role="img" aria-label={`${rate}% to you, ${Math.round((100 - rate) * 100) / 100}% to Hexalyte`}>
                    <div className="you" style={{ width: `${rate}%` }} />
                    <div className="hexa" style={{ width: `${100 - rate}%` }} />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap', marginTop: '0.4rem' }}>
                    <span className="split-key you">
                      Your commission <span className="amount-you">{formatMoney(p.amount, p.currency)}</span>
                    </span>
                    <span className="split-key hexa">
                      Hexalyte keeps <span className="amount-hexa">{formatMoney(p.hexalyteAmount, p.currency)}</span>
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* The same split at every configured level */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '0.6rem' }}>
            <span className="small muted" style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              By level{products.length === 1 ? ` · ${formatMoney(product.baseAmount, product.currency)} / month` : ''}
            </span>
            {products.length > 1 && (
              <div className="field" style={{ margin: 0, minWidth: '240px', maxWidth: '100%' }}>
                <select aria-label="Product to calculate for" value={selected} onChange={(e) => setSelected(Number(e.target.value))}>
                  {products.map((p, i) => (
                    <option key={p.productCode} value={i}>
                      {p.product} · {formatMoney(p.baseAmount, p.currency)}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <div className="table-wrap" style={{ marginBottom: 0 }}>
            <table className="split-table">
              <thead>
                <tr>
                  <th>Level</th>
                  <th>Customers</th>
                  <th style={{ textAlign: 'right' }}>Rate</th>
                  <th style={{ textAlign: 'right' }}>You earn</th>
                  <th style={{ textAlign: 'right' }}>Hexalyte keeps</th>
                </tr>
              </thead>
              <tbody>
                {levels.map((l) => {
                  const rate = Number(l.ratePercent)
                  const you = commissionOf(price, rate)
                  return (
                    <tr key={l.level} className={l.level === summary.level.level ? 'highlight' : undefined}>
                      <td>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
                          <LevelBadge level={l.level} name={l.name} size="sm" locked={summary.level.level === null || l.level > summary.level.level} />
                          {l.name}
                        </span>
                      </td>
                      <td className="small">
                        {l.minActiveCustomers}
                        {l.maxActiveCustomers === null ? '+' : `–${l.maxActiveCustomers}`}
                      </td>
                      <td style={{ textAlign: 'right' }}>{rate}%</td>
                      <td style={{ textAlign: 'right' }} className="amount-you">
                        {formatMoney(you, product.currency)}
                      </td>
                      <td style={{ textAlign: 'right' }} className="amount-hexa">
                        {formatMoney(price - you, product.currency)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}
