import { describe, expect, it } from 'vitest'
import {
  formatCents,
  parseAmountToCents,
  readCents,
} from './money'

describe('parseAmountToCents', () => {
  it.each([
    ['10', 1000],
    ['10.5', 1050],
    ['10.50', 1050],
    ['0.01', 1],
    ['0.1', 10],
    ['.5', 50],
    ['5.', 500],
    ['  12.34  ', 1234],
    ['1.15', 115],
    ['19.99', 1999],
    ['0001.20', 120],
    ['1234567.89', 123456789],
  ])('converts %j to %i cents', (input, cents) => {
    expect(parseAmountToCents(input)).toEqual({ ok: true, cents })
  })

  it('is exact for values that binary floating point cannot represent', () => {
    // 1.15 * 100 === 114.99999999999999 in floating point.
    expect(parseAmountToCents('1.15')).toEqual({ ok: true, cents: 115 })
    expect(parseAmountToCents('8.2')).toEqual({ ok: true, cents: 820 })
  })

  it.each(['', '   '])('reports empty input %j', (input) => {
    expect(parseAmountToCents(input)).toEqual({
      ok: false,
      reason: 'empty',
    })
  })

  it.each(['0', '0.00', '000', '.0', '0.000'])(
    'rejects zero amount %j',
    (input) => {
      expect(parseAmountToCents(input)).toEqual({
        ok: false,
        reason: 'not-positive',
      })
    },
  )

  it.each([
    '-1',
    '-0.01',
    'abc',
    '1.2.3',
    '1,000',
    '1e2',
    '1.5e1',
    '0x10',
    'Infinity',
    'NaN',
    '.',
    '$5',
    '5 0',
  ])('rejects malformed or non-positive input %j', (input) => {
    expect(parseAmountToCents(input)).toEqual({
      ok: false,
      reason: 'not-positive',
    })
  })

  it.each(['1.234', '0.001', '10.505', '5.000001'])(
    'rejects more than two decimal places in %j',
    (input) => {
      expect(parseAmountToCents(input)).toEqual({
        ok: false,
        reason: 'too-many-decimals',
      })
    },
  )

  it('rejects amounts that cannot be represented as safe integer cents', () => {
    expect(parseAmountToCents('99999999999999999999')).toEqual({
      ok: false,
      reason: 'not-positive',
    })
  })
})

describe('formatCents', () => {
  it.each([
    [123450, '$1,234.50'],
    [0, '$0.00'],
    [1, '$0.01'],
    [115, '$1.15'],
    [-2505, '-$25.05'],
    [999_999_999_999, '$9,999,999,999.99'],
    [Number.MAX_SAFE_INTEGER, '$90,071,992,547,409.91'],
  ])('formats %i cents as %s', (cents, text) => {
    expect(formatCents(cents)).toBe(text)
  })

  it('refuses values that are not safe integer cents', () => {
    expect(() => formatCents(10.5)).toThrow(RangeError)
    expect(() => formatCents(Number.NaN)).toThrow(RangeError)
  })
})

describe('readCents', () => {
  it.each([
    [1050, 1050],
    ['1050', 1050],
    ['-3', -3],
    [0, 0],
  ])('reads %j as %i', (value, cents) => {
    expect(readCents(value)).toBe(cents)
  })

  it.each([null, undefined, 10.5, '10.50', '', 'abc', Number.NaN, 2 ** 60, '1234567890123456'])(
    'rejects %j',
    (value) => {
      expect(readCents(value)).toBeNull()
    },
  )
})
