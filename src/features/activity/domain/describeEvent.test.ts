import { describe, expect, it } from 'vitest'
import type { ActivityEvent, EventKind } from '../api/events'
import { describeEvent, eventSentence } from './describeEvent'

const ctx = {
  currentUserId: 'me',
  names: new Map([['bob', 'Bob'], ['eve', 'Deleted user'], ['cara', 'Cara']]),
  expenseTitles: new Map([['x1', 'Dinner']]),
}

const ev = (kind: EventKind, fields: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id: 1, groupId: 'g1', kind, actorId: 'bob', subjectId: null, subjectUserId: null, people: [],
  payload: { v: 1 }, backfilled: false, createdAt: '2026-09-27T10:00:00Z', ...fields,
})
const say = (e: ActivityEvent) => eventSentence(describeEvent(e, ctx))

describe('describeEvent', () => {
  it('describes expenses with titles, amounts and links', () => {
    const d = describeEvent(ev('expense_created', { subjectId: 'x1', payload: { v: 1, amount_cents: 1001 } }), ctx)
    expect(eventSentence(d)).toBe('Bob added “Dinner” $10.01')
    expect(d.target?.to).toBe('/expenses/x1')
  })

  it('reads an expense created from a Smart Expense proposal like any other (ADR-0012 provenance keys)', () => {
    const d = describeEvent(ev('expense_created', {
      subjectId: 'x1',
      payload: { v: 1, amount_cents: 1001, candidate_id: 'c1', message_id: 42, proposed_by: 'cara' },
    }), ctx)
    expect(eventSentence(d)).toBe('Bob added “Dinner” $10.01')
  })

  it('describes settlements as payments between people, linking to balances', () => {
    const paid = describeEvent(ev('settlement_recorded', { actorId: 'bob', payload: { v: 1, amount_cents: 2500, from_user: 'bob', to_user: 'me' } }), ctx)
    expect(eventSentence(paid)).toBe('Bob paid you $25.00')
    expect(paid.target?.to).toBe('/groups/g1/balances')
    expect(paid.category).toBe('settlement')
    expect(say(ev('settlement_recorded', { actorId: 'me', payload: { v: 1, amount_cents: 1, from_user: 'bob', to_user: 'cara' } })))
      .toBe('Bob paid Cara $0.01 (recorded by You)')
    expect(say(ev('settlement_voided', { actorId: 'cara', payload: { v: 1, amount_cents: 2500, from_user: 'me', to_user: 'bob' } })))
      .toBe('Cara voided a payment from You to Bob $25.00')
  })

  it('degrades a malformed settlement payload without throwing', () => {
    expect(say(ev('settlement_recorded', { actorId: null, payload: { v: 1, amount_cents: 'x', from_user: 7 } }))).toBe('Someone paid Someone')
  })

  it('says "You" for the current user', () => {
    expect(say(ev('expense_created', { actorId: 'me', subjectId: 'x1', payload: { v: 1, amount_cents: 5 } }))).toBe('You added “Dinner” $0.05')
    expect(say(ev('member_added', { subjectUserId: 'me' }))).toBe('Bob added you')
  })

  it('summarises exactly what an edit changed, never the text', () => {
    const e = ev('expense_updated', {
      subjectId: 'x1',
      payload: {
        v: 1,
        changes: {
          amount_cents: { from: 1001, to: 1500 },
          paid_by: { from: 'bob', to: 'me' },
          participants: { from: ['bob'], to: ['bob', 'me'] },
        },
        description_changed: true,
        notes_changed: false,
      },
    })
    expect(say(e)).toBe('Bob edited “Dinner” amount $10.01 → $15.00 · paid by Bob → You · participants changed · description changed')
  })

  it('describes a deleted expense by amount and date only, with no link', () => {
    const d = describeEvent(ev('expense_deleted', { subjectId: 'gone', payload: { v: 1, amount_cents: 8450, expense_date: '2026-09-25' } }), ctx)
    expect(eventSentence(d)).toMatch(/^Bob deleted an expense \$84\.50 from 25 Sept?\.? 2026$/)
    expect(d.target).toBeNull()
  })

  it('handles an expense that no longer exists', () => {
    const d = describeEvent(ev('expense_created', { subjectId: 'gone', payload: { v: 1, amount_cents: 100 } }), ctx)
    expect(d.target).toEqual({ label: 'an expense that was later deleted', to: null })
  })

  it.each([
    ['group_created', {}, 'Bob created the group'],
    ['member_rejoined', { subjectUserId: 'cara' }, 'Bob re-added Cara'],
    ['member_left', { subjectUserId: 'cara', actorId: 'cara' }, 'Cara left the group'],
    ['member_removed', { subjectUserId: 'cara' }, 'Bob removed Cara'],
    ['member_account_deleted', { actorId: null, subjectUserId: 'eve' }, 'Deleted user left the group (account deleted)'],
    ['ownership_transferred', { subjectUserId: 'cara', payload: { v: 1, from: 'bob', to: 'cara' } }, 'Bob made Cara the owner'],
    ['ownership_transferred', { actorId: null, subjectUserId: 'cara', payload: { v: 1, to: 'cara', operator_release: true } }, 'SplitChat support made Cara the owner'],
  ] as const)('%s', (kind, fields, text) => {
    expect(say(ev(kind, fields as Partial<ActivityEvent>))).toBe(text)
  })

  it('never shows an id for an unknown person, and tolerates a malformed payload', () => {
    expect(say(ev('member_removed', { subjectUserId: 'stranger-id' }))).toBe('Bob removed SplitChat member')
    expect(say(ev('expense_created', { subjectId: 'x1', payload: { v: 1, amount_cents: 'lots' } }))).toBe('Bob added “Dinner”')
    expect(say(ev('expense_updated', { subjectId: 'x1', payload: { v: 1, changes: 'bad' } }))).toBe('Bob edited “Dinner” no changes')
  })
})
