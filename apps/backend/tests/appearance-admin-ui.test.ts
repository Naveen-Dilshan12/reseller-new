import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { jsx, mountPage } from './helpers/render-page'

/**
 * Admin → Settings → Appearance (the component behind /admin/settings).
 *  - states: loading, load failure with Retry, built-in defaults, custom values, read-only for people who cannot manage settings;
 *  - checks before anything is sent (wrong file type, too big, no reason, nothing changed, bad placeholder);
 *  - upload, reset and text/color-mode saves send the right request, and a failed upload leaves the current image shown.
 *
 * The real, unmodified component runs in Node through tests/helpers/render-page.ts against scripted API stubs. The shared
 * helpers and the built-in translations are the real ones. Database-free; nothing here reads `.env`, runs Prisma or opens
 * a connection, and there is no browser: this checks the component's states and requests, not how it looks.
 */

/** The login-theme editor is a separate component with its own tests (login-theme-admin-ui.test.ts); here it is only a placeholder. */
const loginThemeStub = { LoginThemeSettings: () => null }

const FILE = path.resolve(__dirname, '../../web/src/components/admin/AppearanceSettings.tsx')
const utils = require('../../web/src/lib/appearance-utils')
const { builtInText } = require('../../web/src/lib/i18n')
const { BUILT_IN_LOGIN_HEADING, BUILT_IN_LOGIN_TEXT, BUILT_IN_LOGIN_TAGLINE, LOGIN_IMAGE_PATH } = utils

class ApiError extends Error {
  constructor(message: string, public status = 0, public code?: string, public errors: string[] = []) {
    super(message)
  }
}
const deferred = <T>() => {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}

type Row = Record<string, any>
type Step = () => Promise<unknown>
const ok = (value: unknown): Step => async () => structuredClone(value)
const fail = (error: unknown): Step => async () => {
  throw error
}

const MB = 1024 * 1024
const detail = (custom = false): Row => ({
  custom,
  updatedAt: custom ? '2026-10-01T05:00:00.000Z' : null,
  updatedBy: custom ? { name: 'Ada Admin', email: 'admin@test.invalid' } : null,
})
const appearance = (over: Row = {}, custom: string[] = []): Row => ({
  defaultTheme: 'dark',
  welcomeText: { en: null, si: null },
  heroImage: null,
  logo: null,
  loginBranding: { heading: null, text: null, heroImage: null },
  details: {
    heroImage: detail(custom.includes('heroImage')),
    logo: detail(custom.includes('logo')),
    welcomeTextEn: detail(custom.includes('welcomeTextEn')),
    welcomeTextSi: detail(custom.includes('welcomeTextSi')),
    defaultTheme: detail(custom.includes('defaultTheme')),
    loginImage: detail(custom.includes('loginImage')),
    loginHeading: detail(custom.includes('loginHeading')),
    loginText: detail(custom.includes('loginText')),
  },
  limits: {
    imageTypes: ['image/jpeg', 'image/png', 'image/webp'],
    hero: { maxBytes: 5 * MB, minWidth: 800, minHeight: 300, maxSide: 8000 },
    logo: { maxBytes: 2 * MB, minWidth: 32, minHeight: 32, maxSide: 4000 },
    login: { maxBytes: 5 * MB, minWidth: 800, minHeight: 600, maxSide: 8000 },
    welcomeTextMaxLength: 120,
    loginHeadingMaxLength: 80,
    loginTextMaxLength: 200,
  },
  ...over,
})
const withHero = () => appearance({ heroImage: { version: 'v1' } }, ['heroImage'])
const withLogo = () => appearance({ logo: { version: 'v1' } }, ['logo'])
const withLoginImage = () => appearance({ loginBranding: { heading: null, text: null, heroImage: { version: 'v1' } } }, ['loginImage'])
const withLoginText = (heading: string | null, text: string | null) =>
  appearance({ loginBranding: { heading, text, heroImage: null } }, [...(heading ? ['loginHeading'] : []), ...(text ? ['loginText'] : [])])

const picture = (name = 'banner.png', size = 200_000, type = 'image/png') => new File([new Uint8Array(size)], name, { type })
const REASON = 'Seasonal refresh'

describe('Admin → Settings → Appearance', () => {
  let calls: Array<{ path: string; method: string; body: any }>
  let script: Step[]
  let refreshed: number
  let confirmAnswer: boolean
  let confirmed: string[]
  let currentImages: Record<string, { url: string | null; status: string }>

  /** Records a request and answers from the script. A multipart body is summarised as its fields. */
  const recordApi = async (url: string, init: { method?: string; body?: unknown } = {}) => {
    let body: any = init.body
    if (init.body instanceof FormData) {
      const image = init.body.get('image') as File | null
      body = { reason: init.body.get('reason'), image: image && { name: image.name, size: image.size } }
    } else if (typeof init.body === 'string') body = JSON.parse(init.body)
    calls.push({ path: url, method: init.method ?? 'GET', body })
    const next = script.shift()
    if (!next) throw new Error(`unexpected extra request: ${url}`)
    return next()
  }

  const open = async (props: { canManage?: boolean } = {}) => {
    const page = mountPage(
      FILE,
      {
        '@/lib/api': { ApiError, api: recordApi },
        '@/lib/appearance': {
          refreshAppearance: async () => void refreshed++,
          useProtectedImage: (p: string | null) => (p ? (currentImages[p] ?? { url: `blob:${p}`, status: 'ready' }) : { url: null, status: 'none' }),
        },
        '@/lib/appearance-utils': utils,
        '@/lib/i18n': { builtInText }, './LoginThemeSettings': loginThemeStub,
      },
      { exportName: 'AppearanceSettings', props: { canManage: props.canManage ?? true } },
    )
    await page.settle()
    return page
  }

  const alerts = (page: Awaited<ReturnType<typeof open>>, kind = 'alert') => page.textOfClass(kind).map((t) => t.replace(/\s+/g, ' ').trim())
  const squash = (s: string) => s.replace(/\s+/g, ' ')
  /** Every button except the section navigation (which anyone can use, including read-only admins): upload, reset, save, … */
  const actionButtons = (page: Awaited<ReturnType<typeof open>>) => page.buttonLabels().filter((label) => !utils.APPEARANCE_SECTIONS.some((s: { label: string }) => s.label === label))

  beforeEach(() => {
    calls = []
    script = []
    refreshed = 0
    confirmAnswer = true
    confirmed = []
    currentImages = {}
    ;(globalThis as any).confirm = (question: string) => (confirmed.push(question), confirmAnswer)
  })

  describe('states', () => {
    it('shows "Loading…" until the first answer, then the built-in defaults, saying nothing is customized', async () => {
      const pending = deferred<unknown>()
      script = [() => pending.promise]
      const page = mountPage(FILE, { '@/lib/api': { ApiError, api: recordApi }, '@/lib/appearance': { refreshAppearance: async () => {}, useProtectedImage: () => ({ url: null, status: 'none' }) }, '@/lib/appearance-utils': utils, '@/lib/i18n': { builtInText }, './LoginThemeSettings': loginThemeStub }, { exportName: 'AppearanceSettings', props: { canManage: true } })
      assert.ok(page.text().includes('Loading appearance settings…'))
      pending.resolve(appearance())
      await page.settle()

      const text = squash(page.text())
      assert.ok(!text.includes('Loading appearance settings'))
      assert.ok(text.includes('Using the default background'))
      assert.ok(text.includes('Using the built-in “H” mark'))
      assert.ok(text.includes(`Using the built-in text: ${builtInText('en', 'dash.hero.welcome')}`), 'English default is the existing translation')
      assert.ok(text.includes(`Using the built-in text: ${builtInText('si', 'dash.hero.welcome')}`), 'Sinhala default is the existing translation')
      assert.ok(text.includes('Using the built-in mode (Dark)'))
      assert.equal(page.valueOf('welcome-en'), '')
      assert.equal(page.valueOf('welcome-si'), '')
      assert.equal(page.valueOf('appearance-theme'), 'dark')
      assert.equal(page.hasButton('Reset hero image'), false, 'nothing to reset')
      assert.equal(page.hasButton('Reset logo'), false)
      assert.equal(page.isDisabled('Upload hero image'), true, 'nothing chosen yet')
      assert.equal(page.isDisabled('Upload logo'), true)
      assert.deepEqual(calls.map((c) => c.path), ['/admin/settings/appearance'])
    })

    it('shows the load error with Retry instead of "Loading…" forever, and Retry loads it', async () => {
      script = [fail(new ApiError('Failed to load', 500)), ok(appearance())]
      const page = await open()
      assert.deepEqual(alerts(page), ['Failed to load'])
      assert.ok(!page.text().includes('Loading appearance settings'))
      assert.deepEqual(page.buttonLabels(), ['Retry'])
      await page.click('Retry')
      assert.deepEqual(alerts(page), [])
      assert.ok(page.text().includes('Using the default background'))
      assert.equal(calls.length, 2)
    })

    it('shows a plain gradient swatch, never a picture, for the hero and login images while none is uploaded, and the uploaded picture once there is one', async () => {
      const nodes = (page: Awaited<ReturnType<typeof open>>) => {
        const out: any[] = []
        const walk = (n: any) => {
          if (!n || typeof n !== 'object') return
          if (Array.isArray(n)) return n.forEach(walk)
          out.push(n)
          walk(n.props?.children)
        }
        walk(page.root())
        return out
      }
      script = [ok(appearance())]
      const plain = await open()
      assert.deepEqual(nodes(plain).filter((n) => n.type === 'img'), [], 'no <img> at all, so nothing can show as a broken picture')
      const swatches = nodes(plain).filter((n) => n.props?.role === 'img').map((n) => [n.props['aria-label'], n.props.style.background])
      assert.deepEqual(swatches, [
        ['Default dashboard hero image (no picture uploaded)', utils.HERO_FALLBACK_DARK],
        ['Default login page hero image (no picture uploaded)', utils.LOGIN_FALLBACK_GRADIENT],
      ])

      script = [ok(appearance({ heroImage: { version: 'v1' } }, ['heroImage']))]
      const custom = await open()
      assert.deepEqual(nodes(custom).filter((n) => n.type === 'img').map((n) => n.props.src), ['blob:/appearance/hero-image'], 'the uploaded hero is shown as a picture')
      assert.deepEqual(nodes(custom).filter((n) => n.props?.role === 'img').map((n) => n.props['aria-label']), ['Default login page hero image (no picture uploaded)'], 'only the login image still shows its swatch')
    })

    it('shows custom values with who changed them and when, and a reset button for each custom image', async () => {
      script = [ok(appearance({ heroImage: { version: 'v1' }, logo: { version: 'v1' }, defaultTheme: 'light', welcomeText: { en: 'Hello, {name}!', si: null } }, ['heroImage', 'logo', 'defaultTheme', 'welcomeTextEn']))]
      const page = await open()
      const text = squash(page.text())
      assert.equal(text.split('Custom · updated').length - 1, 4, 'hero image, logo, color mode and English text')
      assert.equal(text.split('by Ada Admin').length - 1, 4)
      assert.equal(page.valueOf('welcome-en'), 'Hello, {name}!')
      assert.equal(page.valueOf('welcome-si'), '')
      assert.ok(text.includes(`Using the built-in text: ${builtInText('si', 'dash.hero.welcome')}`), 'Sinhala still uses its built-in text')
      assert.equal(page.valueOf('appearance-theme'), 'light')
      assert.ok(page.hasButton('Reset hero image') && page.hasButton('Reset logo'))
    })

    it('says so while a custom image is still downloading, and when it cannot be loaded here', async () => {
      currentImages['/appearance/hero-image'] = { url: null, status: 'loading' }
      script = [ok(withHero())]
      const loading = await open()
      assert.ok(loading.text().includes('Loading preview…'))

      currentImages['/appearance/hero-image'] = { url: null, status: 'failed' }
      script = [ok(withHero())]
      const failed = await open()
      assert.ok(squash(failed.text()).includes('could not be loaded here. Partners see the default background'))
    })

    it('is read-only without settings:manage: values are visible, nothing can be changed', async () => {
      script = [ok(withHero())]
      const page = await open({ canManage: false })
      assert.ok(page.text().includes('Read-only'))
      assert.deepEqual(actionButtons(page), [])
      for (const id of ['hero-file', 'hero-reason', 'logo-file', 'logo-reason', 'appearance-text-reason']) {
        await assert.rejects(page.change(id, {}), /No field with id/, `${id} is not offered`)
      }
      assert.ok(squash(page.text()).includes('Custom · updated'))
    })
  })

  describe('uploading an image', () => {
    it('refuses a file of the wrong type or size before sending anything', async () => {
      script = [ok(appearance())]
      const page = await open()
      await page.change('hero-file', { files: [picture('anim.gif', 1000, 'image/gif')] })
      assert.deepEqual(alerts(page), ['Choose a JPG, PNG or WEBP image.'])
      await page.change('hero-file', { files: [picture('notes.pdf', 1000, 'application/pdf')] })
      assert.deepEqual(alerts(page), ['Choose a JPG, PNG or WEBP image.'])
      await page.change('hero-file', { files: [picture('huge.png', 6 * MB)] })
      assert.match(alerts(page)[0], /must be 5 MB or smaller/)
      await page.change('logo-file', { files: [picture('logo.png', 3 * MB)] })
      assert.match(alerts(page).at(-1)!, /must be 2 MB or smaller/, 'the logo has its own, smaller limit')
      await page.change('hero-file', { files: [picture('empty.png', 0)] })
      assert.equal(alerts(page)[0], 'That file is empty.')
      assert.equal(page.isDisabled('Upload hero image'), true, 'a refused file is not kept')
      assert.equal(calls.length, 1, 'only the initial load')
    })

    it('accepts a file by extension when the browser gives no type, and previews it as "not saved yet"', async () => {
      script = [ok(appearance())]
      const page = await open()
      await page.change('hero-file', { files: [picture('banner.JPG', 300_000, '')] })
      assert.deepEqual(alerts(page), [])
      assert.ok(squash(page.text()).includes('New: banner.JPG · 293 KB · not saved yet'))
      assert.equal(page.isDisabled('Upload hero image'), false)
    })

    it('needs a reason, and sends nothing without one', async () => {
      script = [ok(appearance())]
      const page = await open()
      await page.change('hero-file', { files: [picture()] })
      await page.click('Upload hero image')
      assert.deepEqual(alerts(page), ['Give a reason for the change (at least 5 characters).'])
      await page.fill('hero-reason', 'abc')
      await page.click('Upload hero image')
      assert.deepEqual(alerts(page), ['Give a reason for the change (at least 5 characters).'])
      assert.equal(calls.length, 1)
    })

    it('uploads the file with its reason, then shows it as custom, clears the form and refreshes the portal settings', async () => {
      script = [ok(appearance()), ok(withHero())]
      const page = await open()
      await page.change('hero-file', { files: [picture('banner.png', 250_000)] })
      await page.fill('hero-reason', `  ${REASON}  `)
      await page.click('Upload hero image')

      assert.deepEqual(calls[1], { path: '/admin/settings/appearance/hero-image', method: 'PUT', body: { reason: REASON, image: { name: 'banner.png', size: 250_000 } } })
      assert.deepEqual(alerts(page, 'alert success'), ['Dashboard hero image updated. All admins have been notified.'])
      assert.deepEqual(alerts(page, 'alert error'), [])
      assert.ok(squash(page.text()).includes('Custom · updated'))
      assert.ok(page.hasButton('Reset hero image'))
      assert.equal(page.isDisabled('Upload hero image'), true, 'form cleared')
      assert.equal(page.valueOf('hero-reason'), '')
      assert.ok(!page.text().includes('not saved yet'))
      assert.equal(refreshed, 1)
    })

    it('sends the logo to its own endpoint', async () => {
      script = [ok(appearance()), ok(withLogo())]
      const page = await open()
      await page.change('logo-file', { files: [picture('mark.webp', 20_000, 'image/webp')] })
      await page.fill('logo-reason', REASON)
      await page.click('Upload logo')
      assert.equal(calls[1].path, '/admin/settings/appearance/logo')
      assert.equal(calls[1].body.image.name, 'mark.webp')
      assert.deepEqual(alerts(page, 'alert success'), ['Platform logo updated. All admins have been notified.'])
    })

    it('shows the server\'s reason for a rejected file, keeps the current image, and lets the admin retry', async () => {
      script = [ok(withHero()), fail(new ApiError('The image must be at least 800 × 300 pixels', 400, undefined, ['image: Too small (400 × 150)'])), ok(withHero())]
      const page = await open()
      const before = squash(page.text())
      assert.ok(before.includes('Custom · updated'))

      await page.change('hero-file', { files: [picture('small.png')] })
      await page.fill('hero-reason', REASON)
      await page.click('Upload hero image')

      assert.deepEqual(alerts(page, 'alert error'), ['The image must be at least 800 × 300 pixels'])
      assert.deepEqual(alerts(page, 'alert success'), [])
      assert.ok(squash(page.text()).includes('Custom · updated'), 'the current custom image is still the one shown')
      assert.ok(squash(page.text()).includes('New: small.png'), 'the choice stays so it can be retried or replaced')
      assert.equal(page.valueOf('hero-reason'), REASON)
      assert.equal(refreshed, 0, 'the portal was not told anything changed')
      assert.equal(page.isDisabled('Upload hero image'), false)

      await page.click('Upload hero image')
      assert.equal(calls.length, 3)
      assert.deepEqual(alerts(page, 'alert error'), [])
    })

    it('shows validation errors without the field prefix, and a network failure as "Upload failed"', async () => {
      script = [ok(appearance()), fail(new ApiError('Validation error', 422, undefined, ['reason: Give a reason for the change (at least 5 characters)'])), fail(new Error('network down'))]
      const page = await open()
      await page.change('hero-file', { files: [picture()] })
      await page.fill('hero-reason', REASON)
      await page.click('Upload hero image')
      assert.deepEqual(alerts(page, 'alert error'), ['Give a reason for the change (at least 5 characters)'])
      await page.click('Upload hero image')
      assert.deepEqual(alerts(page, 'alert error'), ['Upload failed'])
    })

    it('disables the controls and shows "Saving…" while the upload is in flight, so it cannot be sent twice', async () => {
      const pending = deferred<unknown>()
      script = [ok(appearance()), () => pending.promise]
      const page = await open()
      await page.change('hero-file', { files: [picture()] })
      await page.fill('hero-reason', REASON)
      const click = page.click('Upload hero image')
      await page.settle()
      assert.ok(page.hasButton('Saving…'))
      assert.equal(page.isDisabled('Saving…'), true)
      pending.resolve(withHero())
      await click
      await page.settle()
      assert.ok(!page.hasButton('Saving…'))
      assert.equal(calls.length, 2)
    })
  })

  describe('resetting an image', () => {
    it('needs a reason and a confirmation, then goes back to the built-in image', async () => {
      script = [ok(withHero()), ok(appearance())]
      const page = await open()

      await page.click('Reset hero image')
      assert.deepEqual(alerts(page), ['Give a reason for the change (at least 5 characters).'])
      assert.equal(calls.length, 1)

      await page.fill('hero-reason', REASON)
      confirmAnswer = false
      await page.click('Reset hero image')
      assert.equal(calls.length, 1, 'cancelled at the confirmation')
      assert.match(confirmed[0], /Reset the dashboard hero image to the default background\?/)

      confirmAnswer = true
      await page.click('Reset hero image')
      assert.deepEqual(calls[1], { path: '/admin/settings/appearance/hero-image/reset', method: 'POST', body: { reason: REASON } })
      assert.deepEqual(alerts(page, 'alert success'), ['Dashboard hero image reset to the built-in image. All admins have been notified.'])
      assert.ok(squash(page.text()).includes('Using the default background'))
      assert.equal(page.hasButton('Reset hero image'), false)
      assert.equal(refreshed, 1)
    })

    it('keeps showing the custom image and the reason when the reset fails', async () => {
      script = [ok(withLogo()), fail(new ApiError('Internal server error', 500))]
      const page = await open()
      await page.fill('logo-reason', REASON)
      await page.click('Reset logo')
      assert.deepEqual(alerts(page, 'alert error'), ['Internal server error'])
      assert.ok(page.hasButton('Reset logo'))
      assert.equal(page.valueOf('logo-reason'), REASON)
      assert.equal(refreshed, 0)
    })
  })

  describe('welcome text and default color mode', () => {
    it('sends only what changed, plus the reason, and shows the saved values', async () => {
      script = [ok(appearance()), ok(appearance({ defaultTheme: 'light', welcomeText: { en: 'Hello, {name}!', si: null } }, ['defaultTheme', 'welcomeTextEn']))]
      const page = await open()
      await page.fill('welcome-en', '  Hello, {name}!  ')
      await page.fill('appearance-theme', 'light')
      await page.fill('appearance-text-reason', REASON)
      await page.submit()

      assert.deepEqual(calls[1], { path: '/admin/settings/appearance', method: 'PUT', body: { welcomeText: { en: 'Hello, {name}!' }, defaultTheme: 'light', reason: REASON } })
      assert.deepEqual(alerts(page, 'alert success'), ['Welcome text and color mode saved. All admins have been notified.'])
      assert.equal(page.valueOf('welcome-en'), 'Hello, {name}!')
      assert.equal(page.valueOf('appearance-text-reason'), '')
      assert.equal(refreshed, 1)
    })

    it('saves the Sinhala text on its own and clearing a field goes back to the built-in text (null)', async () => {
      script = [
        ok(appearance({ welcomeText: { en: 'Hello', si: null } }, ['welcomeTextEn'])),
        ok(appearance({ welcomeText: { en: 'Hello', si: 'ආයුබෝවන් {name}' } }, ['welcomeTextEn', 'welcomeTextSi'])),
        ok(appearance({ welcomeText: { en: null, si: 'ආයුබෝවන් {name}' } }, ['welcomeTextSi'])),
      ]
      const page = await open()
      await page.fill('welcome-si', 'ආයුබෝවන් {name}')
      await page.fill('appearance-text-reason', REASON)
      await page.submit()
      assert.deepEqual(calls[1].body, { welcomeText: { si: 'ආයුබෝවන් {name}' }, reason: REASON })

      await page.fill('welcome-en', '   ')
      await page.fill('appearance-text-reason', 'Back to standard')
      await page.submit()
      assert.deepEqual(calls[2].body, { welcomeText: { en: null }, reason: 'Back to standard' })
    })

    it('does not send an unchanged field or an unchanged color mode', async () => {
      script = [ok(appearance({ defaultTheme: 'system' }, ['defaultTheme'])), ok(appearance({ defaultTheme: 'system', welcomeText: { en: 'Hi', si: null } }, ['defaultTheme', 'welcomeTextEn']))]
      const page = await open()
      await page.fill('welcome-en', 'Hi')
      await page.fill('appearance-text-reason', REASON)
      await page.submit()
      assert.deepEqual(calls[1].body, { welcomeText: { en: 'Hi' }, reason: REASON })
    })

    it('refuses to save when nothing changed, or without a reason, or with an invalid text, and sends nothing', async () => {
      script = [ok(appearance())]
      const page = await open()
      await page.fill('appearance-text-reason', REASON)
      await page.submit()
      assert.match(alerts(page)[0], /^Nothing to save yet/)

      await page.fill('welcome-en', 'Hello')
      await page.fill('appearance-text-reason', '')
      await page.submit()
      assert.deepEqual(alerts(page), ['Give a reason for the change (at least 5 characters).'])

      await page.fill('welcome-si', 'Hi {user}')
      await page.fill('appearance-text-reason', REASON)
      await page.submit()
      assert.deepEqual(alerts(page), ['Sinhala welcome text: Only the {name} placeholder can be used in braces.'])

      await page.fill('welcome-si', '')
      await page.fill('welcome-en', 'x'.repeat(121))
      await page.submit()
      assert.match(alerts(page)[0], /^English welcome text: Welcome text can be at most 120 characters/)
      assert.equal(calls.length, 1, 'only the initial load')
    })

    it('shows the server\'s answer when the save fails and keeps what was typed', async () => {
      script = [ok(appearance()), fail(new ApiError('Validation error', 422, undefined, ['welcomeText.en: Welcome text must be a single line without control characters']))]
      const page = await open()
      await page.fill('welcome-en', 'Hello')
      await page.fill('appearance-text-reason', REASON)
      await page.submit()
      assert.deepEqual(alerts(page, 'alert error'), ['Welcome text must be a single line without control characters'])
      assert.equal(page.valueOf('welcome-en'), 'Hello')
      assert.equal(page.valueOf('appearance-text-reason'), REASON)
      assert.equal(refreshed, 0)
    })

    it('hides the save button for people without settings:manage', async () => {
      script = [ok(appearance())]
      const page = await open({ canManage: false })
      assert.equal(page.hasButton('Save welcome text and color mode'), false)
    })
  })

  describe('login page branding', () => {
    it('starts on the built-in image, heading and supporting text, and says they are public', async () => {
      script = [ok(appearance())]
      const page = await open()
      const text = squash(page.text())
      assert.ok(text.includes('Using the default background'))
      assert.ok(text.includes(`Using the built-in heading: ${BUILT_IN_LOGIN_HEADING}`))
      assert.ok(text.includes(`Using the built-in text: ${BUILT_IN_LOGIN_TEXT} ${BUILT_IN_LOGIN_TAGLINE}`))
      assert.ok(text.includes('signed in or not'), 'the admin is told this picture is shown to the public')
      assert.equal(page.valueOf('login-heading'), '')
      assert.equal(page.valueOf('login-text'), '')
      assert.equal(page.hasButton('Reset login image'), false, 'nothing to reset')
      assert.equal(page.isDisabled('Upload login image'), true, 'nothing chosen yet')
      assert.deepEqual(calls.map((c) => c.path), ['/admin/settings/appearance'])
    })

    it('refuses a wrong type or size using the login image limits, and previews a good choice as "not saved yet"', async () => {
      script = [ok(appearance())]
      const page = await open()
      await page.change('login-file', { files: [picture('anim.gif', 1000, 'image/gif')] })
      assert.deepEqual(alerts(page), ['Choose a JPG, PNG or WEBP image.'])
      await page.change('login-file', { files: [picture('huge.png', 6 * MB)] })
      assert.match(alerts(page)[0], /must be 5 MB or smaller/)
      assert.equal(page.isDisabled('Upload login image'), true, 'a refused file is not kept')

      await page.change('login-file', { files: [picture('coast.jpg', 300_000, 'image/jpeg')] })
      assert.deepEqual(alerts(page), [])
      assert.ok(squash(page.text()).includes('New: coast.jpg · 293 KB · not saved yet'))
      assert.equal(page.isDisabled('Upload login image'), false)
      assert.equal(calls.length, 1, 'only the initial load')
    })

    it('uploads to the login image endpoint with its reason, then shows it as custom with a reset button', async () => {
      script = [ok(appearance()), ok(withLoginImage())]
      const page = await open()
      await page.change('login-file', { files: [picture('coast.png', 250_000)] })
      await page.click('Upload login image')
      assert.deepEqual(alerts(page), ['Give a reason for the change (at least 5 characters).'])
      assert.equal(calls.length, 1, 'nothing sent without a reason')

      await page.fill('login-reason', `  ${REASON}  `)
      await page.click('Upload login image')
      assert.deepEqual(calls[1], { path: '/admin/settings/appearance/login-image', method: 'PUT', body: { reason: REASON, image: { name: 'coast.png', size: 250_000 } } })
      assert.deepEqual(alerts(page, 'alert success'), ['Login page hero image updated. All admins have been notified.'])
      assert.ok(squash(page.text()).includes('Custom · updated'))
      assert.ok(page.hasButton('Reset login image'))
      assert.equal(page.isDisabled('Upload login image'), true, 'form cleared')
      assert.equal(page.valueOf('login-reason'), '')
    })

    it('keeps the current image and the choice when an upload is rejected', async () => {
      script = [ok(withLoginImage()), fail(new ApiError('The image must be at least 800 × 600 pixels', 400, undefined, ['image: Too small (700 × 500)']))]
      const page = await open()
      await page.change('login-file', { files: [picture('small.png')] })
      await page.fill('login-reason', REASON)
      await page.click('Upload login image')
      assert.deepEqual(alerts(page, 'alert error'), ['The image must be at least 800 × 600 pixels'])
      assert.ok(squash(page.text()).includes('Custom · updated'), 'the current custom image is still the one shown')
      assert.ok(squash(page.text()).includes('New: small.png'))
    })

    it('previews the current image from the public login endpoint, and says so when it cannot be loaded', async () => {
      currentImages[LOGIN_IMAGE_PATH] = { url: null, status: 'loading' }
      script = [ok(withLoginImage())]
      assert.ok((await open()).text().includes('Loading preview…'))

      currentImages[LOGIN_IMAGE_PATH] = { url: null, status: 'failed' }
      script = [ok(withLoginImage())]
      assert.ok(squash((await open()).text()).includes('could not be loaded here. Visitors see the default background'))
    })

    it('resets to the built-in image after a reason and a confirmation', async () => {
      script = [ok(withLoginImage()), ok(appearance())]
      const page = await open()
      await page.click('Reset login image')
      assert.deepEqual(alerts(page), ['Give a reason for the change (at least 5 characters).'])

      await page.fill('login-reason', REASON)
      confirmAnswer = false
      await page.click('Reset login image')
      assert.equal(calls.length, 1, 'cancelled at the confirmation')
      assert.match(confirmed[0], /Reset the login page hero image to the default background\?/)

      confirmAnswer = true
      await page.click('Reset login image')
      assert.deepEqual(calls[1], { path: '/admin/settings/appearance/login-image/reset', method: 'POST', body: { reason: REASON } })
      assert.deepEqual(alerts(page, 'alert success'), ['Login page hero image reset to the built-in image. All admins have been notified.'])
      assert.ok(squash(page.text()).includes('Using the default background'))
      assert.equal(page.hasButton('Reset login image'), false)
    })

    it('saves only the changed login text (second form), trimmed, with the reason', async () => {
      script = [ok(appearance()), ok(withLoginText('Welcome to Acme', null))]
      const page = await open()
      await page.fill('login-heading', '  Welcome to Acme  ')
      await page.fill('login-text-reason', REASON)
      await page.submit(1)
      assert.deepEqual(calls[1], { path: '/admin/settings/appearance', method: 'PUT', body: { loginBranding: { heading: 'Welcome to Acme' }, reason: REASON } })
      assert.deepEqual(alerts(page, 'alert success'), ['Login page text saved. All admins have been notified.'])
      assert.equal(page.valueOf('login-heading'), 'Welcome to Acme')
      assert.equal(page.valueOf('login-text-reason'), '')
      assert.ok(squash(page.text()).includes('Custom · updated'))
    })

    it('goes back to the built-in text (null) when a field is cleared, leaving the other one alone', async () => {
      script = [ok(withLoginText('Welcome to Acme', 'Run your shop with us')), ok(withLoginText('Welcome to Acme', null))]
      const page = await open()
      assert.equal(page.valueOf('login-heading'), 'Welcome to Acme')
      assert.equal(page.valueOf('login-text'), 'Run your shop with us')
      await page.fill('login-text', '   ')
      await page.fill('login-text-reason', 'Back to the standard text')
      await page.submit(1)
      assert.deepEqual(calls[1].body, { loginBranding: { text: null }, reason: 'Back to the standard text' })
    })

    it('refuses nothing-to-save, a missing reason, a too long or multi-line text, and sends nothing', async () => {
      script = [ok(appearance())]
      const page = await open()
      await page.fill('login-text-reason', REASON)
      await page.submit(1)
      assert.match(alerts(page)[0], /^Nothing to save yet/)

      await page.fill('login-heading', 'Hello')
      await page.fill('login-text-reason', '')
      await page.submit(1)
      assert.deepEqual(alerts(page), ['Give a reason for the change (at least 5 characters).'])

      await page.fill('login-text-reason', REASON)
      await page.fill('login-heading', 'x'.repeat(81))
      await page.submit(1)
      assert.deepEqual(alerts(page), ['Login page heading: Can be at most 80 characters.'])

      await page.fill('login-heading', '')
      await page.fill('login-text', 'two\nlines')
      await page.submit(1)
      assert.deepEqual(alerts(page), ['Login page supporting text: Must be a single line.'])
      assert.equal(calls.length, 1, 'only the initial load')
    })

    it('shows the server\'s answer when the save fails and keeps what was typed', async () => {
      script = [ok(appearance()), fail(new ApiError('Validation error', 422, undefined, ['loginBranding.heading: The login heading must be a single line without control characters']))]
      const page = await open()
      await page.fill('login-heading', 'Hello')
      await page.fill('login-text-reason', REASON)
      await page.submit(1)
      assert.deepEqual(alerts(page, 'alert error'), ['The login heading must be a single line without control characters'])
      assert.equal(page.valueOf('login-heading'), 'Hello')
      assert.equal(page.valueOf('login-text-reason'), REASON)
    })

    it('saving one form never discards what is typed in the other', async () => {
      script = [ok(appearance()), ok(withLoginText('Welcome to Acme', null)), ok(appearance({ defaultTheme: 'light' }, ['defaultTheme']))]
      const page = await open()
      await page.fill('welcome-en', 'Draft welcome')
      await page.fill('login-heading', 'Welcome to Acme')
      await page.fill('login-text-reason', REASON)
      await page.submit(1)
      assert.equal(page.valueOf('welcome-en'), 'Draft welcome', 'the unsaved welcome text is still there')

      await page.fill('login-text', 'Draft supporting text')
      await page.fill('appearance-theme', 'light')
      await page.fill('appearance-text-reason', REASON)
      await page.submit(0)
      assert.equal(page.valueOf('login-text'), 'Draft supporting text', 'the unsaved login text is still there')
    })

    it('is read-only without settings:manage: no upload, reset or save controls', async () => {
      script = [ok(withLoginImage())]
      const page = await open({ canManage: false })
      assert.deepEqual(actionButtons(page), [])
      for (const id of ['login-file', 'login-reason', 'login-text-reason']) {
        await assert.rejects(page.change(id, {}), /No field with id/, `${id} is not offered`)
      }
    })
  })
})
