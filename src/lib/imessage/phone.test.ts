import { describe, expect, it } from 'vitest'

import { normalizePhone, toE164 } from './phone'

describe('normalizePhone', () => {
  it('strips the leading 1 from 11-digit NANP numbers', () => {
    expect(normalizePhone('14155550123')).toBe('4155550123')
  })

  it('strips formatting and the leading country code', () => {
    expect(normalizePhone('+1 415 555 0123')).toBe('4155550123')
  })

  it('returns an empty string for an empty input', () => {
    expect(normalizePhone('')).toBe('')
  })

  it('returns an empty string for whitespace-only input', () => {
    expect(normalizePhone('   ')).toBe('')
  })
})

describe('toE164', () => {
  it('formats a NANP number with formatting into E.164', () => {
    expect(toE164('+1 415 555 0123')).toBe('+14155550123')
  })

  it('prefixes a bare 10-digit number with +1', () => {
    expect(toE164('4155550123')).toBe('+14155550123')
  })

  it('preserves an existing + prefix as-is', () => {
    expect(toE164('+447911123456')).toBe('+447911123456')
  })

  it('prefixes a non-NANP all-digit number with +', () => {
    expect(toE164('33123456789')).toBe('+33123456789')
  })

  it('returns null for an empty input', () => {
    expect(toE164('')).toBeNull()
  })

  it('returns null for non-numeric input', () => {
    expect(toE164('abc')).toBeNull()
  })
})
