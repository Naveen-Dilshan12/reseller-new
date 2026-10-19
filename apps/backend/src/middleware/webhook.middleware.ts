import { Request, Response, NextFunction } from 'express'
import crypto from 'crypto'
import { verifyWebhookSignature, TIMESTAMP_HEADER, SIGNATURE_HEADER } from '../modules/integrations/signing'
import { decryptSecret, safeEqual } from '../utils/crypto'
import { prisma } from '../config/database'
import { env } from '../config/env'
import { logger, getCorrelationId } from '../utils/logger'
import { unauthorized } from './error.middleware'

/**
 * Middleware to verify webhook signatures from SaaS products
 * This ensures that webhooks are actually from the configured SaaS products
 */
export async function verifyWebhookMiddleware(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const correlationId = getCorrelationId(req)

  try {
    // Extract headers
    const timestamp = req.headers[TIMESTAMP_HEADER] as string
    const signature = req.headers[SIGNATURE_HEADER] as string
    const productCode = req.headers['x-product-code'] as string

    if (!timestamp || !signature || !productCode) {
      logger.warn('Webhook missing required headers', {
        correlationId,
        endpoint: req.path,
        method: req.method,
        hasTimestamp: !!timestamp,
        hasSignature: !!signature,
        hasProductCode: !!productCode,
      })
      next(unauthorized('Missing required webhook headers'))
      return
    }

    // Get the product and its integration config
    const product = await prisma.saasProduct.findUnique({
      where: { code: productCode },
      include: { integration: true },
    })

    if (!product || !product.integration) {
      logger.warn('Webhook for unknown or unconfigured product', {
        correlationId,
        productCode,
      })
      next(unauthorized('Unknown product or integration not configured'))
      return
    }

    // Decrypt the signing secret
    const signingSecret = decryptSecret(product.integration.signingSecretEncrypted || '')

    // Get raw body for signature verification
    const rawBody = (req as any).rawBody?.toString() || JSON.stringify(req.body)

    // Verify the signature
    const isValid = verifyWebhookSignature(signingSecret, rawBody, timestamp, signature)

    if (!isValid) {
      logger.warn('Webhook signature verification failed', {
        correlationId,
        productCode,
        timestamp,
        signature: signature.substring(0, 20) + '...', // Log partial signature for debugging
      })
      next(unauthorized('Invalid webhook signature'))
      return
    }

    // Attach product info to request for use in handlers
    ;(req as any).webhookProduct = product

    logger.info('Webhook signature verified successfully', {
      correlationId,
      productCode,
      timestamp,
    })

    next()
  } catch (error) {
    logger.error('Webhook verification error', error as Error, {
      correlationId,
      endpoint: req.path,
      method: req.method,
    })
    next(unauthorized('Webhook verification failed'))
  }
}

/**
 * Middleware to verify API signatures for partner API calls
 * This ensures that API calls are actually from authorized SaaS products
 */
export async function verifyApiSignatureMiddleware(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const correlationId = getCorrelationId(req)

  try {
    const timestamp = req.headers['x-timestamp'] as string
    const signature = req.headers['x-signature'] as string
    const apiKey = req.headers['x-api-key'] as string

    if (!timestamp || !signature || !apiKey) {
      logger.warn('API request missing required headers', {
        correlationId,
        endpoint: req.path,
        method: req.method,
      })
      next(unauthorized('Missing required API headers'))
      return
    }

    // Reject replays outside the tolerance window.
    const skewSeconds = Math.abs(Date.now() / 1000 - Number(timestamp))
    if (!Number.isFinite(skewSeconds) || skewSeconds > env.WEBHOOK_TOLERANCE_SECONDS) {
      logger.warn('API request timestamp outside tolerance window', { correlationId, endpoint: req.path })
      next(unauthorized('Request timestamp outside tolerance window'))
      return
    }

    // Find product by API key (hashed comparison)
    const products = await prisma.saasProduct.findMany({
      where: { integrationStatus: 'CONNECTED' },
      include: { integration: true },
    })

    let matchedProduct: typeof products[0] | null = null

    for (const product of products) {
      if (!product.integration?.apiKeyEncrypted) continue

      try {
        const decryptedKey = decryptSecret(product.integration.apiKeyEncrypted)
        if (safeEqual(decryptedKey, apiKey)) {
          matchedProduct = product
          break
        }
      } catch {
        continue
      }
    }

    if (!matchedProduct) {
      logger.warn('API request with invalid API key', {
        correlationId,
        endpoint: req.path,
      })
      next(unauthorized('Invalid API key'))
      return
    }

    // Verify signature using the signing secret
    const signingSecret = decryptSecret(matchedProduct.integration?.signingSecretEncrypted || '')
    const method = req.method
    const path = req.path
    const body = (req as any).rawBody?.toString() || JSON.stringify(req.body)

    // Recreate the expected signature
    const expectedSignature = `sha256=${crypto
      .createHmac('sha256', signingSecret)
      .update(`${timestamp}.${method.toUpperCase()}.${path}.${body}`)
      .digest('hex')}`

    if (!safeEqual(signature, expectedSignature)) {
      logger.warn('API signature verification failed', {
        correlationId,
        productCode: matchedProduct.code,
      })
      next(unauthorized('Invalid API signature'))
      return
    }

    // Attach product info to request
    ;(req as any).apiProduct = matchedProduct

    logger.info('API signature verified successfully', {
      correlationId,
      productCode: matchedProduct.code,
    })

    next()
  } catch (error) {
    logger.error('API signature verification error', error as Error, {
      correlationId,
      endpoint: req.path,
      method: req.method,
    })
    next(unauthorized('API signature verification failed'))
  }
}
