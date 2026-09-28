import { describe, expect, it } from 'vitest'
import type { Draft, InterpretContext, Interpretation, Issue } from './interpreter'
import { validateDraft } from './validateDraft'

const ctx: InterpretContext = {
  senderId: 'p',
  messageDate: '2026-09-28',
  members: [{ id: 'p', name: 'Priya' }, { id: 's', name: 'Sam' }],
}
const from = (draft: Partial<Extract<Interpretation, { kind: 'candidate' }>['draft']>): Interpretation => ({
  kind: 'candidate',
  source: 'natural',
  interpreterVersion: 'test',
  issues: [],
  draft: { description: 'Lunch', amountCents: 2000, expenseDate: '2026-09-28', paidBy: 'p', participantIds: ['p', 's'], ...draft },
})

describe('validateDraft (any interpreter, e.g. a future LLM)', () => {
  it('passes a valid draft through unchanged', () => {
    expect(validateDraft(from({}), ctx)).toEqual(from({}))
  })

  it.each([
    ['a non-member payer', { paidBy: 'mallory' }, 'paidBy', 'payer'],
    ['a non-member participant', { participantIds: ['p', 'mallory'] }, 'participantIds', 'participants'],
    ['duplicate participants', { participantIds: ['p', 'p'] }, 'participantIds', 'participants'],
    ['a fractional amount', { amountCents: 10.5 }, 'amountCents', 'amount'],
    ['a negative amount', { amountCents: -100 }, 'amountCents', 'amount'],
    ['an amount over the limit', { amountCents: 1e15 }, 'amountCents', 'amount'],
    ['an impossible date', { expenseDate: '2026-02-30' }, 'expenseDate', 'date'],
    ['a date far ahead', { expenseDate: '2030-01-01' }, 'expenseDate', 'date'],
    ['an over-long description', { description: 'x'.repeat(121) }, 'description', 'description'],
    ['a blank description', { description: '   ' }, 'description', 'description'],
  ] satisfies [string, Partial<Draft>, keyof Draft, Issue['field']][])('turns %s into a missing field with an issue', (_label, draft, key, field) => {
    const r = validateDraft(from(draft), ctx)
    if (r.kind !== 'candidate') throw new Error('expected a candidate')
    expect(r.draft[key]).toBeNull()
    expect(r.issues.some((i) => i.field === field)).toBe(true)
  })

  it('leaves "none" alone', () => {
    expect(validateDraft({ kind: 'none' }, ctx)).toEqual({ kind: 'none' })
  })
})
