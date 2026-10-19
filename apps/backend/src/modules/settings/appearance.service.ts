import type { Request } from 'express'
import { prisma } from '../../config/database'
import { env } from '../../config/env'
import { badRequest, notFoundError } from '../../middleware/error.middleware'
import { logger } from '../../utils/logger'
import { auditService } from '../audit-logs/audit.service'
import { notificationService } from '../notifications/notification.service'
import { readImageDimensions, type InspectableImageType } from '../storage/image-inspect'
import { detectFileType, privateStorage } from '../storage/private-storage'
import {
  BUILT_IN_THEME,
  LOGIN_HEADING_MAX_LENGTH,
  LOGIN_TEXT_MAX_LENGTH,
  LOGIN_THEME_COLOR_KEYS,
  THEME_MODES,
  WELCOME_TEXT_MAX_LENGTH,
  loginHeadingSchema,
  loginTextSchema,
  loginThemeSchema,
  welcomeTextSchema,
  type LoginThemeInput,
  type ThemeMode,
  type UpdateAppearanceInput,
} from './appearance.schema'
import { SETTING_KEYS } from './settings.service'

/**
 * Global reseller-portal appearance, kept in PlatformSetting (one row per setting). A missing row always means
 * "use the built-in default", so nothing changes in the portal until an admin saves a custom value.
 * The image rows hold a private-storage key; it is never returned to a client.
 *
 * The login page is the one logged-out screen: its four branding settings (hero image, heading, supporting text, colors) are
 * served by `getLoginBranding` / `readImage('login')` on a public route and nothing else in this file is.
 */

export type ImageKind = 'hero' | 'logo' | 'login'

const MB = 1024 * 1024
export const ALLOWED_IMAGE_TYPES: readonly InspectableImageType[] = ['image/jpeg', 'image/png', 'image/webp']

export const IMAGE_RULES = {
  hero: {
    setting: SETTING_KEYS.APPEARANCE_HERO_IMAGE,
    folder: 'appearance-hero',
    label: 'Dashboard hero image',
    maxBytes: env.MAX_UPLOAD_MB * MB,
    minWidth: 800,
    minHeight: 300,
    maxSide: 8000,
  },
  logo: {
    setting: SETTING_KEYS.APPEARANCE_LOGO_IMAGE,
    folder: 'appearance-logo',
    label: 'Platform logo',
    maxBytes: Math.min(env.MAX_UPLOAD_MB, 2) * MB,
    minWidth: 32,
    minHeight: 32,
    maxSide: 4000,
  },
  login: {
    setting: SETTING_KEYS.APPEARANCE_LOGIN_IMAGE,
    folder: 'appearance-login',
    label: 'Login page hero image',
    maxBytes: env.MAX_UPLOAD_MB * MB,
    minWidth: 800,
    minHeight: 600,
    maxSide: 8000,
  },
} as const

type SettingRow = { key: string; value: string; updatedAt: Date; updatedById: string | null }

/** The only rows the public login endpoint reads. */
const LOGIN_KEYS = [SETTING_KEYS.APPEARANCE_LOGIN_IMAGE, SETTING_KEYS.APPEARANCE_LOGIN_HEADING, SETTING_KEYS.APPEARANCE_LOGIN_TEXT, SETTING_KEYS.APPEARANCE_LOGIN_THEME]

const ALL_KEYS = [
  SETTING_KEYS.APPEARANCE_HERO_IMAGE,
  SETTING_KEYS.APPEARANCE_LOGO_IMAGE,
  SETTING_KEYS.APPEARANCE_WELCOME_TEXT_EN,
  SETTING_KEYS.APPEARANCE_WELCOME_TEXT_SI,
  SETTING_KEYS.APPEARANCE_DEFAULT_THEME,
  ...LOGIN_KEYS,
]

/** Image changes and resets run one at a time, so two admins cannot orphan or delete each other's file. */
let queueTail: Promise<unknown> = Promise.resolve()
function inSequence<T>(task: () => Promise<T>): Promise<T> {
  const run = queueTail.then(() => task())
  queueTail = run.catch(() => undefined)
  return run
}

async function loadRows(keys: string[] = ALL_KEYS): Promise<Map<string, SettingRow>> {
  const rows = await prisma.platformSetting.findMany({ where: { key: { in: keys } } })
  return new Map(rows.map((r) => [r.key, r]))
}

function themeOf(row: SettingRow | undefined): ThemeMode | null {
  return THEME_MODES.find((m) => m === row?.value) ?? null
}

/** A stored text that no longer passes validation (edited by hand in the database) is ignored rather than shown. */
function textOf(row: SettingRow | undefined, schema: { safeParse(v: unknown): { success: true; data: string } | { success: false } } = welcomeTextSchema): string | null {
  if (!row) return null
  const parsed = schema.safeParse(row.value)
  return parsed.success ? parsed.data : null
}

/** Stored as JSON in a fixed key order, so the same colors are always the same text (an unchanged save is detected as such). */
function serializeLoginTheme(theme: LoginThemeInput): string {
  return JSON.stringify({ colors: Object.fromEntries(LOGIN_THEME_COLOR_KEYS.map((k) => [k, theme.colors[k]])) })
}

/** A stored theme that no longer passes validation (edited by hand in the database, or the rules changed) is ignored: built-in colors. */
function loginThemeOf(row: SettingRow | undefined): LoginThemeInput | null {
  if (!row) return null
  try {
    const parsed = loginThemeSchema.safeParse(JSON.parse(row.value))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** `version` changes whenever the file is replaced, so browsers know to fetch it again. */
function imageOf(row: SettingRow | undefined) {
  return row ? { version: row.updatedAt.toISOString() } : null
}

function toPublic(rows: Map<string, SettingRow>) {
  return {
    defaultTheme: themeOf(rows.get(SETTING_KEYS.APPEARANCE_DEFAULT_THEME)) ?? BUILT_IN_THEME,
    welcomeText: {
      en: textOf(rows.get(SETTING_KEYS.APPEARANCE_WELCOME_TEXT_EN)),
      si: textOf(rows.get(SETTING_KEYS.APPEARANCE_WELCOME_TEXT_SI)),
    },
    heroImage: imageOf(rows.get(SETTING_KEYS.APPEARANCE_HERO_IMAGE)),
    logo: imageOf(rows.get(SETTING_KEYS.APPEARANCE_LOGO_IMAGE)),
  }
}

/** null = use the built-in heading, supporting text, image or colors. */
function toLoginBranding(rows: Map<string, SettingRow>) {
  return {
    heading: textOf(rows.get(SETTING_KEYS.APPEARANCE_LOGIN_HEADING), loginHeadingSchema),
    text: textOf(rows.get(SETTING_KEYS.APPEARANCE_LOGIN_TEXT), loginTextSchema),
    heroImage: imageOf(rows.get(SETTING_KEYS.APPEARANCE_LOGIN_IMAGE)),
    theme: loginThemeOf(rows.get(SETTING_KEYS.APPEARANCE_LOGIN_THEME)),
  }
}

function limitsOf(kind: ImageKind) {
  const r = IMAGE_RULES[kind]
  return { maxBytes: r.maxBytes, minWidth: r.minWidth, minHeight: r.minHeight, maxSide: r.maxSide }
}

async function inspectUpload(kind: ImageKind, file: { buffer: Buffer } | undefined) {
  const rule = IMAGE_RULES[kind]
  const buffer = file?.buffer
  if (!buffer || buffer.length === 0) throw badRequest('Choose an image to upload', ['image: Choose an image to upload'])
  if (buffer.length > rule.maxBytes) {
    throw badRequest(`The image must be ${rule.maxBytes / MB} MB or smaller`, [`image: Larger than ${rule.maxBytes / MB} MB`])
  }
  // Identified from the content, never from the client-supplied name or type. PDFs and SVGs are not images here.
  const detected = detectFileType(buffer)
  if (!detected || !ALLOWED_IMAGE_TYPES.includes(detected.mimeType as InspectableImageType)) {
    throw badRequest('The image must be a JPG, PNG or WEBP file', ['image: Unsupported file type'])
  }
  const size = readImageDimensions(buffer, detected.mimeType as InspectableImageType)
  if (!size) throw badRequest('The file is not a readable JPG, PNG or WEBP image', ['image: Not a valid image'])
  if (size.width < rule.minWidth || size.height < rule.minHeight) {
    throw badRequest(`The image must be at least ${rule.minWidth} × ${rule.minHeight} pixels`, [`image: Too small (${size.width} × ${size.height})`])
  }
  if (size.width > rule.maxSide || size.height > rule.maxSide) {
    throw badRequest(`The image can be at most ${rule.maxSide} pixels on either side`, [`image: Too large (${size.width} × ${size.height})`])
  }
  return { buffer, mimeType: detected.mimeType, ...size }
}

export const appearanceService = {
  /** What every signed-in user needs to render the portal. Contains no admin details and no storage paths. */
  async getPublic() {
    return toPublic(await loadRows())
  },

  /**
   * What the logged-out login page needs, and nothing more: heading, supporting text, colors and whether a custom image exists.
   * Only the four login rows are read, so no other setting can reach this response.
   */
  async getLoginBranding() {
    return toLoginBranding(await loadRows(LOGIN_KEYS))
  },

  /** The public values plus where each came from, who last changed it, and the upload rules. */
  async getAdmin() {
    const rows = await loadRows()
    const userIds = [...new Set([...rows.values()].map((r) => r.updatedById).filter((id): id is string => Boolean(id)))]
    const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }) : []
    const detail = (key: string) => {
      const row = rows.get(key)
      const by = row?.updatedById ? users.find((u) => u.id === row.updatedById) : undefined
      return { custom: Boolean(row), updatedAt: row?.updatedAt ?? null, updatedBy: by ? { name: by.name, email: by.email } : null }
    }
    return {
      ...toPublic(rows),
      loginBranding: toLoginBranding(rows),
      details: {
        heroImage: detail(SETTING_KEYS.APPEARANCE_HERO_IMAGE),
        logo: detail(SETTING_KEYS.APPEARANCE_LOGO_IMAGE),
        welcomeTextEn: detail(SETTING_KEYS.APPEARANCE_WELCOME_TEXT_EN),
        welcomeTextSi: detail(SETTING_KEYS.APPEARANCE_WELCOME_TEXT_SI),
        defaultTheme: detail(SETTING_KEYS.APPEARANCE_DEFAULT_THEME),
        loginImage: detail(SETTING_KEYS.APPEARANCE_LOGIN_IMAGE),
        loginHeading: detail(SETTING_KEYS.APPEARANCE_LOGIN_HEADING),
        loginText: detail(SETTING_KEYS.APPEARANCE_LOGIN_TEXT),
        loginTheme: detail(SETTING_KEYS.APPEARANCE_LOGIN_THEME),
      },
      limits: {
        imageTypes: ALLOWED_IMAGE_TYPES,
        hero: limitsOf('hero'),
        logo: limitsOf('logo'),
        login: limitsOf('login'),
        welcomeTextMaxLength: WELCOME_TEXT_MAX_LENGTH,
        loginHeadingMaxLength: LOGIN_HEADING_MAX_LENGTH,
        loginTextMaxLength: LOGIN_TEXT_MAX_LENGTH,
      },
    }
  },

  /** Welcome texts, login texts, login colors and the default color mode. A `null` value deletes the row, i.e. goes back to the built-in default. */
  async updatePreferences(req: Request, input: UpdateAppearanceInput) {
    const requested: Array<{ label: string; key: string; value: string | null | undefined }> = [
      { label: 'default color mode', key: SETTING_KEYS.APPEARANCE_DEFAULT_THEME, value: input.defaultTheme },
      { label: 'English welcome text', key: SETTING_KEYS.APPEARANCE_WELCOME_TEXT_EN, value: input.welcomeText?.en },
      { label: 'Sinhala welcome text', key: SETTING_KEYS.APPEARANCE_WELCOME_TEXT_SI, value: input.welcomeText?.si },
      { label: 'login page heading', key: SETTING_KEYS.APPEARANCE_LOGIN_HEADING, value: input.loginBranding?.heading },
      { label: 'login page supporting text', key: SETTING_KEYS.APPEARANCE_LOGIN_TEXT, value: input.loginBranding?.text },
      {
        label: 'login page theme',
        key: SETTING_KEYS.APPEARANCE_LOGIN_THEME,
        value: input.loginTheme === undefined ? undefined : input.loginTheme === null ? null : serializeLoginTheme(input.loginTheme),
      },
    ].filter((r) => r.value !== undefined)

    const changed = await prisma.$transaction(async (tx) => {
      const changes: Array<{ setting: string; before: string | null; after: string | null }> = []
      for (const r of requested) {
        const current = await tx.platformSetting.findUnique({ where: { key: r.key } })
        const before = current?.value ?? null
        const after = r.value ?? null
        if (before === after) continue
        if (after === null) await tx.platformSetting.deleteMany({ where: { key: r.key } })
        else {
          await tx.platformSetting.upsert({
            where: { key: r.key },
            create: { key: r.key, value: after, updatedById: req.user!.userId },
            update: { value: after, updatedById: req.user!.userId },
          })
        }
        changes.push({ setting: r.label, before, after })
      }
      if (changes.length > 0) {
        await auditService.fromRequest(
          req,
          { action: 'SETTINGS_APPEARANCE_UPDATED', entityType: 'PlatformSetting', entityId: 'APPEARANCE', metadata: { reason: input.reason, changes } },
          tx,
        )
      }
      return changes
    })

    if (changed.length > 0) await notifyAdmins(req, `changed the portal appearance (${changed.map((c) => c.setting).join(', ')})`, input.reason)
    return this.getAdmin()
  },

  /**
   * Stores a new image and points the setting at it. The previous file is deleted only after the new one is
   * committed; if anything fails, the new file is removed and the previous image stays exactly as it was.
   */
  async replaceImage(req: Request, kind: ImageKind, file: { buffer: Buffer } | undefined, reason: string) {
    const rule = IMAGE_RULES[kind]
    const image = await inspectUpload(kind, file)

    const previousKey = await inSequence(async () => {
      const newKey = await privateStorage.save(rule.folder, image.buffer)
      try {
        return await prisma.$transaction(async (tx) => {
          const current = await tx.platformSetting.findUnique({ where: { key: rule.setting } })
          await tx.platformSetting.upsert({
            where: { key: rule.setting },
            create: { key: rule.setting, value: newKey, updatedById: req.user!.userId },
            update: { value: newKey, updatedById: req.user!.userId },
          })
          await auditService.fromRequest(
            req,
            {
              action: 'SETTINGS_APPEARANCE_IMAGE_UPDATED',
              entityType: 'PlatformSetting',
              entityId: rule.setting,
              metadata: { image: kind, reason, replacedCustomImage: Boolean(current), mimeType: image.mimeType, sizeBytes: image.buffer.length, width: image.width, height: image.height },
            },
            tx,
          )
          return current?.value ?? null
        })
      } catch (err) {
        await privateStorage.remove(newKey).catch(() => undefined)
        throw err
      }
    })

    await removeQuietly(previousKey)
    await notifyAdmins(req, `replaced the ${rule.label.toLowerCase()}`, reason)
    return this.getAdmin()
  },

  /** Goes back to the built-in image. A no-op (and no audit entry) when no custom image is set. */
  async resetImage(req: Request, kind: ImageKind, reason: string) {
    const rule = IMAGE_RULES[kind]
    const previousKey = await inSequence(() =>
      prisma.$transaction(async (tx) => {
        const current = await tx.platformSetting.findUnique({ where: { key: rule.setting } })
        if (!current) return null
        await tx.platformSetting.deleteMany({ where: { key: rule.setting } })
        await auditService.fromRequest(
          req,
          { action: 'SETTINGS_APPEARANCE_IMAGE_RESET', entityType: 'PlatformSetting', entityId: rule.setting, metadata: { image: kind, reason } },
          tx,
        )
        return current.value
      }),
    )
    if (previousKey) {
      await removeQuietly(previousKey)
      await notifyAdmins(req, `reset the ${rule.label.toLowerCase()} to the built-in image`, reason)
    }
    return this.getAdmin()
  },

  /** Decrypted bytes of the current custom image; 404 when none is set (callers then show the built-in image). */
  async readImage(kind: ImageKind) {
    const row = await prisma.platformSetting.findUnique({ where: { key: IMAGE_RULES[kind].setting } })
    if (!row) throw notFoundError('Image')
    let content: Buffer
    try {
      content = await privateStorage.read(row.value)
    } catch (err) {
      logger.warn(`[Appearance] ${kind} image could not be read from storage`, { error: err instanceof Error ? err.message : String(err) })
      throw notFoundError('Image')
    }
    const detected = detectFileType(content)
    if (!detected || !ALLOWED_IMAGE_TYPES.includes(detected.mimeType as InspectableImageType)) throw notFoundError('Image')
    return { content, mimeType: detected.mimeType }
  },
}

async function removeQuietly(key: string | null) {
  if (!key) return
  // The setting no longer points at this file, so a failed delete only leaves an unreferenced encrypted file behind.
  await privateStorage.remove(key).catch((err) => logger.warn('[Appearance] old image file could not be deleted', { error: err instanceof Error ? err.message : String(err) }))
}

async function notifyAdmins(req: Request, what: string, reason: string) {
  await notificationService.notifyPlatform({
    type: 'SETTINGS_CHANGED',
    title: 'Portal appearance changed',
    body: `${req.user!.email} ${what}. Reason: ${reason}`,
    link: '/admin/settings',
  })
}
