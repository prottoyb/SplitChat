export type ParseAmountResult =
  | { ok: true; cents: number }
  | {
      ok: false
      reason: 'empty' | 'not-positive' | 'too-many-decimals'
    }

const AMOUNT_PATTERN = /^(\d+\.?\d*|\.\d+)$/

/**
 * Converts user-entered decimal text into integer cents without any
 * floating-point arithmetic. Only plain decimals are accepted, so forms such
 * as "1e2", "0x10", "-5", "1,000" and "Infinity" are rejected.
 */
export function parseAmountToCents(
  input: string,
): ParseAmountResult {
  const text = input.trim()

  if (!text) {
    return { ok: false, reason: 'empty' }
  }

  if (!AMOUNT_PATTERN.test(text)) {
    return { ok: false, reason: 'not-positive' }
  }

  const [wholePart, fractionPart = ''] = text.split('.')

  if (/^0*$/.test(wholePart + fractionPart)) {
    return { ok: false, reason: 'not-positive' }
  }

  if (fractionPart.length > 2) {
    return { ok: false, reason: 'too-many-decimals' }
  }

  const cents =
    Number(wholePart || '0') * 100 +
    Number(fractionPart.padEnd(2, '0'))

  if (!Number.isSafeInteger(cents)) {
    return { ok: false, reason: 'not-positive' }
  }

  return { ok: true, cents }
}

/** Largest amount the database accepts: numeric(12,2), in cents. */
export const MAX_AMOUNT_CENTS = 999_999_999_999

const AUD = new Intl.NumberFormat('en-AU', {
  style: 'currency',
  currency: 'AUD',
})

/**
 * Formats integer cents as Australian dollars. The dollars and cents are
 * split with integer arithmetic and handed to Intl as a decimal string, so no
 * floating-point value ever stands in for money.
 */
export function formatCents(cents: number): string {
  if (!Number.isSafeInteger(cents)) {
    throw new RangeError('formatCents expects a safe integer number of cents')
  }

  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const remainder = abs % 100
  const dollars = (abs - remainder) / 100
  const decimal = `${sign}${dollars}.${String(remainder).padStart(2, '0')}`

  return AUD.format(decimal as Intl.StringNumericLiteral)
}

/**
 * Reads a cents value (a PostgREST bigint column) from an API row. Returns
 * null for anything that is not a safe integer, so callers can treat the row
 * as an unexpected response instead of displaying a wrong amount.
 */
export function readCents(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value : null
  }

  if (typeof value === 'string' && /^-?\d{1,15}$/.test(value)) {
    return Number(value)
  }

  return null
}
