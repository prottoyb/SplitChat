import { checkExpenseDate, EXPENSE_DATE_MESSAGES } from '../../../shared/domain/dates'
import { formatCents, MAX_AMOUNT_CENTS, parseAmountToCents } from '../../../shared/domain/money'

export const MAX_NOTE_LENGTH = 200
export const MAX_REASON_LENGTH = 200

export type SettlementFormValues = {
  fromUserId: string
  toUserId: string
  amount: string
  settledOn: string
  note: string
}

export type SettlementInput = {
  fromUserId: string
  toUserId: string
  amountCents: number
  settledOn: string
  note: string | null
}

export type SettlementField = 'parties' | 'amount' | 'settledOn' | 'note'
export type SettlementErrors = Partial<Record<SettlementField, string>>

/** The most that can be paid from one person to another right now. */
export function maxPayableCents(netByUser: ReadonlyMap<string, number>, fromUserId: string, toUserId: string): number {
  const owes = -(netByUser.get(fromUserId) ?? 0)
  const owed = netByUser.get(toUserId) ?? 0
  return Math.max(0, Math.min(owes, owed))
}

const DATE_TEXT = {
  ...EXPENSE_DATE_MESSAGES,
  missing: 'Please select the payment date.',
  too_early: 'The payment date cannot be before 1 January 2000.',
  too_far_ahead: 'The payment date cannot be more than a year from today.',
}

/**
 * Client-side checks mirroring record_settlement (ADR-0010), for fast
 * feedback. The server is authoritative: it re-checks everything against
 * live balances.
 */
export function validateSettlementForm(
  values: SettlementFormValues,
  netByUser: ReadonlyMap<string, number>,
  today?: string,
): { ok: true; value: SettlementInput } | { ok: false; errors: SettlementErrors } {
  const errors: SettlementErrors = {}
  const max = maxPayableCents(netByUser, values.fromUserId, values.toUserId)

  if (!values.fromUserId || !values.toUserId || values.fromUserId === values.toUserId) {
    errors.parties = 'Choose who paid and who received the money.'
  } else if (max === 0) {
    errors.parties = 'There is nothing to settle between these two people.'
  }

  const amount = parseAmountToCents(values.amount)
  let amountCents = 0
  if (!amount.ok) {
    errors.amount =
      amount.reason === 'empty'
        ? 'Please enter the amount paid.'
        : amount.reason === 'too-many-decimals'
          ? 'Use at most two decimal places.'
          : 'Please enter an amount greater than zero.'
  } else if (amount.cents > MAX_AMOUNT_CENTS) {
    errors.amount = 'Please enter an amount between $0.01 and $9,999,999,999.99.'
  } else if (!errors.parties && amount.cents > max) {
    errors.amount = `That is more than is owed. The most that can be paid is ${formatCents(max)}.`
  } else {
    amountCents = amount.cents
  }

  const dateError = checkExpenseDate(values.settledOn, today)
  if (dateError) errors.settledOn = DATE_TEXT[dateError]

  const note = values.note.trim()
  if (note.length > MAX_NOTE_LENGTH) errors.note = `The note cannot exceed ${MAX_NOTE_LENGTH} characters.`

  if (Object.keys(errors).length > 0) return { ok: false, errors }
  return {
    ok: true,
    value: {
      fromUserId: values.fromUserId,
      toUserId: values.toUserId,
      amountCents,
      settledOn: values.settledOn.trim(),
      note: note || null,
    },
  }
}

export function validateVoidReason(reason: string): string | null {
  const text = reason.trim()
  if (!text) return 'Please say why this payment is being voided.'
  if (text.length > MAX_REASON_LENGTH) return `The reason cannot exceed ${MAX_REASON_LENGTH} characters.`
  return null
}
