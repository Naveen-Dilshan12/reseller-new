import { Router, type Response } from 'express'
import multer from 'multer'
import { authenticate, requirePermission } from '../../middleware/auth.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../utils/async-handler'
import { sendSuccess } from '../../utils/response'
import { appearanceImageReasonSchema, updateAppearanceSchema } from './appearance.schema'
import { appearanceService, IMAGE_RULES, type ImageKind } from './appearance.service'

/** Kept in memory until the content is verified, then written encrypted to private storage. */
const uploader = (kind: ImageKind) =>
  multer({ storage: multer.memoryStorage(), limits: { fileSize: IMAGE_RULES[kind].maxBytes, files: 1, fields: 5, fieldSize: 2048 } }).single('image')

function sendImage(res: Response, image: { content: Buffer; mimeType: string }) {
  res.set({
    'Content-Type': image.mimeType,
    'Content-Length': String(image.content.length),
    'Content-Disposition': 'inline',
    'Cache-Control': 'no-store, private',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  })
  res.send(image.content)
}

/** `/admin/settings/appearance`: read for `settings:read`, every change needs `settings:manage` and a reason. */
export const appearanceAdminRouter = Router()
appearanceAdminRouter.use(authenticate)

appearanceAdminRouter.get(
  '/',
  requirePermission('settings:read'),
  asyncHandler(async (_req, res) => sendSuccess(res, await appearanceService.getAdmin())),
)

appearanceAdminRouter.put(
  '/',
  requirePermission('settings:manage'),
  validate(updateAppearanceSchema),
  asyncHandler(async (req, res) => sendSuccess(res, await appearanceService.updatePreferences(req, req.body), 'Appearance updated')),
)

for (const [path, kind] of [['hero-image', 'hero'], ['logo', 'logo'], ['login-image', 'login']] as const) {
  // Permission first, so a caller who may not change settings never gets a file buffered.
  appearanceAdminRouter.put(
    `/${path}`,
    requirePermission('settings:manage'),
    uploader(kind),
    validate(appearanceImageReasonSchema),
    asyncHandler(async (req, res) =>
      sendSuccess(res, await appearanceService.replaceImage(req, kind, req.file, req.body.reason), `${IMAGE_RULES[kind].label} updated`),
    ),
  )
  appearanceAdminRouter.post(
    `/${path}/reset`,
    requirePermission('settings:manage'),
    validate(appearanceImageReasonSchema),
    asyncHandler(async (req, res) =>
      sendSuccess(res, await appearanceService.resetImage(req, kind, req.body.reason), `${IMAGE_RULES[kind].label} reset to the built-in image`),
    ),
  )
}

/**
 * `/appearance`: what the portal needs to draw itself. Any signed-in user may read it (it holds branding only, no
 * secrets), and the images are never public: the web app fetches them with its bearer token.
 */
export const appearanceReadRouter = Router()
appearanceReadRouter.use(authenticate)

appearanceReadRouter.get('/', asyncHandler(async (_req, res) => sendSuccess(res, await appearanceService.getPublic())))
appearanceReadRouter.get('/hero-image', asyncHandler(async (_req, res) => sendImage(res, await appearanceService.readImage('hero'))))
appearanceReadRouter.get('/logo', asyncHandler(async (_req, res) => sendImage(res, await appearanceService.readImage('logo'))))

/**
 * `/public/login-branding`: the one deliberately unauthenticated part of the appearance settings, because the login page
 * is shown before anyone is signed in. It serves only the login heading, supporting text, colors and login hero image;
 * every other setting and image stays behind `authenticate` above.
 */
export const loginBrandingRouter = Router()

loginBrandingRouter.get('/', asyncHandler(async (_req, res) => sendSuccess(res, await appearanceService.getLoginBranding())))
loginBrandingRouter.get('/hero-image', asyncHandler(async (_req, res) => sendImage(res, await appearanceService.readImage('login'))))
