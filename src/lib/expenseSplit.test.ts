import { describe, expect, it } from 'vitest'
import {
  calculateEqualSplit,
  validateExpenseInput,
  type ExpenseFormInput,
} from './expenseSplit'

const sum = (values: number[]) =>
  values.reduce((total, value) => total + value, 0)

describe('calculateEqualSplit', () => {
  it('splits $100 between 4 people into 2500 cents each', () => {
    expect(calculateEqualSplit(10000, 4)).toEqual([
      2500, 2500, 2500, 2500,
    ])
  })

  it('splits $10 between 3 people without losing a cent', () => {
    const shares = calculateEqualSplit(1000, 3)

    expect(shares).toEqual([334, 333, 333])
    expect(sum(shares)).toBe(1000)
  })

  it('gives the leftover cents to the first participants, one each', () => {
    expect(calculateEqualSplit(1002, 5)).toEqual([
      201, 201, 200, 200, 200,
    ])
    expect(calculateEqualSplit(7, 4)).toEqual([2, 2, 2, 1])
  })

  it('is deterministic', () => {
    expect(calculateEqualSplit(1000, 3)).toEqual(
      calculateEqualSplit(1000, 3),
    )
  })

  it('handles one cent for one participant', () => {
    expect(calculateEqualSplit(1, 1)).toEqual([1])
  })

  it('never creates or loses money for a range of totals and group sizes', () => {
    for (let total = 1; total <= 500; total += 7) {
      for (let people = 1; people <= 12; people += 1) {
        const shares = calculateEqualSplit(total, people)

        expect(shares).toHaveLength(people)
        expect(sum(shares)).toBe(total)
        expect(
          Math.max(...shares) - Math.min(...shares),
        ).toBeLessThanOrEqual(1)
      }
    }
  })

  it.each([
    [0, 3],
    [-100, 3],
    [1000, 0],
    [1000, -1],
    [10.5, 3],
    [1000, 2.5],
    [Number.NaN, 2],
  ])('returns no shares for total=%s participants=%s', (total, count) => {
    expect(calculateEqualSplit(total, count)).toEqual([])
  })
})

describe('validateExpenseInput', () => {
  const valid: ExpenseFormInput = {
    description: '  Dinner  ',
    amount: '10.50',
    expenseDate: '2026-09-25',
    paidBy: 'u1',
    participantIds: ['u1', 'u2'],
    notes: '  shared pizza ',
    memberIds: ['u1', 'u2', 'u3'],
  }

  const errorFor = (overrides: Partial<ExpenseFormInput>) => {
    const result = validateExpenseInput({ ...valid, ...overrides })

    return result.ok ? null : result.error
  }

  it('accepts valid input and returns trimmed values with integer cents', () => {
    expect(validateExpenseInput(valid)).toEqual({
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
    const result = validateExpenseInput({ ...valid, notes: '   ' })

    expect(result.ok && result.value.notes).toBeNull()
  })

  it('requires a description', () => {
    expect(errorFor({ description: '   ' })).toBe(
      'Please enter an expense description.',
    )
  })

  it('limits the description to 120 characters', () => {
    expect(errorFor({ description: 'a'.repeat(120) })).toBeNull()
    expect(errorFor({ description: 'a'.repeat(121) })).toBe(
      'Expense description cannot exceed 120 characters.',
    )
  })

  it('requires an amount', () => {
    expect(errorFor({ amount: '' })).toBe('Please enter an amount.')
  })

  it.each(['0', '0.00', '-5', 'abc', '1e2', '1.2.3'])(
    'rejects invalid or non-positive amount %j',
    (amount) => {
      expect(errorFor({ amount })).toBe(
        'Expense amount must be greater than zero.',
      )
    },
  )

  it('rejects more than two decimal places', () => {
    expect(errorFor({ amount: '10.505' })).toBe(
      'Expense amount can have at most 2 decimal places.',
    )
  })

  it('requires a date', () => {
    expect(errorFor({ expenseDate: '' })).toBe(
      'Please select the expense date.',
    )
  })

  it('requires a payer', () => {
    expect(errorFor({ paidBy: '' })).toBe('Please select who paid.')
  })

  it('requires at least one participant', () => {
    expect(errorFor({ participantIds: [] })).toBe(
      'Please select at least one participant.',
    )
  })

  it('rejects a payer who is not a group member', () => {
    expect(errorFor({ paidBy: 'stranger' })).toBe(
      'The selected payer is not a member of this group.',
    )
  })

  it('rejects participants who are not group members', () => {
    expect(errorFor({ participantIds: ['u1', 'stranger'] })).toBe(
      'All participants must be distinct members of this group.',
    )
  })

  it('rejects duplicate participants', () => {
    expect(errorFor({ participantIds: ['u1', 'u1'] })).toBe(
      'All participants must be distinct members of this group.',
    )
  })

  it('rejects everything when the group has no known members', () => {
    expect(errorFor({ memberIds: [] })).toBe(
      'The selected payer is not a member of this group.',
    )
  })

  it('rejects an amount too small to give every participant a cent', () => {
    expect(
      errorFor({ amount: '0.01', participantIds: ['u1', 'u2'] }),
    ).toBe(
      'The amount is too small to split between the selected participants.',
    )
    expect(
      errorFor({ amount: '0.01', participantIds: ['u1'] }),
    ).toBeNull()
    expect(
      errorFor({ amount: '0.02', participantIds: ['u1', 'u2'] }),
    ).toBeNull()
  })

  it('limits notes to 500 characters', () => {
    expect(errorFor({ notes: 'n'.repeat(500) })).toBeNull()
    expect(errorFor({ notes: 'n'.repeat(501) })).toBe(
      'Notes cannot exceed 500 characters.',
    )
  })
})
