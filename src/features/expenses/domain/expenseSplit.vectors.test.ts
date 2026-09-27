import { describe, expect, it } from 'vitest'
import { allocateEqualSplit } from './expenseSplit'
import vectorsFile from './fixtures/equal-split-vectors.json'

type Vector = {
  name: string
  totalCents: number
  participantIds: string[]
  expected?: { userId: string; shareCents: number }[]
  error?: string
}

// The same file drives the database harness (tests/db/cases/180), so the
// frontend preview and the stored split follow one rule (ADR-0006).
const vectors: Vector[] = vectorsFile.vectors

describe('canonical equal-split vectors', () => {
  it('has vectors covering results and errors', () => {
    expect(vectors.some((vector) => vector.expected)).toBe(true)
    expect(vectors.some((vector) => vector.error)).toBe(true)
  })

  it.each(vectors.map((vector) => [vector.name, vector] as const))(
    '%s',
    (_name, vector) => {
      const result = allocateEqualSplit(
        vector.totalCents,
        vector.participantIds,
      )

      if (vector.error) {
        expect(result).toEqual({ ok: false, error: vector.error })
      } else {
        expect(result).toEqual({ ok: true, shares: vector.expected })
      }
    },
  )
})
