import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { jsx, mountPage } from './helpers/render-page'

/**
 * Admin → Commissions → Monthly report (/admin/commissions/report): the page shell.
 *  - uses the shared Admin page header (title, purpose line) with a way back to Commissions & Payouts;
 *  - still renders the existing MonthlyReport component in admin mode (adminLinks), inside the same card — the report logic is untouched
 *    (it has its own tests in admin-monthly-report-ui.test.ts).
 *
 * The real, unmodified page runs in Node through tests/helpers/render-page.ts. Database-free; nothing here reads `.env`,
 * runs Prisma or opens a connection.
 */

const PAGE = path.resolve(__dirname, '../../web/src/app/admin/commissions/report/page.tsx')

describe('Admin monthly commission report page', () => {
  const open = () => {
    const reportProps: Array<Record<string, unknown>> = []
    const page = mountPage(PAGE, {
      'next/link': { __esModule: true, default: ({ href, children, className }: { href: string; children: unknown; className?: string }) => jsx('a', { href, className, children }) },
      '@/components/admin/AdminPageHeader': {
        AdminPageHeader: ({ title, subtitle, actions }: { title: string; subtitle?: unknown; actions?: unknown }) =>
          jsx('header', { className: 'admin-page-header', children: [jsx('h1', { children: title }), jsx('p', { children: subtitle }), actions] }),
      },
      '@/components/commissions/MonthlyReport': {
        MonthlyReport: (props: Record<string, unknown>) => (reportProps.push(props), jsx('div', { className: 'report-stub', children: 'report' })),
      },
    })
    return { page, reportProps }
  }

  it('uses the shared Admin page header with the report title', () => {
    const { page } = open()
    assert.equal(page.textOfClass('admin-page-header').length, 1)
    assert.ok(page.text().includes('Monthly commission report'))
  })

  it('links back to Commissions & Payouts', () => {
    const { page } = open()
    assert.deepEqual(page.links(), [{ href: '/admin/commissions', text: 'Commissions & Payouts' }])
  })

  it('renders the existing report in admin mode, once, inside a card', () => {
    const { page, reportProps } = open()
    assert.equal(page.textOfClass('report-stub').length, 1)
    assert.deepEqual(reportProps, [{ adminLinks: true }])
    assert.equal(page.textOfClass('card').length, 1)
  })
})
