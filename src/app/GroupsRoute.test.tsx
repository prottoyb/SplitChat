import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSupabaseMock } from '../test/supabaseMock'
import GroupsRoute from './GroupsRoute'

const mock = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('../shared/api/supabase', () => ({
  get supabase() {
    return (mock.current as ReturnType<typeof createSupabaseMock>).client
  },
}))
vi.mock('../features/auth/useAuth', () => ({ useAuth: () => ({ session: { user: { id: 'u1' } } }) }))

let supabaseMock: ReturnType<typeof createSupabaseMock>
const row = (user_id: string, net: number) => ({
  user_id, paid_cents: Math.max(net, 0), owed_cents: Math.max(-net, 0), settled_out_cents: 0, settled_in_cents: 0, net_cents: net,
})

beforeEach(() => {
  supabaseMock = createSupabaseMock()
  mock.current = supabaseMock
  supabaseMock.setTable('groups', [
    { id: 'g1', name: 'Flat', description: null, created_at: '2026-09-02T00:00:00Z' },
    { id: 'g2', name: 'Trip', description: null, created_at: '2026-09-01T00:00:00Z' },
  ])
  supabaseMock.setTable('group_members', [
    { group_id: 'g1', user_id: 'u1', role: 'owner', joined_at: '2026-09-01' },
    { group_id: 'g2', user_id: 'u1', role: 'member', joined_at: '2026-09-01' },
  ])
})

describe('Groups page with positions (P16)', () => {
  it('shows my server position on each group card; one failure degrades only its card', async () => {
    supabaseMock.rpc.mockImplementation((name, args) => {
      if (name !== 'get_group_balances') return Promise.resolve({ data: [], error: null })
      if (args.p_group_id === 'g1') return Promise.resolve({ data: [row('u1', 4333), row('u2', -4333)], error: null })
      return Promise.resolve({ data: null, error: { message: 'boom' } })
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <MemoryRouter>
        <GroupsRoute />
      </MemoryRouter>,
    )
    const flat = (await screen.findByRole('link', { name: /Flat/ })) as HTMLElement
    expect(await within(flat).findByText('You are owed $43.33')).toBeInTheDocument()
    const trip = screen.getByRole('link', { name: /Trip/ })
    expect(await within(trip).findByText('Balance unavailable')).toBeInTheDocument()
  })
})
