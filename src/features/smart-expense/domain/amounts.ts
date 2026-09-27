import { MAX_AMOUNT_CENTS, parseAmountToCents } from '../../../shared/domain/money'
import { bare } from './text'

// Amounts (rule A): the shared cents parser does the arithmetic (no floats).

const AMOUNT = /^(a\$|\$|aud)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(aud)?$/i
const FOREIGN_MARK = /^(us\$|nz\$)|[€£¥]/i
const FOREIGN_WORDS = new Set(['usd', 'nzd', 'eur', 'gbp', 'euro', 'euros', 'pound', 'pounds'])
const NUMERIC_LOOKING = /^[-−]?(?:a\$|\$|aud)?\.?\d/i

export type AmountToken =
  | { kind: 'amount'; cents: number; marked: boolean }
  | { kind: 'invalid' }
  | { kind: 'unsupported' }

export function readAmount(token: string, next: string | undefined): AmountToken | null {
  const t = token.replace(/^\(+/, '').replace(/[).,;:!?]+$/, '')
  if (!/\d/.test(t)) return null
  const nextWord = next ? bare(next) : ''
  if (FOREIGN_MARK.test(t) || FOREIGN_WORDS.has(nextWord)) return { kind: 'unsupported' }
  if (/^[-−]/.test(t)) return { kind: 'invalid' }
  const m = AMOUNT.exec(t)
  if (!m) return NUMERIC_LOOKING.test(t) ? { kind: 'invalid' } : null
  const whole = m[2].replace(/,/g, '').replace(/^0+(?=\d)/, '')
  if (whole.length > 10) return { kind: 'invalid' }
  // The shared parser (integer cents, no floats) does the arithmetic.
  const parsed = parseAmountToCents(m[3] ? `${whole}.${m[3]}` : whole)
  if (!parsed.ok || parsed.cents > MAX_AMOUNT_CENTS) return { kind: 'invalid' }
  return { kind: 'amount', cents: parsed.cents, marked: Boolean(m[1] || m[4] || nextWord === 'aud') }
}
