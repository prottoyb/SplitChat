import { checkExpenseDate, EXPENSE_DATE_MESSAGES, localIsoDate } from '../../../shared/domain/dates'
import { formatCents, MAX_AMOUNT_CENTS, parseAmountToCents } from '../../../shared/domain/money'

export const MAX_DESCRIPTION_LENGTH = 120
export const MAX_NOTES_LENGTH = 500

/** What the server's expense RPCs take (integer cents, ISO calendar date). */
export type ExpenseInput = {
  description: string
  amountCents: number
  expenseDate: string
  paidBy: string
  participantIds: string[]
  notes: string | null
}

/** Raw form state (the amount is the text the user typed). */
export type ExpenseFormValues = {
  description: string
  amount: string
  expenseDate: string
  paidBy: string
  participantIds: string[]
  notes: string
}

/**
 * Who may be chosen. Create: current members. Edit: current members plus the
 * expense's existing payer / participants (the server allows keeping former
 * members on an expense, but never adding them).
 */
export type ExpenseFormRules = {
  allowedPayerIds: ReadonlySet<string>
  allowedParticipantIds: ReadonlySet<string>
  today?: string
}

export type ExpenseField = 'description' | 'amount' | 'expenseDate' | 'paidBy' | 'participants' | 'notes'
export type FieldErrors = Partial<Record<ExpenseField, string>>

export type ExpenseFormResult = { ok: true; value: ExpenseInput } | { ok: false; errors: FieldErrors }

/**
 * Validates the form with the same rules the database RPCs enforce (the
 * server remains the authority) plus the client date range. Every failing
 * field gets its own message.
 */
export function validateExpenseForm(values: ExpenseFormValues, rules: ExpenseFormRules): ExpenseFormResult {
  const errors: FieldErrors = {}

  const description = values.description.trim()
  if (!description) errors.description = 'Please enter an expense description.'
  else if (description.length > MAX_DESCRIPTION_LENGTH) {
    errors.description = `Expense description cannot exceed ${MAX_DESCRIPTION_LENGTH} characters.`
  }

  const amount = parseAmountToCents(values.amount)
  let amountCents = 0
  if (!amount.ok) {
    errors.amount =
      amount.reason === 'empty'
        ? 'Please enter an amount.'
        : amount.reason === 'too-many-decimals'
          ? 'Expense amount can have at most 2 decimal places.'
          : 'Expense amount must be greater than zero.'
  } else if (amount.cents > MAX_AMOUNT_CENTS) {
    errors.amount = `Expense amount cannot exceed ${formatCents(MAX_AMOUNT_CENTS)}.`
  } else {
    amountCents = amount.cents
  }

  const dateError = checkExpenseDate(values.expenseDate, rules.today ?? localIsoDate())
  if (dateError) errors.expenseDate = EXPENSE_DATE_MESSAGES[dateError]

  if (!values.paidBy) errors.paidBy = 'Please select who paid.'
  else if (!rules.allowedPayerIds.has(values.paidBy)) errors.paidBy = 'The payer must be a current member of this group.'

  const participants = values.participantIds
  if (participants.length === 0) errors.participants = 'Please select at least one participant.'
  else if (new Set(participants).size !== participants.length || participants.some((id) => !rules.allowedParticipantIds.has(id))) {
    errors.participants = 'Participants must be distinct members of this group.'
  } else if (amountCents > 0 && amountCents < participants.length) {
    errors.amount = 'The amount is too small to split between the selected participants.'
  }

  const notes = values.notes.trim()
  if (notes.length > MAX_NOTES_LENGTH) errors.notes = `Notes cannot exceed ${MAX_NOTES_LENGTH} characters.`

  if (Object.keys(errors).length > 0) return { ok: false, errors }
  return {
    ok: true,
    value: {
      description,
      amountCents,
      expenseDate: values.expenseDate.trim(),
      paidBy: values.paidBy,
      participantIds: [...participants],
      notes: notes || null,
    },
  }
}
