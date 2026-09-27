import { describe, expect, it } from 'vitest'
import {
  addDays,
  checkExpenseDate,
  formatDateLong,
  formatDateShort,
  isIsoDate,
  localIsoDate,
} from './dates'

describe('isIsoDate', () => {
  it.each(['2026-09-27', '2000-01-01', '2024-02-29', '2026-12-31'])('accepts %s', (v) => {
    expect(isIsoDate(v)).toBe(true)
  })

  it.each([
    '', '2026-9-27', '26-09-27', '2026/09/27', '2026-13-01', '2026-00-10', '2026-02-29',
    '2025-02-29', '2026-04-31', '2026-09-00', '2026-09-27T00:00', ' 2026-09-27', 'abcd-ef-gh',
  ])('rejects %j', (v) => {
    expect(isIsoDate(v)).toBe(false)
  })
})

describe('localIsoDate / addDays', () => {
  it('uses the local calendar date', () => {
    expect(localIsoDate(new Date(2026, 8, 7, 23, 59))).toBe('2026-09-07')
  })

  it('adds calendar days across month, year and leap boundaries', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29')
    expect(addDays('2026-09-27', 365)).toBe('2027-09-27')
  })
})

describe('checkExpenseDate', () => {
  const today = '2026-09-27'

  it('accepts today, the past back to 2000 and up to a year ahead', () => {
    for (const v of ['2026-09-27', '2000-01-01', '2026-01-15', '2027-09-27']) {
      expect(checkExpenseDate(v, today)).toBeNull()
    }
  })

  it.each([
    ['', 'missing'],
    ['   ', 'missing'],
    ['2026-02-30', 'invalid'],
    ['27/09/2026', 'invalid'],
    ['1999-12-31', 'too_early'],
    ['2027-09-28', 'too_far_ahead'],
  ])('%j -> %s', (v, error) => {
    expect(checkExpenseDate(v, today)).toBe(error)
  })
})

describe('formatting', () => {
  it('formats the stored calendar day regardless of time zone', () => {
    expect(formatDateLong('2026-09-01')).toBe('1 September 2026')
    expect(formatDateShort('2026-01-05')).toMatch(/^5 Jan\.? 2026$/)
  })

  it('returns malformed input unchanged instead of a wrong date', () => {
    expect(formatDateLong('not-a-date')).toBe('not-a-date')
  })
})
