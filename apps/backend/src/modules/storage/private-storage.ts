import crypto from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import { env } from '../../config/env'
import { badRequest } from '../../middleware/error.middleware'
import { decryptBuffer, encryptBuffer } from '../../utils/crypto'

/**
 * Encrypted file storage under UPLOAD_DIR. Nothing here is served statically:
 * files are only read back through authorised endpoints.
 */

const ROOT = path.resolve(env.UPLOAD_DIR)
const KEY_PATTERN = /^[a-z-]+\/\d{4}\/\d{2}\/[a-f0-9]{32}\.enc$/

export interface DetectedFile {
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf'
  extension: string
}

/** Identifies the file by its content, never by the client-supplied type or name. */
export function detectFileType(buf: Buffer): DetectedFile | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mimeType: 'image/jpeg', extension: 'jpg' }
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mimeType: 'image/png', extension: 'png' }
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { mimeType: 'image/webp', extension: 'webp' }
  }
  if (buf.length >= 5 && buf.toString('ascii', 0, 5) === '%PDF-') return { mimeType: 'application/pdf', extension: 'pdf' }
  return null
}

function resolveKey(key: string): string {
  if (!KEY_PATTERN.test(key)) throw badRequest('Invalid storage key')
  const full = path.resolve(ROOT, key)
  if (!full.startsWith(ROOT + path.sep)) throw badRequest('Invalid storage key')
  return full
}

export const privateStorage = {
  async save(folder: string, content: Buffer): Promise<string> {
    const now = new Date()
    const key = `${folder}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${crypto.randomBytes(16).toString('hex')}.enc`
    const full = resolveKey(key)
    await fs.mkdir(path.dirname(full), { recursive: true, mode: 0o700 })
    await fs.writeFile(full, encryptBuffer(content), { mode: 0o600, flag: 'wx' })
    return key
  },

  async read(key: string): Promise<Buffer> {
    return decryptBuffer(await fs.readFile(resolveKey(key)))
  },

  async remove(key: string): Promise<void> {
    await fs.rm(resolveKey(key), { force: true })
  },
}
