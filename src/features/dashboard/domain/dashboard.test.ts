import { describe, expect, it } from 'vitest'
import type { ActivityEvent, ActivityPage } from '../../activity'
import type { ExpenseListItem } from '../../expenses'
import type { GroupSummary } from '../../groups'
import { attentionItems } from './attention'
import { lastActivityByGroup, monthSummary } from './summary'

const NOW = new Date('2026-09-27T12:00:00Z')

const ev = (id: number, fields: Partial<ActivityEvent>): ActivityEvent => ({
  id, groupId: 'g1', kind: 'expense_created', actorId: 'bob', subjectId: null, subjectUserId: null,
  people: [], payload: { v: 1 }, backfilled: false, createdAt: '2026-09-26T10:00:00Z', ...fields,
})

const page = (events: ActivityEvent[]): ActivityPage => ({
  events, next: null, names: new Map([['bob', 'Bob']]), groupNames: new Map([['g1', 'Flat']]),
  expenseTitles: new Map([['x1', 'Dinner']]),
})

const group = (id: string, memberCount: number): GroupSummary => ({
  id, name: id === 'g1' ? 'Flat' : 'Solo trip', description: null, createdAt: '2026-09-01T00:00:00Z', myRole: 'owner', memberCount,
})

describe('attentionItems', () => {
  it('flags edits and deletions by others on expenses I am part of', () => {
    const items = attentionItems(page([
      ev(3, { kind: 'expense_updated', subjectId: 'x1', people: ['bob', 'me'] }),
      ev(2, { kind: 'expense_deleted', subjectId: 'gone', people: ['bob', 'me'] }),
      ev(1, { kind: 'expense_updated', subjectId: 'x1', people: ['bob'] }),            // not mine
    ]), [group('g1', 2)], 'me', NOW)

    expect(items.map((i) => [i.kind, i.to])).toEqual([
      ['expense_changed', '/expenses/x1'],
      ['expense_changed', '/groups/g1/activity'],
    ])
  })

  it('ignores my own changes, backfilled history and anything older than two weeks', () => {
    const items = attentionItems(page([
      ev(3, { kind: 'expense_updated', actorId: 'me', subjectId: 'x1', people: ['me'] }),
      ev(2, { kind: 'expense_updated', subjectId: 'x1', people: ['me'], backfilled: true }),
      ev(1, { kind: 'expense_updated', subjectId: 'x1', people: ['me'], createdAt: '2026-09-01T00:00:00Z' }),
    ]), [], 'me', NOW)

    expect(items).toEqual([])
  })

  it('flags being added to a group and groups where I am the only member', () => {
    const items = attentionItems(page([
      ev(1, { kind: 'member_added', subjectUserId: 'me' }),
    ]), [group('g1', 3), group('g2', 1)], 'me', NOW)

    expect(items.map((i) => [i.kind, i.subject, i.to])).toEqual([
      ['added_to_group', 'Bob', '/groups/g1'],
      ['solo_group', 'Solo trip', '/groups/g2'],
    ])
  })
})

describe('summary', () => {
  const exp = (expenseDate: string, amountCents: number, myShareCents: number | null) =>
    ({ expenseDate, amountCents, myShareCents }) as ExpenseListItem

  it('sums this month in integer cents', () => {
    expect(monthSummary([exp('2026-09-01', 1001, 334), exp('2026-09-30', 99, null), exp('2026-08-31', 5000, 2500)], '2026-09-27'))
      .toEqual({ count: 2, totalCents: 1100, myShareCents: 334 })
  })

  it('finds each group\'s latest event', () => {
    const events = [ev(3, { groupId: 'g2', createdAt: '2026-09-27T09:00:00Z' }), ev(2, {}), ev(1, { backfilled: true })]
    expect([...lastActivityByGroup(events)]).toEqual([['g2', '2026-09-27T09:00:00Z'], ['g1', '2026-09-26T10:00:00Z']])
  })
})
