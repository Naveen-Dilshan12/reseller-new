import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectFileType } from '../src/modules/storage/private-storage'

describe('File Type Detection (Magic Bytes)', () => {
  it('should detect JPEG image by SOI marker FF D8 FF', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
    const res = detectFileType(jpeg)
    assert.deepEqual(res, { mimeType: 'image/jpeg', extension: 'jpg' })
  })

  it('should detect PNG image by 8-byte signature', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
    const res = detectFileType(png)
    assert.deepEqual(res, { mimeType: 'image/png', extension: 'png' })
  })

  it('should detect PDF file by %PDF- magic bytes', () => {
    const pdf = Buffer.from('%PDF-1.4 header content...')
    const res = detectFileType(pdf)
    assert.deepEqual(res, { mimeType: 'application/pdf', extension: 'pdf' })
  })

  it('should detect WebP image by RIFF...WEBP header', () => {
    const webp = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.alloc(4), // size
      Buffer.from('WEBP'),
    ])
    const res = detectFileType(webp)
    assert.deepEqual(res, { mimeType: 'image/webp', extension: 'webp' })
  })

  it('should reject invalid or executable files (e.g. Windows EXE MZ header, HTML, JS)', () => {
    const exe = Buffer.from('MZ\x90\x00\x03\x00')
    assert.equal(detectFileType(exe), null)

    const html = Buffer.from('<html><head></head><body>evil</body></html>')
    assert.equal(detectFileType(html), null)

    const js = Buffer.from('alert("pwned")')
    assert.equal(detectFileType(js), null)

    const empty = Buffer.alloc(0)
    assert.equal(detectFileType(empty), null)
  })
})
