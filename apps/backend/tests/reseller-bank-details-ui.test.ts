import { afterEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { jsx, mountPage } from './helpers/render-page'

/**
 * Reseller → "Our Bank Details" (the page behind /bank-details).
 *  - the parser: splits the single free-text company bank setting into bank name / account holder / account number / branch
 *    only for recognised `Label: value` lines; everything else comes back untouched, nothing is guessed or invented;
 *  - the page: reads the existing payment-info endpoint (one GET, no writes), shows the four details each with its own
 *    Copy button, a "Not provided" row for a missing one, the raw text when the admin used no labels, and a clear empty
 *    state when nothing is configured; copy success / failure and a failed load (with Retry) are handled;
 *  - the sidebar: the link appears for resellers who may read activations (the permission payment-info requires), in both
 *    languages, and not for anyone else.
 *
 * Database-free; nothing here reads `.env`, runs Prisma or opens a connection. The real page and shell run in Node through
 * tests/helpers/render-page.ts against scripted API / clipboard stubs. There is no browser, so layout is not checked here.
 */

const WEB = path.resolve(__dirname, '../../web/src')
const PAGE = path.join(WEB, 'app/bank-details/page.tsx')
const bank = require('../../web/src/lib/bank-details')

class ApiError extends Error {
  constructor(message: string, public status = 0) {
    super(message)
  }
}

// ─── parser ──────────────────────────────────────────────────────────────────

describe('parseBankDetails', () => {
  const EMPTY = { accountHolder: null, bankName: null, accountNumber: null, branch: null }

  it('splits one Label: value line per detail, whatever the order', () => {
    const parsed = bank.parseBankDetails('Branch: Colombo Fort\nBank Name: Bank of Ceylon\nAccount Number: 0012345678\nAccount Holder: Hexalyte (Pvt) Ltd')
    assert.deepEqual(parsed.fields, { bankName: 'Bank of Ceylon', accountHolder: 'Hexalyte (Pvt) Ltd', accountNumber: '0012345678', branch: 'Colombo Fort' })
    assert.deepEqual(parsed.other, [])
  })

  it('accepts the common alternative labels, any case, CRLF and | or ; separators', () => {
    const parsed = bank.parseBankDetails('BANK: Sampath Bank\r\nA/C Name: Hexalyte Ltd | a/c no.: 1000 2000 3000; Branch Name: Kandy')
    assert.deepEqual(parsed.fields, { bankName: 'Sampath Bank', accountHolder: 'Hexalyte Ltd', accountNumber: '1000 2000 3000', branch: 'Kandy' })
    assert.deepEqual(parsed.other, [])
  })

  it('does not mistake "Account Name" for the account number, and keeps colons that belong to the value', () => {
    const parsed = bank.parseBankDetails('Account Name: Hexalyte\nBranch: Colombo: Fort')
    assert.equal(parsed.fields.accountNumber, null)
    assert.equal(parsed.fields.accountHolder, 'Hexalyte')
    assert.equal(parsed.fields.branch, 'Colombo: Fort')
  })

  it('invents nothing from unlabeled text: every line comes back untouched and in order', () => {
    for (const text of ['Hexalyte (Pvt) Ltd\nBank of Ceylon – Colombo Fort\nA/C 0000000000', 'Hexalyte (Pvt) Ltd | Test Bank | 000111222']) {
      const parsed = bank.parseBankDetails(text)
      assert.deepEqual(parsed.fields, EMPTY)
      assert.equal(parsed.other.join('\n'), text.split(/\n|\|/).map((l) => l.trim()).join('\n'))
      assert.equal(bank.hasBankField(parsed), false)
    }
  })

  it('keeps unrecognised lines next to the recognised ones; a repeated or empty label stays visible instead of being dropped', () => {
    const parsed = bank.parseBankDetails('Bank: Commercial Bank\nSWIFT: CCEYLKLX\nBank: Another\nBranch:\nUse the reference shown on your request')
    assert.equal(parsed.fields.bankName, 'Commercial Bank')
    assert.equal(parsed.fields.branch, null)
    assert.deepEqual(parsed.other, ['SWIFT: CCEYLKLX', 'Bank: Another', 'Branch:', 'Use the reference shown on your request'])
    assert.equal(bank.hasBankField(parsed), true)
  })

  it('handles nothing at all', () => {
    for (const value of [null, undefined, '', '  \n | ; ']) assert.deepEqual(bank.parseBankDetails(value), { fields: EMPTY, other: [] })
  })

  // Real finding: the live setting was "Bank Name:\nAccount Holder:\nAccount Number:\nBranch:" (an unfilled template), and the page
  // showed those four bare labels as if they were the company account.
  it('a label-only template holds no bank details at all: no lines, nothing parsed, not "available"', () => {
    for (const text of [
      'Bank Name:\nAccount Holder:\nAccount Number:\nBranch:',
      'Bank Name: | Branch: ;',
      'Bank Name: ____\nAccount Number: -\nBranch: …',
      'SWIFT:\r\n\r\nBank Name:  ',
      ' :\n---',
    ]) {
      assert.deepEqual(bank.bankDetailLines(text), [], JSON.stringify(text))
      assert.equal(bank.hasBankDetails(text), false, JSON.stringify(text))
      assert.deepEqual(bank.parseBankDetails(text), { fields: EMPTY, other: [] }, JSON.stringify(text))
    }
    for (const value of [null, undefined, '', '   ']) assert.equal(bank.hasBankDetails(value), false)
  })

  it('keeps every real value and leaves out only the empty labels around it', () => {
    const text = 'Bank Name: Sampath Bank\nAccount Holder:\nAccount Number: 100200300\nBranch:'
    const parsed = bank.parseBankDetails(text)
    assert.deepEqual(parsed.fields, { bankName: 'Sampath Bank', accountHolder: null, accountNumber: '100200300', branch: null })
    assert.deepEqual(parsed.other, [], 'no bare label is left over to be shown as an "additional detail"')
    assert.equal(bank.hasBankDetails(text), true)
    assert.deepEqual(bank.bankDetailLines(text), ['Bank Name: Sampath Bank', 'Account Number: 100200300'])
  })

  it('keeps a value that is written on the line under its label, so the label is not separated from it', () => {
    const text = 'Bank Name:\nBank of Ceylon\nAccount Number:\n0012345678'
    assert.deepEqual(bank.bankDetailLines(text), ['Bank Name:', 'Bank of Ceylon', 'Account Number:', '0012345678'])
    assert.equal(bank.hasBankDetails(text), true)
    // …but a label followed by another label is empty, so only the real pair survives
    assert.deepEqual(bank.bankDetailLines('Bank Name:\nBranch: Colombo Fort'), ['Branch: Colombo Fort'])
  })

  it('returns real entries trimmed and in their original order, whatever the separator, and counts any script or number as a value', () => {
    assert.deepEqual(bank.bankDetailLines('  A/C: 1 \r\n\r\n Hexalyte ; Test Bank | 000111222 '), ['A/C: 1', 'Hexalyte', 'Test Bank', '000111222'])
    for (const text of ['Hexalyte (Pvt) Ltd', '0012345678', 'බැංකුව: ලංකා බැංකුව', 'Branch: N/A']) assert.equal(bank.hasBankDetails(text), true, text)
  })

  it('understands the example the Admin Settings box suggests, so the hint and the parser cannot drift apart', () => {
    const source = fs.readFileSync(path.join(WEB, 'app/admin/settings/page.tsx'), 'utf8')
    const example = /placeholder=\{'(Bank Name:[^']*)'\}/.exec(source)?.[1]
    assert.ok(example, 'the bank details box has a labeled example')
    const parsed = bank.parseBankDetails(example.replace(/\\n/g, '\n'))
    assert.ok(Object.values(parsed.fields).every(Boolean), 'all four details are recognised')
    assert.deepEqual(parsed.other, [])
  })
})

// ─── page ────────────────────────────────────────────────────────────────────

type Step = () => Promise<unknown>
const ok = (companyBankDetails: string | null): Step => async () => ({ companyBankDetails, maxUploadMb: 5 })
const fail = (message: string): Step => async () => {
  throw new ApiError(message, 403)
}

const LABELED = 'Bank Name: Bank of Ceylon\nAccount Holder: Hexalyte (Pvt) Ltd\nAccount Number: 0012345678\nBranch: Colombo Fort'

describe('Our Bank Details page', () => {
  let calls: Array<{ path: string; init: unknown }>
  let script: Step[]
  let copied: string[]
  let clipboardWorks: boolean
  const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

  const open = async (...steps: Step[]) => {
    calls = []
    script = steps
    copied = []
    clipboardWorks = true
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      writable: true,
      value: {
        clipboard: {
          writeText: async (text: string) => {
            if (!clipboardWorks) throw new Error('denied')
            copied.push(text)
          },
        },
      },
    })
    const page = mountPage(PAGE, {
      '@/lib/api': {
        ApiError,
        api: async (url: string, init?: unknown) => {
          calls.push({ path: url, init })
          const next = script.shift()
          if (!next) throw new Error(`unexpected request to ${url}`)
          return next()
        },
      },
      '@/lib/bank-details': bank,
      '@/components/ResellerShell': { ResellerShell: ({ children }: { children: (user: object) => unknown }) => children({}) },
      '@/components/PageHero': { PageHero: ({ title, subtitle }: { title: string; subtitle: string }) => jsx('header', { children: [jsx('h1', { children: title }), jsx('p', { children: subtitle })] }) },
    })
    await page.settle()
    return page
  }

  afterEach(() => {
    mock.timers.reset()
    if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator)
  })

  it('shows Loading… while the request is in flight, then asks only the existing payment-info endpoint (one read, no writes)', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const page = await open(async () => {
      await gate
      return { companyBankDetails: LABELED, maxUploadMb: 5 }
    })
    assert.ok(page.text().includes('Loading…'))
    assert.equal(page.buttonLabels().includes('Copy'), false)
    release()
    await page.settle()
    assert.equal(page.text().includes('Loading…'), false)
    assert.deepEqual(calls, [{ path: '/activation-requests/payment-info', init: undefined }])
    page.unmount()
  })

  it('shows bank name, account holder, account number and branch, each with its own Copy button', async () => {
    const page = await open(ok(LABELED))
    const text = page.text()
    for (const [label, value] of [['Bank name', 'Bank of Ceylon'], ['Account holder', 'Hexalyte (Pvt) Ltd'], ['Account number', '0012345678'], ['Branch', 'Colombo Fort']]) {
      assert.ok(text.includes(label) && text.includes(value), `${label}: ${value}`)
    }
    assert.ok(text.indexOf('Bank name') < text.indexOf('Account holder') && text.indexOf('Account holder') < text.indexOf('Account number') && text.indexOf('Account number') < text.indexOf('Branch'), 'in this order')
    assert.deepEqual(page.buttonLabels(), ['Copy', 'Copy', 'Copy', 'Copy'])
    assert.equal(text.includes('Additional details'), false, 'every line was a labeled detail')
    assert.equal(text.includes('Not provided'), false)
    page.unmount()
  })

  it('copies exactly the value next to the button that was clicked, confirms with "Copied", then goes back to "Copy"', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const page = await open(ok(LABELED))
    await page.clickAt('Copy', 2)
    assert.deepEqual(copied, ['0012345678'])
    assert.deepEqual(page.buttonLabels(), ['Copy', 'Copy', 'Copied', 'Copy'])
    await page.clickAt('Copy', 0)
    assert.deepEqual(copied, ['0012345678', 'Bank of Ceylon'])
    assert.deepEqual(page.buttonLabels(), ['Copied', 'Copy', 'Copy', 'Copy'], 'only the latest copy is confirmed')
    mock.timers.tick(2000)
    assert.deepEqual(page.buttonLabels(), ['Copy', 'Copy', 'Copy', 'Copy'])
    page.unmount()
  })

  it('says "Not provided" for a detail the admin left out, with no Copy button for it', async () => {
    const page = await open(ok('Bank Name: Sampath Bank\nAccount Number: 100200300'))
    const text = page.text()
    assert.ok(text.includes('Sampath Bank') && text.includes('100200300'))
    assert.ok(text.includes('Account holder') && text.includes('Branch'))
    assert.equal(text.split('Not provided').length - 1, 2, 'account holder and branch')
    assert.deepEqual(page.buttonLabels(), ['Copy', 'Copy'])
    page.unmount()
  })

  it('shows lines it does not recognise as additional details, with a Copy all button, next to the four details', async () => {
    const page = await open(ok(`${LABELED}\nSWIFT: CCEYLKLX\nUse your request reference`))
    const text = page.text()
    assert.ok(text.includes('Additional details'))
    assert.ok(text.includes('SWIFT: CCEYLKLX\nUse your request reference'))
    assert.deepEqual(page.buttonLabels(), ['Copy', 'Copy', 'Copy', 'Copy', 'Copy all'])
    await page.click('Copy all')
    assert.deepEqual(copied, ['SWIFT: CCEYLKLX\nUse your request reference'])
    page.unmount()
  })

  it('shows unlabeled details exactly as entered, with no four-field table and nothing made up', async () => {
    const raw = 'Hexalyte (Pvt) Ltd\nBank of Ceylon – Colombo Fort\nA/C 0000000000'
    const page = await open(ok(raw))
    const text = page.text()
    assert.ok(text.includes(raw))
    for (const label of ['Bank name', 'Account holder', 'Account number', 'Not provided']) assert.equal(text.includes(label), false, label)
    assert.deepEqual(page.buttonLabels(), ['Copy all'])
    await page.click('Copy all')
    assert.deepEqual(copied, [raw])
    page.unmount()
  })

  it('shows a clear empty state, and no copy buttons or details, when nothing is configured', async () => {
    for (const value of [null, '', '   \n  ']) {
      const page = await open(ok(value))
      const text = page.text()
      assert.ok(text.includes('Bank details are not available yet'), JSON.stringify(value))
      assert.ok(text.includes('Do not pay into any other account'))
      assert.deepEqual(page.buttonLabels(), [])
      for (const invented of ['Bank name', 'Account number', 'Branch', 'Ceylon', '0000']) assert.equal(text.includes(invented), false, invented)
      page.unmount()
    }
  })

  it('treats a label-only setting (an unfilled template) as not available: no bare labels, no banner, no Copy buttons', async () => {
    for (const value of ['Bank Name:\nAccount Holder:\nAccount Number:\nBranch:', 'Bank Name: ____\nAccount Number: -', 'Bank Name:\r\n\r\nBranch:  ']) {
      const page = await open(ok(value))
      const text = page.text()
      assert.ok(text.includes('Bank details are not available yet'), JSON.stringify(value))
      assert.ok(text.includes('Do not pay into any other account'))
      for (const shown of ['Bank Name', 'Account Holder', 'Account number', 'Branch', 'Account details', 'Customers must pay only into', 'Not provided']) {
        assert.equal(text.includes(shown), false, `${shown} must not appear for ${JSON.stringify(value)}`)
      }
      assert.deepEqual(page.buttonLabels(), [])
      page.unmount()
    }
  })

  it('with some values filled in, shows those and "Not provided" for the rest, never an empty label', async () => {
    const page = await open(ok('Bank Name: Sampath Bank\nAccount Holder:\nAccount Number: 100200300\nBranch:'))
    const text = page.text()
    assert.ok(text.includes('Sampath Bank') && text.includes('100200300'))
    assert.equal(text.split('Not provided').length - 1, 2, 'account holder and branch')
    assert.equal(text.includes('Additional details'), false)
    assert.equal(/Account Holder:|Branch:/.test(text), false, 'no bare "Label:" text')
    assert.deepEqual(page.buttonLabels(), ['Copy', 'Copy'])
    page.unmount()
  })

  it('still shows a value written under its label exactly as entered', async () => {
    const raw = 'Bank Name:\nBank of Ceylon\nAccount Number:\n0012345678'
    const page = await open(ok(raw))
    assert.ok(page.text().includes(raw))
    assert.deepEqual(page.buttonLabels(), ['Copy all'])
    page.unmount()
  })

  it('tells the reseller when the clipboard cannot be used, instead of pretending it copied', async () => {
    const page = await open(ok(LABELED))
    clipboardWorks = false
    await page.clickAt('Copy', 1)
    assert.deepEqual(copied, [])
    assert.ok(page.text().includes('Could not copy automatically'))
    assert.equal(page.buttonLabels().includes('Copied'), false)
    clipboardWorks = true
    await page.clickAt('Copy', 1)
    assert.deepEqual(copied, ['Hexalyte (Pvt) Ltd'])
    assert.equal(page.text().includes('Could not copy automatically'), false, 'the warning clears after a good copy')
    page.unmount()
  })

  it('shows the server\'s message when the details cannot be loaded, and Retry asks again', async () => {
    const page = await open(fail('You do not have permission to do that.'), ok(LABELED))
    assert.deepEqual(page.textOfClass('alert'), ['You do not have permission to do that. Retry'])
    assert.equal(page.text().includes('Loading…'), false)
    await page.click('Retry')
    assert.equal(calls.length, 2)
    assert.ok(page.text().includes('Bank of Ceylon'))
    assert.deepEqual(page.textOfClass('alert').filter((t) => t.includes('permission')), [])
    page.unmount()
  })
})

// ─── New Activation → payment account notice ─────────────────────────────────

describe('New Activation form: payment account notice', () => {
  const NOTICE = path.join(WEB, 'components/activations/PaymentAccountNotice.tsx')
  const render = (companyBankDetails: string | null | undefined) => {
    const page = mountPage(NOTICE, { '@/lib/bank-details': bank }, { exportName: 'PaymentAccountNotice', props: { companyBankDetails } })
    const text = page.text()
    page.unmount()
    return text
  }

  it('shows the configured account exactly as entered, one detail per line, after "Pay only into the Hexalyte company account"', () => {
    const text = render(LABELED)
    assert.ok(text.includes('Pay only into the Hexalyte company account:'))
    assert.ok(text.includes(LABELED))
    assert.equal(text.includes('not available'), false)
  })

  it('drops only the empty labels of a partly filled setting', () => {
    const text = render('Bank Name: Sampath Bank\nAccount Number:\nBranch: Kandy')
    assert.ok(text.includes('Bank Name: Sampath Bank\nBranch: Kandy'))
    assert.equal(text.includes('Account Number'), false)
  })

  it('says the account is not available, and prints no labels, for a label-only template (the real finding), nothing, or blanks', () => {
    for (const value of ['Bank Name:\nAccount Holder:\nAccount Number:\nBranch:', 'Bank Name: ____\nBranch: -', null, undefined, '', '  \n  ']) {
      const text = render(value)
      assert.ok(text.includes('The Hexalyte company bank account is not available yet'), JSON.stringify(value))
      assert.ok(text.includes('do not pay into any other account'))
      assert.equal(text.includes('Pay only into the Hexalyte company account'), false, 'must not present an account that is not there')
      for (const label of ['Bank Name', 'Account Holder', 'Account Number', 'Branch']) assert.equal(text.includes(label), false, label)
    }
  })

  it('is what the New Activation form renders in its payment panel (and it no longer prints the raw setting)', () => {
    const source = fs.readFileSync(path.join(WEB, 'app/activations/new/page.tsx'), 'utf8')
    assert.match(source, /import \{ PaymentAccountNotice \} from '@\/components\/activations\/PaymentAccountNotice'/)
    assert.match(source, /<PaymentAccountNotice companyBankDetails=\{info\?\.companyBankDetails\} \/>/)
    assert.doesNotMatch(source, /\{info\.companyBankDetails\}/)
  })
})

// ─── sidebar ─────────────────────────────────────────────────────────────────

describe('reseller sidebar', () => {
  const utils = require('../../web/src/lib/appearance-utils')
  const sidebarLinks = async (permissions: string[]) => {
    const user = { id: 'u1', name: 'Nimal Perera', role: 'SELLER', permissions, resellerId: 'r1', reseller: { id: 'r1', status: 'ACTIVE', businessName: 'Kandy Traders', code: 'RS-1' } }
    const page = mountPage(
      path.join(WEB, 'components/ResellerShell.tsx'),
      {
        'next/navigation': { usePathname: () => '/bank-details', useRouter: () => ({ replace() {} }) },
        'next/link': { __esModule: true, default: ({ href, children }: { href: string; children: unknown }) => jsx('a', { href, children }) },
        '@/lib/auth': { isPlatformUser: () => false, logout: async () => {}, useCurrentUser: () => user },
        '@/components/ThemeToggle': { ThemeToggle: () => null },
        '@/components/PlatformLogo': { PlatformLogo: ({ fallback }: { fallback: unknown }) => fallback },
        '@/components/LanguageToggle': { LanguageToggle: () => null },
        '@/components/notifications/NotificationBell': { NotificationBell: () => null },
        '@/lib/api': { api: async () => ({}) },
        '@/lib/appearance': { useAppearance: () => null, useProtectedImage: () => ({ url: null, status: 'none' }) },
        '@/lib/appearance-utils': utils,
        '@/lib/i18n': { useLanguage: () => ({ t: (k: string) => k, language: 'en' }) },
        '@/components/commissions/LevelBadge': { LevelBadge: () => null },
        '@/components/commissions/LevelUpCelebration': { LevelUpCelebration: () => null },
        '@/components/commissions/PartnerSummaryContext': { PartnerSummaryProvider: ({ children }: { children: unknown }) => children },
        '@/components/onboarding/ApplicationNotices': { ApplicationPopups: () => null, ApplicationStatusCard: () => null },
      },
      { exportName: 'ResellerShell', props: { children: () => jsx('main', { children: 'page' }) } },
    )
    await page.settle()
    const links = page.links()
    page.unmount()
    return links
  }

  it('links to /bank-details for a reseller who can read activations, once, next to Paid Activations', async () => {
    const links = await sidebarLinks(['activations:read'])
    const hrefs = links.map((l) => l.href)
    assert.equal(hrefs.filter((h) => h === '/bank-details').length, 1)
    assert.deepEqual(links.find((l) => l.href === '/bank-details'), { href: '/bank-details', text: 'nav.bankDetails' })
    assert.equal(hrefs.indexOf('/bank-details'), hrefs.indexOf('/activations') + 1)
  })

  it('does not link to it for a reseller without that permission', async () => {
    const links = await sidebarLinks(['products:read'])
    assert.equal(links.some((l) => l.href === '/bank-details'), false)
  })

  it('has its label in English and Sinhala', () => {
    const source = fs.readFileSync(path.join(WEB, 'lib/i18n.tsx'), 'utf8')
    const [en, si] = source.split(/\n  si: \{/)
    assert.ok(/'nav\.bankDetails': 'Our Bank Details'/.test(en), 'English')
    assert.ok(/'nav\.bankDetails': '[^']+'/.test(si), 'Sinhala')
  })
})
