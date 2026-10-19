import { Request, Response, NextFunction } from 'express'
import { logger, getCorrelationId } from '../utils/logger'

const SUPPORTED_VERSIONS = ['v1']
const DEFAULT_VERSION = 'v1'
const DEPRECATED_VERSIONS: Record<string, string> = {}

/**
 * Extracts API version from URL path or header
 * Supported formats:
 * - URL path: /api/v1/...
 * - Header: X-API-Version: v1
 */
export function apiVersionMiddleware(req: Request, res: Response, next: NextFunction): void {
  const correlationId = getCorrelationId(req)

  try {
    // The router is mounted under the prefix, so match against the full URL.
    const pathVersionMatch = req.originalUrl.match(/\/(v\d+)(?:[/?]|$)/)
    let version = pathVersionMatch ? pathVersionMatch[1] : null

    // Fall back to header
    if (!version) {
      version = (req.headers['x-api-version'] as string) || DEFAULT_VERSION
    }

    // Validate version
    if (!SUPPORTED_VERSIONS.includes(version)) {
      logger.warn('Unsupported API version requested', {
        correlationId,
        requestedVersion: version,
        supportedVersions: SUPPORTED_VERSIONS,
        endpoint: req.path,
      })

      res.setHeader('X-API-Supported-Versions', SUPPORTED_VERSIONS.join(', '))
      res.status(400).json({
        success: false,
        message: `Unsupported API version: ${version}. Supported versions: ${SUPPORTED_VERSIONS.join(', ')}`,
        correlationId,
      })
      return
    }

    // Add deprecation warning if applicable
    if (DEPRECATED_VERSIONS[version]) {
      res.setHeader('X-API-Deprecation-Warning', DEPRECATED_VERSIONS[version])
      logger.info('Deprecated API version requested', {
        correlationId,
        version,
        warning: DEPRECATED_VERSIONS[version],
      })
    }

    // Add version headers
    res.setHeader('X-API-Version', version)
    res.setHeader('X-API-Supported-Versions', SUPPORTED_VERSIONS.join(', '))

    // Attach version to request for use in handlers
    ;(req as any).apiVersion = version

    logger.debug('API version determined', {
      correlationId,
      version,
      endpoint: req.path,
    })

    next()
  } catch (error) {
    logger.error('API version middleware error', error as Error, {
      correlationId,
      endpoint: req.path,
    })
    // Default to latest version on error
    ;(req as any).apiVersion = DEFAULT_VERSION
    next()
  }
}

/**
 * Middleware to ensure minimum API version
 * Use this for endpoints that require a specific version or higher
 */
export function requireMinVersion(minVersion: string) {
  const versionOrder = SUPPORTED_VERSIONS.reduce((acc, version, index) => {
    acc[version] = index
    return acc
  }, {} as Record<string, number>)

  return (req: Request, res: Response, next: NextFunction): void => {
    const currentVersion = (req as any).apiVersion || DEFAULT_VERSION
    const currentIndex = versionOrder[currentVersion]
    const minIndex = versionOrder[minVersion]

    if (currentIndex === undefined || minIndex === undefined) {
      res.status(500).json({
        success: false,
        message: 'Invalid version configuration',
      })
      return
    }

    if (currentIndex < minIndex) {
      res.status(400).json({
        success: false,
        message: `This endpoint requires API version ${minVersion} or higher. Current version: ${currentVersion}`,
      })
      return
    }

    next()
  }
}

/**
 * Get current API version from request
 */
export function getApiVersion(req: Request): string {
  return (req as any).apiVersion || DEFAULT_VERSION
}
