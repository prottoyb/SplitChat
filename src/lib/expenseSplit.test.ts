import { describe, expect, it } from 'vitest'
import {
  allocateEqualSplit,
  validateExpenseInput,
  type ExpenseFormInput,
} from './expenseSplit'

const id = (n: number) =>
  `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const ids = (count: number) =>
  Array.from({ length: count }, (_, index) => id(index + 1))

const sharesOf = (totalCents: number, participantIds: string[]) => {
  const result = allocateEqualSplit(totalCents, participantIds)

  if (!result.ok) {
    throw new Error(result.error)
  }

  return result.shares
}

// Shared-vector coverage lives in expenseSplit.vectors.test.ts; these are
// properties over many totals and group sizes.
describe('allocateEqualSplit', () => {
  it('never creates or loses a cent and differs by at most one cent', () => {
    for (let total = 1; total <= 500; total += 7) {
      for (let people = 1; people <= Math.min(12, total); people += 1) {
        const cents = sharesOf(total, ids(people)).map(
          (share) => share.shareCents,
        )

        expect(cents).toHaveLength(people)
        expect(cents.reduce((a, b) => a + b, 0)).toBe(total)
        expect(Math.max(...cents) - Math.min(...cents)).toBeLessThanOrEqual(1)
      }
    }
  })

  it('does not depend on the order participants were selected in', () => {
    const forward = ids(5)
    const reversed = [...forward].reverse()
    const shuffled = [forward[2], forward[4], forward[0], forward[3], forward[1]]

    for (const total of [1002, 7, 99, 100001]) {
      expect(sharesOf(total, reversed)).toEqual(sharesOf(total, forward))
      expect(sharesOf(total, shuffled)).toEqual(sharesOf(total, forward))
    }
  })

  it('gives the extra cents to the canonically first ids', () => {
    expect(sharesOf(7, [id(3), id(1), id(2)])).toEqual([
      { userId: id(1), shareCents: 3 },
      { userId: id(2), shareCents: 2 },
      { userId: id(3), shareCents: 2 },
    ])
  })

  it.each([
    [0, 'invalid_amount'],
    [-1, 'invalid_amount'],
    [10.5, 'invalid_amount'],
    [Number.NaN, 'invalid_amount'],
    [Number.MAX_SAFE_INTEGER, 'invalid_amount'],
    [1_000_000_000_000, 'invalid_amount'],
  ])('rejects total %s with %s', (total, error) => {
    expect(allocateEqualSplit(total, ids(2))).toEqual({ ok: false, error })
  })

  it('rejects no participants and empty ids', () => {
    expect(allocateEqualSplit(100, [])).toEqual({
      ok: false,
      error: 'invalid_participants',
    })
    expect(allocateEqualSplit(100, [id(1), ''])).toEqual({
      ok: false,
      error: 'invalid_participants',
    })
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

  it('limits the amount to what the database can store', () => {
    expect(errorFor({ amount: '9999999999.99' })).toBeNull()
    expect(errorFor({ amount: '10000000000' })).toBe(
      'Expense amount cannot exceed $9,999,999,999.99.',
    )
  })

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
