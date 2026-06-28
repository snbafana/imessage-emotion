import { describe, expect, it } from 'vitest'

import { extractTextFromAttributedBody } from './attributed-body'

const nsString = Buffer.from('NSString')
const tag = 0x2b
const end = Buffer.from([0x86, 0x84])

function lengthPrefixed(text: string): Buffer {
  const textBytes = Buffer.from(text, 'utf-8')
  // Single-byte length marker (<0x80) followed by the UTF-8 bytes.
  return Buffer.concat([nsString, Buffer.from([tag, textBytes.length]), textBytes])
}

function endDelimited(text: string): Buffer {
  const textBytes = Buffer.from(text, 'utf-8')
  return Buffer.concat([nsString, Buffer.from([tag]), textBytes, end])
}

describe('extractTextFromAttributedBody', () => {
  it('returns null for null and empty buffers', () => {
    expect(extractTextFromAttributedBody(null)).toBeNull()
    expect(extractTextFromAttributedBody(Buffer.alloc(0))).toBeNull()
  })

  it('returns null when the NSString trigger is absent', () => {
    // Payload only, no NSString marker -> indexOf(nsString) === -1.
    const blob = Buffer.concat([Buffer.from([tag, 5]), Buffer.from('hello', 'utf-8')])
    expect(extractTextFromAttributedBody(blob)).toBeNull()
  })

  describe('positive cases', () => {
    const cases: Array<{ name: string; blob: Buffer; expected: string }> = [
      {
        name: 'length-prefixed string (1-byte length marker < 0x80)',
        blob: lengthPrefixed('hello world'),
        expected: 'hello world',
      },
      {
        name: 'end-delimited string terminated by 0x86 0x84',
        blob: endDelimited('hey there'),
        expected: 'hey there',
      },
      {
        name: 'attachment-only payload decodes to [attachment]',
        blob: lengthPrefixed('￼'),
        expected: '[attachment]',
      },
    ]

    for (const { name, blob, expected } of cases) {
      it(name, () => {
        expect(extractTextFromAttributedBody(blob)).toBe(expected)
      })
    }
  })

  describe('rejection cases', () => {
    it('rejects decoded text starting with NS', () => {
      expect(extractTextFromAttributedBody(lengthPrefixed('NSString'))).toBeNull()
    })

    it('rejects decoded text starting with _NS', () => {
      expect(extractTextFromAttributedBody(lengthPrefixed('_NSFoo'))).toBeNull()
    })

    it('returns null when a 0x82 (130) length value exceeds Number.MAX_SAFE_INTEGER', () => {
      // Marker 130 reads 4 little-endian bytes; 0xFFFFFFFF fits in 4 bytes but is
      // within MAX_SAFE_INTEGER, so use marker 131 (8 bytes) for an oversized value.
      // Per finding (f) we exercise the >MAX_SAFE_INTEGER guard via marker 131.
      const huge = Buffer.from([131, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
      const blob = Buffer.concat([nsString, Buffer.from([tag]), huge])
      expect(extractTextFromAttributedBody(blob)).toBeNull()
    })

    it('returns null when a length-prefixed textEnd exceeds blob length (truncated)', () => {
      // Length marker claims 50 bytes but only a few follow, and no end delimiter.
      const blob = Buffer.concat([nsString, Buffer.from([tag, 50]), Buffer.from('abc', 'utf-8')])
      expect(extractTextFromAttributedBody(blob)).toBeNull()
    })
  })
})
