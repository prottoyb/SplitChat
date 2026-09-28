import { describe, expect, it } from 'vitest'
import type { GroupDetail } from '../../../features/groups'
import { nextStep } from './nextStep'

const member = (userId: string, fullName: string, role: 'owner' | 'member' = 'member') => ({ userId, fullName, role, joinedAt: '2026-09-01' })
const group = (members = [member('me', 'Me', 'owner'), member('a', 'Alex'), member('s', 'Sam')]): GroupDetail => ({
  id: 'g1', name: 'Flat', description: null, createdAt: '2026-09-01T00:00:00Z', members, myRole: 'owner',
})
const names = new Map([['me', 'Me'], ['a', 'Alex'], ['s', 'Sam']])

describe('nextStep (group overview)', () => {
  it('names the first payment I should make, and how many more', () => {
    const plan = { transfers: [{ from: 'me', to: 'a', amountCents: 43959 }, { from: 'me', to: 's', amountCents: 100 }], names }
    expect(nextStep(group(), 'me', plan, 3)).toEqual({
      text: 'Pay Alex $439.59 and 1 more.', to: '/groups/g1/balances?settle=me~a', label: 'Record your payment',
    })
  })

  it('names who owes me when I owe nothing', () => {
    const plan = { transfers: [{ from: 's', to: 'me', amountCents: 21974 }, { from: 'a', to: 's', amountCents: 5 }], names }
    expect(nextStep(group(), 'me', plan, 3)).toEqual({
      text: 'Sam owes you $219.74.', to: '/groups/g1/balances?settle=s~me', label: 'Record a payment',
    })
  })

  it('ignores payments between other people', () => {
    const plan = { transfers: [{ from: 'a', to: 's', amountCents: 500 }], names }
    expect(nextStep(group(), 'me', plan, 3)).toBeNull()
  })

  it('asks a solo owner to add members, and a new group for its first expense', () => {
    expect(nextStep(group([member('me', 'Me', 'owner')]), 'me', { transfers: [], names }, 0)?.label).toBe('Add members')
    expect(nextStep(group(), 'me', { transfers: [], names }, 0)?.label).toBe('Add an expense')
  })

  it('suggests nothing while the plan is loading and the group has expenses', () => {
    expect(nextStep(group(), 'me', null, 2)).toBeNull()
  })
})
