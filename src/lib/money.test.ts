import { describe, expect, it } from 'vitest'
import {
  centsToAmount,
  formatCurrency,
  parseAmountToCents,
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

describe('centsToAmount', () => {
  it('converts cents to the decimal amount sent to the database', () => {
    expect(centsToAmount(1050)).toBe(10.5)
    expect(centsToAmount(1)).toBe(0.01)
    expect(centsToAmount(115)).toBe(1.15)
  })

  it('matches Number() of the original decimal text', () => {
    for (const text of ['10.5', '0.07', '1.15', '19.99', '8.2']) {
      const parsed = parseAmountToCents(text)

      expect(parsed.ok && centsToAmount(parsed.cents)).toBe(
        Number(text),
      )
    }
  })
})

describe('formatCurrency', () => {
  it('formats amounts as Australian dollars', () => {
    expect(formatCurrency(1234.5)).toBe('$1,234.50')
    expect(formatCurrency(0)).toBe('$0.00')
  })
})
