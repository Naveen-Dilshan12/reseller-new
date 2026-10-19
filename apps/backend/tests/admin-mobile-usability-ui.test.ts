import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Admin on phones (globals.css + app/admin/resellers/page.tsx):
 *  - KPI tiles: two per row on a phone while each still gets 10rem, one when it does not; desktop and tablet grids untouched;
 *  - tables: Partners becomes one card per row on phones with every column kept (its title printed before the value) and its actions
 *    kept; every other table keeps a contained horizontal scroll that now shows a cue on the side that has more.
 * Source and stylesheet checks only (the pixels were checked in a real browser). Database-free; nothing here reads `.env`.
 */

const WEB = path.resolve(__dirname, '../../web/src')
const CSS = fs.readFileSync(path.join(WEB, 'app/globals.css'), 'utf8').replace(/\r\n/g, '\n')
const PAGE = fs.readFileSync(path.join(WEB, 'app/admin/resellers/page.tsx'), 'utf8').replace(/\r\n/g, '\n')

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const blocks = (head: string): string[] => {
  const found: string[] = []
  for (let at = CSS.indexOf(head); at >= 0; at = CSS.indexOf(head, at + 1)) {
    let depth = 0
    const open = CSS.indexOf('{', at)
    for (let i = open; i < CSS.length; i++) {
      if (CSS[i] === '{' && ++depth) continue
      if (CSS[i] === '}' && --depth === 0) {
        found.push(CSS.slice(open + 1, i))
        break
      }
    }
  }
  return found
}
const rule = (selector: string, source = CSS) => new RegExp(`(?:^|\\n|\\})\\s*${esc(selector)}\\s*\\{([^{}]*)\\}`).exec(source)?.[1]
const decl = (body: string | undefined, prop: string) => new RegExp(`(?:^|[;\\s])${esc(prop)}\\s*:\\s*([^;]+)`).exec(body ?? '')?.[1].trim()
const PHONE_KPI = 'repeat(auto-fit, minmax(min(100%, 10rem), 1fr))'

describe('KPI tiles on phones', () => {
  const phone = blocks('@media (max-width: 580px)')

  it('use two columns when each tile gets at least 10rem, and one column when it does not (every tile count)', () => {
    const eight = phone.find((b) => b.includes("[data-count='8']"))!
    assert.equal(decl(rule("  .kpi-grid[data-count='8']", eight) ?? rule(".kpi-grid[data-count='8']", eight), 'grid-template-columns'), PHONE_KPI)
    const rest = phone.find((b) => b.includes("[data-count='6']"))!
    assert.match(rest, new RegExp(`\\.kpi-grid,[^{}]*\\[data-count='6'\\]\\s*\\{[^}]*grid-template-columns:\\s*${esc(PHONE_KPI)}`))
    assert.ok(!/grid-template-columns:\s*minmax\(0, 1fr\);/.test(rest), 'no always-one-column rule is left')
  })

  it('leave the desktop and tablet grids as they were', () => {
    assert.equal(decl(rule('.kpi-grid'), 'grid-template-columns'), 'repeat(4, minmax(0, 1fr))')
    assert.equal(decl(rule(".kpi-grid[data-count='8']"), 'grid-template-columns'), 'repeat(2, minmax(0, 1fr))')
    assert.match(blocks('@media (min-width: 1360px)').join('\n'), /\.kpi-grid\[data-count='8'\]\s*\{\s*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/)
    assert.match(blocks('@media (max-width: 1080px)').join('\n'), /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/)
  })
})

describe('Partners table on phones', () => {
  const headers = [...(PAGE.match(/<thead>[\s\S]*?<\/thead>/)?.[0].matchAll(/<th[^>]*>([^<]*)<\/th>/g) ?? [])].map((m) => m[1].trim())

  it('is marked as a card table, and every column except the name and the actions carries its title for the card', () => {
    assert.match(PAGE, /className="table-wrap table-cards"/)
    const labels = [...PAGE.matchAll(/<td[^>]*data-label="([^"]+)"/g)].map((m) => m[1])
    assert.deepEqual(headers, ['Partner', 'Contact', 'Status', 'Level', 'Active / total customers', 'Open activations', 'Unpaid commission'], 'the last (empty) header is the actions column')
    assert.deepEqual(labels, headers.slice(1), 'one label per middle column, same words as the header')
  })

  it('keeps all row actions (Products, Commissions, Suspend, Reactivate) and their permission checks', () => {
    for (const text of ['Products', 'Commissions', 'Suspend', 'Reactivate']) assert.match(PAGE, new RegExp(`>\\s*${text}\\s*<`))
    assert.match(PAGE, /canManage && r\.status === 'ACTIVE'/)
    assert.match(PAGE, /canManage && r\.status === 'SUSPENDED'/)
    assert.match(PAGE, /className="row row-actions"/)
    assert.doesNotMatch(PAGE, /flexWrap: 'nowrap'/, 'the inline no-wrap is gone, so the actions can wrap on a phone')
  })

  it('keeps the table (and its desktop look) outside phones: card rules exist only inside max-width 640px', () => {
    const outside = CSS.replace(blocks('@media (max-width: 640px)').filter((b) => b.includes('.table-cards')).join('') , '')
    assert.ok(!/\.table-cards[^{}]*\{/.test(outside.split('Table rows as cards on phones')[1].replace(/@media \(max-width: 640px\) \{\}/, '').split('.row-actions')[1] ?? ''), 'no card rule outside the phone block')
    assert.equal(decl(rule('.row-actions'), 'flex-wrap'), 'nowrap', 'desktop actions stay on one line')
  })

  it('in the phone block: rows are blocks, the header is visually hidden but kept, titles print before values, text wraps', () => {
    const b = blocks('@media (max-width: 640px)').find((x) => x.includes('.table-cards td::before'))!
    assert.match(b, /\.table-cards table,\s*\.table-cards tbody,\s*\.table-cards tr,\s*\.table-cards td\s*\{\s*display:\s*block/)
    assert.match(b, /\.table-cards thead\s*\{[^}]*clip:\s*rect\(0 0 0 0\)/)
    assert.match(b, /content:\s*attr\(data-label\)/)
    assert.match(b, /\.table-wrap\.table-cards\s*\{\s*overflow-wrap:\s*anywhere/, 'long names and e-mails wrap in a card')
    assert.match(b, /\.table-cards \.row-actions\s*\{\s*flex-wrap:\s*wrap/)
    assert.doesNotMatch(b, /display:\s*none/, 'nothing is hidden')
  })
})

describe('other wide tables keep a contained scroll, now with a cue', () => {
  it('the scroll box shows a coloured edge on a side that has more to scroll to, and still scrolls', () => {
    const wrap = rule('.table-wrap')!
    assert.equal(decl(wrap, 'overflow-x'), 'auto')
    assert.equal((wrap.match(/radial-gradient/g) ?? []).length, 2, 'one edge cue per side')
    assert.equal((wrap.match(/no-repeat local/g) ?? []).length, 2, 'covers that fade each cue out at the end')
    assert.match(wrap, /background-color:\s*var\(--surface\)/)
    assert.match(wrap, /rgba\(37, 99, 235/, 'visible on the dark theme too')
  })
})
