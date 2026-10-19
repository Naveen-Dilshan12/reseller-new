'use client'

import Link from 'next/link'
import { AdminPageHeader } from '@/components/admin/AdminPageHeader'
import { MonthlyReport } from '@/components/commissions/MonthlyReport'

export default function AdminMonthlyReportPage() {
  return (
    <main className="container">
      <AdminPageHeader
        title="Monthly commission report"
        subtitle="Commission totals for every partner in the selected month: pending, approved, payable, paid and reversed. Open a partner to see their commissions."
        actions={
          <Link href="/admin/commissions" className="btn secondary">
            Commissions & Payouts
          </Link>
        }
      />
      <div className="card">
        <MonthlyReport adminLinks />
      </div>
    </main>
  )
}
