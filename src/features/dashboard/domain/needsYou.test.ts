import { describe, expect, it } from 'vitest'
import type { Result } from '../../../shared/api/result'
import type { GroupSummary } from '../../groups'
import type { Candidate } from '../../smart-expense'
import { needsYouItems, overallPosition } from './needsYou'

const group = (id: string, name: string): GroupSummary =>
  ({ id, name, description: null, createdAt: '2026-09-01T00:00:00Z', myRole: 'member', memberCount: 3 }) as GroupSummary
const proposal = (id: string, groupId: string, fields: Partial<Candidate> = {}): Candidate => ({
  id, groupId, messageId: 1, proposedBy: 'me', status: 'proposed', source: 'natural', interpreterVersion: 'deterministic-1',
  description: 'pizza', amountCents: 4200, expenseDate: '2026-09-29', paidBy: 'me', participantIds: ['me', 'a'],
  notes: null, version: 1, expenseId: null, decidedBy: null, createdAt: '2026-09-29T00:00:00Z', ...fields,
})
const okv = (v: number): Result<number> => ({ ok: true, value: v })
const failed: Result<number> = { ok: false, code: 'network', message: 'x' } as Result<number>

describe('needsYouItems', () => {
  const groups = [group('g1', 'Flat'), group('g2', 'Trip')]

  it('lists proposals first (ready or with what is missing), then groups where I owe', () => {
    const items = needsYouItems(
      [proposal('c1', 'g1'), proposal('c2', 'g2', { participantIds: null, description: 'Parking' })],
      groups,
      new Map([['g1', okv(2500)], ['g2', okv(-43959)]]),
    )
    expect(items).toEqual([
      { key: 'proposal-c1', kind: 'proposal', groupName: 'Flat', to: '/groups/g1/chat', description: 'pizza', amountCents: 4200, missing: [] },
      { key: 'proposal-c2', kind: 'proposal', groupName: 'Trip', to: '/groups/g2/chat', description: 'Parking', amountCents: 4200, missing: ['who shares it'] },
      { key: 'owe-g2', kind: 'you_owe', groupName: 'Trip', to: '/groups/g2/balances', amountCents: 43959 },
    ])
  })

  it('drops proposals for groups I am no longer in, and ignores unknown or failed positions', () => {
    expect(needsYouItems([proposal('c1', 'gone')], groups, new Map([['g1', failed]]))).toEqual([])
    expect(needsYouItems([], groups, null)).toEqual([])
  })
})

describe('overallPosition', () => {
  it('adds up loaded positions, counts open groups and unavailable ones', () => {
    expect(overallPosition(new Map([['a', okv(-43959)], ['b', okv(139282)], ['c', okv(0)], ['d', failed]]))).toEqual({
      netCents: 95323, openGroups: 2, unavailable: 1,
    })
  })

  it('is zero and closed with no groups', () => {
    expect(overallPosition(new Map())).toEqual({ netCents: 0, openGroups: 0, unavailable: 0 })
  })
})
