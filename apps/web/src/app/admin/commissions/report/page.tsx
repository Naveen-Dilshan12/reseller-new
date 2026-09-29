'use client'

import { MonthlyReport } from '@/components/commissions/MonthlyReport'

export default function AdminMonthlyReportPage() {
  return (
    <main className="container">
      <h1>Monthly commission report</h1>
      <div className="card">
        <MonthlyReport adminLinks />
      </div>
    </main>
  )
}
