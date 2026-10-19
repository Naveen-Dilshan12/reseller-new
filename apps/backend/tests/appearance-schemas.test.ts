import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  LOGIN_HEADING_MAX_LENGTH,
  LOGIN_TEXT_MAX_LENGTH,
  appearanceImageReasonSchema,
  loginHeadingSchema,
  loginTextSchema,
  updateAppearanceSchema,
  welcomeTextSchema,
} from '../src/modules/settings/appearance.schema'
import { readImageDimensions } from '../src/modules/storage/image-inspect'
import { jpegImage, pngImage, webpImage, webpLosslessImage, webpLossyImage } from './helpers/image-fixtures'

/**
 * Appearance settings: input validation and image header inspection. Pure functions: no database, no `.env`, no files.
 */

const reason = 'Seasonal refresh'
const ok = (body: unknown) => updateAppearanceSchema.safeParse(body)
const messages = (body: unknown) => {
  const r = ok(body)
  return r.success ? [] : r.error.issues.map((i) => i.message)
}

describe('updateAppearanceSchema', () => {
  it('accepts a color mode, either welcome text, or all of them, with a reason', () => {
    for (const body of [
      { defaultTheme: 'light', reason },
      { defaultTheme: 'system', reason },
      { welcomeText: { en: 'Welcome, {name}!' }, reason },
      { welcomeText: { si: 'සාදරයෙන් පිළිගනිමු, {name}!' }, reason },
      { defaultTheme: 'dark', welcomeText: { en: 'Hello', si: 'ආයුබෝවන්' }, reason },
    ]) {
      assert.equal(ok(body).success, true, JSON.stringify(body))
    }
  })

  it('accepts null as "go back to the built-in default"', () => {
    assert.equal(ok({ defaultTheme: null, reason }).success, true)
    assert.equal(ok({ welcomeText: { en: null, si: null }, reason }).success, true)
  })

  it('requires a reason of at least 5 characters, like the other audited settings', () => {
    assert.ok(ok({ defaultTheme: 'light' }).success === false)
    assert.ok(messages({ defaultTheme: 'light', reason: 'abc' }).some((m) => /reason/i.test(m)))
    assert.ok(ok({ defaultTheme: 'light', reason: 'x'.repeat(301) }).success === false)
  })

  it('refuses a request that changes nothing', () => {
    assert.deepEqual(messages({ reason }), ['Change at least one appearance setting'])
    assert.ok(ok({ welcomeText: {}, reason }).success === false)
  })

  it('refuses unknown color modes and unknown fields (no per-reseller overrides, accent colors or other login settings)', () => {
    assert.ok(ok({ defaultTheme: 'purple', reason }).success === false)
    assert.ok(ok({ defaultTheme: 'LIGHT', reason }).success === false)
    for (const extra of [{ accentColor: '#ff0000' }, { resellerId: 'r1' }, { loginBackground: 'x' }, { heroImage: 'x' }]) {
      assert.ok(ok({ defaultTheme: 'light', reason, ...extra }).success === false, JSON.stringify(extra))
    }
    assert.ok(ok({ welcomeText: { fr: 'Bonjour' }, reason }).success === false)
  })
})

describe('login page branding in updateAppearanceSchema', () => {
  it('accepts a heading, a supporting text, or both, and null as "back to the built-in text"', () => {
    for (const body of [
      { loginBranding: { heading: 'Welcome to Acme' }, reason },
      { loginBranding: { text: 'Run your shop with us.' }, reason },
      { loginBranding: { heading: 'ආයුබෝවන්', text: 'සාදරයෙන් පිළිගනිමු' }, reason },
      { loginBranding: { heading: null, text: null }, reason },
      { defaultTheme: 'light', loginBranding: { heading: 'Hello' }, reason },
    ]) {
      assert.equal(ok(body).success, true, JSON.stringify(body))
    }
  })

  it('still refuses a request that changes nothing, and unknown login fields', () => {
    assert.deepEqual(messages({ loginBranding: {}, reason }), ['Change at least one appearance setting'])
    for (const extra of [{ image: 'x' }, { background: '#000' }, { tagline: 'x' }]) {
      assert.ok(ok({ loginBranding: { heading: 'Hello', ...extra }, reason }).success === false, JSON.stringify(extra))
    }
  })
})

describe('loginHeadingSchema and loginTextSchema', () => {
  it('trim and accept one line of plain text, braces and all (there are no placeholders on the login page)', () => {
    assert.deepEqual(loginHeadingSchema.safeParse('  Welcome to Acme  '), { success: true, data: 'Welcome to Acme' })
    assert.equal(loginHeadingSchema.safeParse('Acme {Shop} & Co.').success, true)
    assert.equal(loginTextSchema.safeParse('නැවත සාදරයෙන් පිළිගනිමු').success, true)
  })

  it('refuse empty text (use null to reset), too long text, and line breaks or control characters', () => {
    for (const schema of [loginHeadingSchema, loginTextSchema]) {
      assert.equal(schema.safeParse('').success, false)
      assert.equal(schema.safeParse('   ').success, false)
      assert.equal(schema.safeParse('two\nlines').success, false)
      assert.equal(schema.safeParse('tab\there').success, false)
      assert.equal(schema.safeParse('bell\u0007').success, false)
    }
    assert.equal(loginHeadingSchema.safeParse('x'.repeat(LOGIN_HEADING_MAX_LENGTH)).success, true)
    assert.equal(loginHeadingSchema.safeParse('x'.repeat(LOGIN_HEADING_MAX_LENGTH + 1)).success, false)
    assert.equal(loginTextSchema.safeParse('x'.repeat(LOGIN_TEXT_MAX_LENGTH)).success, true)
    assert.equal(loginTextSchema.safeParse('x'.repeat(LOGIN_TEXT_MAX_LENGTH + 1)).success, false)
    assert.deepEqual([LOGIN_HEADING_MAX_LENGTH, LOGIN_TEXT_MAX_LENGTH], [80, 200])
  })
})

describe('welcomeTextSchema', () => {
  const check = (text: string) => welcomeTextSchema.safeParse(text)

  it('trims and accepts one line with {name}, plain text or Sinhala', () => {
    assert.deepEqual(check('  Welcome back, {name}!  '), { success: true, data: 'Welcome back, {name}!' })
    assert.equal(check('Hello team').success, true)
    assert.equal(check('නැවත සාදරයෙන් පිළිගනිමු, {name}!').success, true)
    assert.equal(check('{name} {name}').success, true)
  })

  it('refuses empty text (use null to reset) and text over 120 characters', () => {
    assert.equal(check('').success, false)
    assert.equal(check('   ').success, false)
    assert.equal(check('x'.repeat(120)).success, true)
    assert.equal(check('x'.repeat(121)).success, false)
  })

  it('refuses other placeholders and stray braces', () => {
    for (const bad of ['Hi {user}', 'Hi {Name}', 'Hi {name', 'Hi name}', 'Hi {{name}}', '{}', 'Hi {name}}']) {
      assert.equal(check(bad).success, false, bad)
    }
    assert.equal(check('Rs. $ for {name}').success, true, 'a literal $ is plain text')
  })

  it('refuses line breaks and control characters', () => {
    assert.equal(check('Hello\nthere').success, false)
    assert.equal(check('Hello\u0007').success, false)
    assert.equal(check('Hello\tthere').success, false)
  })
})

describe('appearanceImageReasonSchema', () => {
  it('needs a reason and nothing else', () => {
    assert.equal(appearanceImageReasonSchema.safeParse({ reason }).success, true)
    assert.equal(appearanceImageReasonSchema.safeParse({}).success, false)
    assert.equal(appearanceImageReasonSchema.safeParse({ reason, extra: 1 }).success, false)
  })
})

describe('readImageDimensions', () => {
  it('reads PNG, JPEG and all three WEBP layouts', () => {
    assert.deepEqual(readImageDimensions(pngImage(1920, 640), 'image/png'), { width: 1920, height: 640 })
    assert.deepEqual(readImageDimensions(jpegImage(1600, 900), 'image/jpeg'), { width: 1600, height: 900 })
    assert.deepEqual(readImageDimensions(webpImage(2400, 1000), 'image/webp'), { width: 2400, height: 1000 })
    assert.deepEqual(readImageDimensions(webpLossyImage(1280, 720), 'image/webp'), { width: 1280, height: 720 })
    assert.deepEqual(readImageDimensions(webpLosslessImage(512, 256), 'image/webp'), { width: 512, height: 256 })
  })

  it('returns null for a file that only starts with the right signature', () => {
    assert.equal(readImageDimensions(pngImage(10, 10).subarray(0, 12), 'image/png'), null)
    assert.equal(readImageDimensions(jpegImage(10, 10).subarray(0, 8), 'image/jpeg'), null)
    assert.equal(readImageDimensions(webpImage(10, 10).subarray(0, 14), 'image/webp'), null)
    assert.equal(readImageDimensions(Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg'), null)
  })

  it('returns null for zero-sized or unknown layouts', () => {
    assert.equal(readImageDimensions(pngImage(0, 100), 'image/png'), null)
    const odd = webpImage(100, 100)
    odd.write('XXXX', 12, 'ascii')
    assert.equal(readImageDimensions(odd, 'image/webp'), null)
    const noFrame = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]), Buffer.alloc(8)])
    assert.equal(readImageDimensions(noFrame, 'image/jpeg'), null)
  })
})
