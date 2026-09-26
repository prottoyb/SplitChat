import { MAX_AMOUNT_CENTS, parseAmountToCents } from './money'

export const MAX_DESCRIPTION_LENGTH = 120
export const MAX_NOTES_LENGTH = 500

export type EqualSplitShare = { userId: string; shareCents: number }

export type EqualSplitError =
  | 'invalid_amount'
  | 'invalid_participants'
  | 'amount_too_small_to_split'

export type EqualSplitResult =
  | { ok: true; shares: EqualSplitShare[] }
  | { ok: false; error: EqualSplitError }

/**
 * The canonical equal split (ADR-0006), identical to the database's
 * private.equal_split_cents and tested against the same vectors
 * (fixtures/equal-split-vectors.json).
 *
 * Participant ids are lower-cased and de-duplicated, then sorted ascending.
 * The default sort compares UTF-16 code units, which for lowercase hex UUIDs
 * is the same order as PostgreSQL's bytewise uuid order. Each share is
 * floor(total / n) cents and the first total % n participants in that order
 * get one extra cent, so the result never depends on selection order.
 * Shares are returned in canonical order with lowercase ids.
 */
export function allocateEqualSplit(
  totalCents: number,
  participantIds: readonly string[],
): EqualSplitResult {
  if (
    !Number.isSafeInteger(totalCents) ||
    totalCents <= 0 ||
    totalCents > MAX_AMOUNT_CENTS
  ) {
    return { ok: false, error: 'invalid_amount' }
  }

  const ids = [
    ...new Set(participantIds.map((id) => id.toLowerCase())),
  ].sort()

  if (ids.length === 0 || ids.some((id) => id === '')) {
    return { ok: false, error: 'invalid_participants' }
  }

  if (totalCents < ids.length) {
    return { ok: false, error: 'amount_too_small_to_split' }
  }

  // Integer arithmetic only: the remainder is exact, and so is dividing the
  // remaining multiple of n.
  const remainder = totalCents % ids.length
  const baseCents = (totalCents - remainder) / ids.length

  return {
    ok: true,
    shares: ids.map((userId, index) => ({
      userId,
      shareCents: baseCents + (index < remainder ? 1 : 0),
    })),
  }
}

export type ExpenseFormInput = {
  description: string
  amount: string
  expenseDate: string
  paidBy: string
  participantIds: string[]
  notes: string
  memberIds: string[]
}

export type ValidExpense = {
  description: string
  amountCents: number
  expenseDate: string
  paidBy: string
  participantIds: string[]
  notes: string | null
}

export type ExpenseValidationResult =
  | { ok: true; value: ValidExpense }
  | { ok: false; error: string }

export function validateExpenseInput(
  input: ExpenseFormInput,
): ExpenseValidationResult {
  const fail = (error: string): ExpenseValidationResult => ({
    ok: false,
    error,
  })

  const description = input.description.trim()
  const notes = input.notes.trim()

  if (!description) {
    return fail('Please enter an expense description.')
  }

  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return fail(
      'Expense description cannot exceed 120 characters.',
    )
  }

  const amount = parseAmountToCents(input.amount)

  if (!amount.ok) {
    if (amount.reason === 'empty') {
      return fail('Please enter an amount.')
    }

    if (amount.reason === 'too-many-decimals') {
      return fail(
        'Expense amount can have at most 2 decimal places.',
      )
    }

    return fail('Expense amount must be greater than zero.')
  }

  if (amount.cents > MAX_AMOUNT_CENTS) {
    return fail('Expense amount cannot exceed $9,999,999,999.99.')
  }

  if (!input.expenseDate) {
    return fail('Please select the expense date.')
  }

  if (!input.paidBy) {
    return fail('Please select who paid.')
  }

  if (input.participantIds.length === 0) {
    return fail('Please select at least one participant.')
  }

  const memberIds = new Set(input.memberIds)

  if (!memberIds.has(input.paidBy)) {
    return fail('The selected payer is not a member of this group.')
  }

  if (
    new Set(input.participantIds).size !==
      input.participantIds.length ||
    input.participantIds.some((id) => !memberIds.has(id))
  ) {
    return fail(
      'All participants must be distinct members of this group.',
    )
  }

  if (amount.cents < input.participantIds.length) {
    return fail(
      'The amount is too small to split between the selected participants.',
    )
  }

  if (notes.length > MAX_NOTES_LENGTH) {
    return fail('Notes cannot exceed 500 characters.')
  }

  return {
    ok: true,
    value: {
      description,
      amountCents: amount.cents,
      expenseDate: input.expenseDate,
      paidBy: input.paidBy,
      participantIds: input.participantIds,
      notes: notes || null,
    },
  }
}
