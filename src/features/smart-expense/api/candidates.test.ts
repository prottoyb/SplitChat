import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSupabaseMock } from '../../../test/supabaseMock'
import { listActionableProposals } from './candidates'

const mock = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('../../../shared/api/supabase', () => ({
  get supabase() {
    return (mock.current as ReturnType<typeof createSupabaseMock>).client
  },
}))

const ME = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const OWNED = '33333333-3333-4333-8333-333333333333'
const MEMBER_OF = '44444444-4444-4444-8444-444444444444'

const row = (id: string, group_id: string, proposed_by: string, status = 'proposed') => ({
  id, group_id, message_id: 7, proposed_by, status, source: 'natural', interpreter_version: 'deterministic-1',
  description: 'pizza', amount_cents: 4200, expense_date: '2026-09-29', paid_by: proposed_by, participant_ids: null,
  notes: null, version: 1, expense_id: null, decided_by: null, created_at: '2026-09-29T00:00:00Z',
})

let supabaseMock: ReturnType<typeof createSupabaseMock>
beforeEach(() => {
  supabaseMock = createSupabaseMock()
  mock.current = supabaseMock
})

describe('listActionableProposals', () => {
  it('asks for open proposals that are mine or in groups I own, newest first, bounded', async () => {
    supabaseMock.setTable('expense_candidates', [])
    await listActionableProposals(ME, [OWNED])
    const calls = supabaseMock.queries.find((q) => q.table === 'expense_candidates')?.calls ?? []
    expect(calls).toContainEqual({ method: 'eq', args: ['status', 'proposed'] })
    expect(calls).toContainEqual({ method: 'or', args: [`proposed_by.eq.${ME},group_id.in.(${OWNED})`] })
    expect(calls).toContainEqual({ method: 'order', args: ['created_at', { ascending: false }] })
    expect(calls).toContainEqual({ method: 'limit', args: [20] })
  })

  it('keeps only rows the caller can act on, whatever the server returns', async () => {
    supabaseMock.setTable('expense_candidates', [
      row('c1', MEMBER_OF, ME),
      row('c2', OWNED, OTHER),
      row('c3', MEMBER_OF, OTHER), // someone else's, in a group I do not own
      row('c4', OWNED, OTHER, 'approved'),
    ])
    const result = await listActionableProposals(ME, [OWNED])
    expect(result.ok && result.value.map((c) => c.id)).toEqual(['c1', 'c2'])
  })

  it('refuses ids that could change the filter instead of building one from them', async () => {
    const result = await listActionableProposals(ME, ['x),proposed_by.neq.(y'])
    expect(result.ok).toBe(false)
    expect(supabaseMock.queries).toHaveLength(0)
  })
})
