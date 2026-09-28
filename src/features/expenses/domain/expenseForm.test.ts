import { describe, expect, it } from 'vitest'
import {
  validateExpenseForm,
  type ExpenseFormRules,
  type ExpenseFormValues,
} from './expenseForm'

const rules: ExpenseFormRules = {
  allowedPayerIds: new Set(['u1', 'u2', 'u3']),
  allowedParticipantIds: new Set(['u1', 'u2', 'u3']),
  today: '2026-09-27',
}

const valid: ExpenseFormValues = {
  description: '  Dinner  ',
  amount: '10.50',
  expenseDate: '2026-09-25',
  paidBy: 'u1',
  participantIds: ['u1', 'u2'],
  notes: '  shared pizza ',
}

const errorsFor = (overrides: Partial<ExpenseFormValues>, r: ExpenseFormRules = rules) => {
  const result = validateExpenseForm({ ...valid, ...overrides }, r)
  return result.ok ? {} : result.errors
}

describe('validateExpenseForm', () => {
  it('accepts valid input and returns trimmed values with integer cents', () => {
    expect(validateExpenseForm(valid, rules)).toEqual({
      ok: true,
      value: {
        description: 'Dinner',
        amountCents: 1050,
        expenseDate: '2026-09-25',
        paidBy: 'u1',
        participantIds: ['u1', 'u2'],
        notes: 'shared pizza',
      },
    })
  })

  it('turns blank notes into null', () => {
    const result = validateExpenseForm({ ...valid, notes: '   ' }, rules)
    expect(result.ok && result.value.notes).toBeNull()
  })

  it('reports every failing field at once', () => {
    expect(Object.keys(errorsFor({ description: '', amount: '', expenseDate: '', paidBy: '', participantIds: [] })).sort())
      .toEqual(['amount', 'description', 'expenseDate', 'paidBy', 'participants'])
  })

  it('checks the description', () => {
    expect(errorsFor({ description: '   ' }).description).toBe('Please enter an expense description.')
    expect(errorsFor({ description: 'a'.repeat(120) }).description).toBeUndefined()
    expect(errorsFor({ description: 'a'.repeat(121) }).description).toBe('Expense description cannot exceed 120 characters.')
  })

  it('checks the amount', () => {
    expect(errorsFor({ amount: '' }).amount).toBe('Please enter an amount.')
    expect(errorsFor({ amount: '10.505' }).amount).toBe('Expense amount can have at most 2 decimal places.')
    expect(errorsFor({ amount: '9999999999.99' }).amount).toBeUndefined()
    expect(errorsFor({ amount: '10000000000' }).amount).toBe('Expense amount cannot exceed $9,999,999,999.99.')
  })

  it.each(['0', '0.00', '-5', 'abc', '1e2', '1.2.3', '1,000'])('rejects %j as an amount', (amount) => {
    expect(errorsFor({ amount }).amount).toBe('Expense amount must be greater than zero.')
  })

  it('checks the date strictly', () => {
    expect(errorsFor({ expenseDate: '' }).expenseDate).toBe('Please select the expense date.')
    expect(errorsFor({ expenseDate: '2026-02-30' }).expenseDate).toBe('Please enter a valid date.')
    expect(errorsFor({ expenseDate: '1999-12-31' }).expenseDate).toMatch(/before 1 January 2000/)
    expect(errorsFor({ expenseDate: '2027-09-28' }).expenseDate).toMatch(/more than a year/)
    expect(errorsFor({ expenseDate: '2027-09-27' }).expenseDate).toBeUndefined()
  })

  it('checks the payer against the allowed payers', () => {
    expect(errorsFor({ paidBy: '' }).paidBy).toBe('Please select who paid.')
    expect(errorsFor({ paidBy: 'stranger' }).paidBy).toBe('The payer must be a current member of this group.')
  })

  it('checks participants: at least one, distinct, allowed', () => {
    expect(errorsFor({ participantIds: [] }).participants).toBe('Please select at least one participant.')
    expect(errorsFor({ participantIds: ['u1', 'u1'] }).participants).toBe('Participants must be distinct members of this group.')
    expect(errorsFor({ participantIds: ['u1', 'stranger'] }).participants).toBe('Participants must be distinct members of this group.')
  })

  it('rejects an amount too small to give every participant a cent', () => {
    expect(errorsFor({ amount: '0.01', participantIds: ['u1', 'u2'] }).amount).toBe(
      'The amount is too small to split between the selected participants.',
    )
    expect(errorsFor({ amount: '0.01', participantIds: ['u1'] })).toEqual({})
    expect(errorsFor({ amount: '0.02', participantIds: ['u1', 'u2'] })).toEqual({})
  })

  it('limits notes to 500 characters', () => {
    expect(errorsFor({ notes: 'n'.repeat(500) })).toEqual({})
    expect(errorsFor({ notes: 'n'.repeat(501) }).notes).toBe('Notes cannot exceed 500 characters.')
  })

  it('edit mode: keeps a former member already on the expense, never adds a new one', () => {
    const edit: ExpenseFormRules = {
      allowedPayerIds: new Set(['u1', 'u2', 'former']),
      allowedParticipantIds: new Set(['u1', 'u2', 'former']),
      today: '2026-09-27',
    }
    expect(errorsFor({ paidBy: 'former', participantIds: ['former', 'u1'] }, edit)).toEqual({})
    expect(errorsFor({ participantIds: ['u1', 'other-former'] }, edit).participants).toBeDefined()
  })
})
