import { parseAmountToCents } from './money'

export const MAX_DESCRIPTION_LENGTH = 120
export const MAX_NOTES_LENGTH = 500

/**
 * Splits a total across `participantCount` people. Every share is an integer
 * number of cents, the shares always sum to `totalCents`, and any leftover
 * cents go one each to the first participants in order.
 */
export function calculateEqualSplit(
  totalCents: number,
  participantCount: number,
): number[] {
  if (
    !Number.isInteger(totalCents) ||
    totalCents <= 0 ||
    !Number.isInteger(participantCount) ||
    participantCount <= 0
  ) {
    return []
  }

  const baseCents = Math.floor(totalCents / participantCount)
  const remainder = totalCents % participantCount

  return Array.from(
    { length: participantCount },
    (_, index) => baseCents + (index < remainder ? 1 : 0),
  )
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
