import { describe, expect, it } from 'vitest'
import { allocateEqualSplit } from './expenseSplit'

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
