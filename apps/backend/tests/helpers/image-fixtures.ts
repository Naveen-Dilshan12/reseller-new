/**
 * Smallest byte sequences that carry the real headers of a PNG, JPEG or WEBP of a given pixel size. They are not
 * viewable pictures; they exist so tests can exercise content-based type detection and header-based size checks.
 * `tail` is appended after the image data so two fixtures of the same size can be told apart.
 */

export function pngImage(width: number, height: number, tail: Buffer = Buffer.alloc(0)): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4, 'ascii')
  ihdr.writeUInt32BE(width, 8)
  ihdr.writeUInt32BE(height, 12)
  ihdr[16] = 8 // bit depth
  ihdr[17] = 2 // colour type
  const iend = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])
  return Buffer.concat([signature, ihdr, iend, tail])
}

export function jpegImage(width: number, height: number, tail: Buffer = Buffer.alloc(0)): Buffer {
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0', 'latin1'), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0])])
  const frame = Buffer.alloc(19)
  frame[0] = 0xff
  frame[1] = 0xc0 // baseline frame header
  frame.writeUInt16BE(17, 2)
  frame[4] = 8
  frame.writeUInt16BE(height, 5)
  frame.writeUInt16BE(width, 7)
  frame[9] = 3
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, frame, Buffer.from([0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]), tail])
}

/** Extended (VP8X) WEBP header. */
export function webpImage(width: number, height: number, tail: Buffer = Buffer.alloc(0)): Buffer {
  const b = Buffer.alloc(30)
  b.write('RIFF', 0, 'ascii')
  b.writeUInt32LE(22 + tail.length, 4)
  b.write('WEBP', 8, 'ascii')
  b.write('VP8X', 12, 'ascii')
  b.writeUInt32LE(10, 16)
  b.writeUIntLE(width - 1, 24, 3)
  b.writeUIntLE(height - 1, 27, 3)
  return Buffer.concat([b, tail])
}

/** Lossy (VP8) WEBP header. */
export function webpLossyImage(width: number, height: number): Buffer {
  const b = Buffer.alloc(40)
  b.write('RIFF', 0, 'ascii')
  b.writeUInt32LE(32, 4)
  b.write('WEBP', 8, 'ascii')
  b.write('VP8 ', 12, 'ascii')
  b.writeUInt32LE(20, 16)
  b[23] = 0x9d
  b[24] = 0x01
  b[25] = 0x2a
  b.writeUInt16LE(width, 26)
  b.writeUInt16LE(height, 28)
  return b
}

/** Lossless (VP8L) WEBP header. */
export function webpLosslessImage(width: number, height: number): Buffer {
  const b = Buffer.alloc(40)
  b.write('RIFF', 0, 'ascii')
  b.writeUInt32LE(32, 4)
  b.write('WEBP', 8, 'ascii')
  b.write('VP8L', 12, 'ascii')
  b.writeUInt32LE(20, 16)
  b[20] = 0x2f
  b.writeUInt32LE(((height - 1) << 14) | (width - 1), 21)
  return b
}
