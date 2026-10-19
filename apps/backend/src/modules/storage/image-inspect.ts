/**
 * Reads the pixel size of a JPEG, PNG or WEBP from its headers, without decoding the image. The type must already
 * have been identified from the content (see `detectFileType`). Returns null when the headers are truncated or
 * inconsistent, which is how a file that only starts with the right signature is told apart from a real image.
 */

export interface ImageDimensions {
  width: number
  height: number
}

export type InspectableImageType = 'image/jpeg' | 'image/png' | 'image/webp'

function png(buf: Buffer): ImageDimensions | null {
  // signature (8) + IHDR chunk: length (4), "IHDR" (4), width (4), height (4)
  if (buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

function jpeg(buf: Buffer): ImageDimensions | null {
  let p = 2
  while (p + 4 <= buf.length) {
    if (buf[p] !== 0xff) return null
    const marker = buf[p + 1]
    if (marker === 0xff) {
      p += 1 // fill byte
      continue
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      p += 2 // markers without a payload
      continue
    }
    if (marker === 0xd9 || marker === 0xda) return null // end of image / start of scan before any frame header
    const length = buf.readUInt16BE(p + 2)
    if (length < 2) return null
    const isFrameHeader = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isFrameHeader) {
      if (p + 9 > buf.length) return null
      return { height: buf.readUInt16BE(p + 5), width: buf.readUInt16BE(p + 7) }
    }
    p += 2 + length
  }
  return null
}

function webp(buf: Buffer): ImageDimensions | null {
  if (buf.length < 30) return null
  const chunk = buf.toString('ascii', 12, 16)
  const data = 20
  if (chunk === 'VP8 ') {
    if (buf[data + 3] !== 0x9d || buf[data + 4] !== 0x01 || buf[data + 5] !== 0x2a) return null
    return { width: buf.readUInt16LE(data + 6) & 0x3fff, height: buf.readUInt16LE(data + 8) & 0x3fff }
  }
  if (chunk === 'VP8L') {
    if (buf[data] !== 0x2f) return null
    const bits = buf.readUInt32LE(data + 1)
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8X') {
    return { width: buf.readUIntLE(data + 4, 3) + 1, height: buf.readUIntLE(data + 7, 3) + 1 }
  }
  return null
}

export function readImageDimensions(buf: Buffer, mimeType: InspectableImageType): ImageDimensions | null {
  try {
    const size = mimeType === 'image/png' ? png(buf) : mimeType === 'image/jpeg' ? jpeg(buf) : webp(buf)
    return size && size.width > 0 && size.height > 0 ? size : null
  } catch {
    return null // a read past the end of a truncated file
  }
}
