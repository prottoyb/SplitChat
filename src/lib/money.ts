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

export function centsToAmount(cents: number) {
  return cents / 100
}

export function formatCurrency(amount: number) {
  return new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency: 'AUD',
  }).format(amount)
}
