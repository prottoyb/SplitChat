import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSupabaseMock } from '../../test/supabaseMock'
import DashboardPage from './DashboardPage'

const mock = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('../../shared/api/supabase', () => ({
  get supabase() {
    return (mock.current as ReturnType<typeof createSupabaseMock>).client
  },
}))

vi.mock('../auth/useAuth', () => ({
  useAuth: () => ({ session: { user: { id: 'u1' } }, profile: { full_name: 'Alice Adams' } }),
}))

let supabaseMock: ReturnType<typeof createSupabaseMock>
const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString()

beforeEach(() => {
  supabaseMock = createSupabaseMock()
  mock.current = supabaseMock
})

const renderPage = () =>
  render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  )

describe('DashboardPage', () => {
  it('greets the user and shows groups, recent activity and attention items from real data', async () => {
    supabaseMock.setTable('groups', [
      { id: 'g1', name: 'Flat', description: null, created_at: '2026-09-01T00:00:00Z' },
      { id: 'g2', name: 'Solo trip', description: null, created_at: '2026-09-02T00:00:00Z' },
    ])
    supabaseMock.setTable('group_members', [
      { group_id: 'g1', user_id: 'u1', role: 'member', joined_at: '2026-09-01' },
      { group_id: 'g1', user_id: 'u2', role: 'owner', joined_at: '2026-09-01' },
      { group_id: 'g2', user_id: 'u1', role: 'owner', joined_at: '2026-09-02' },
    ])
    supabaseMock.setTable('group_events', [
      {
        id: 7, group_id: 'g1', kind: 'expense_updated', actor_id: 'u2', subject_id: 'x1', subject_user_id: null,
        people: ['u1', 'u2'], payload: { v: 1, changes: { amount_cents: { from: 1000, to: 1200 } } }, backfilled: false, created_at: recent,
      },
    ])
    supabaseMock.setTable('expenses', [{
      id: 'x1', group_id: 'g1', description: 'Dinner', amount_cents: 1200, expense_date: '2026-09-20',
      paid_by: 'u2', created_by: 'u2', updated_by: 'u2', notes: null, created_at: recent, updated_at: recent,
    }])
    supabaseMock.setTable('profiles', [{ id: 'u1', full_name: 'Alice Adams' }, { id: 'u2', full_name: 'Bob Brown' }])
    supabaseMock.setTable('expense_splits', [])
    renderPage()

    expect(await screen.findByRole('heading', { name: 'Welcome back, Alice' })).toBeInTheDocument()
    expect(screen.getAllByText('Bob Brown', { selector: 'strong' }).length).toBeGreaterThan(0)
    expect(screen.getByRole('link', { name: '“Dinner”' })).toHaveAttribute('href', '/expenses/x1')

    const attention = screen.getByRole('heading', { name: 'For you' }).closest('article') as HTMLElement
    expect(within(attention).getByText(/changed an expense you're part of in/)).toBeInTheDocument()
    expect(within(attention).getByText(/has no other members yet/)).toBeInTheDocument()

    const groups = screen.getByRole('heading', { name: 'Your groups' }).closest('article') as HTMLElement
    expect(within(groups).getByText('Flat')).toBeInTheDocument()
    expect(within(groups).getByText(/2 members · Member/)).toBeInTheDocument()
  })

  it('shows my server position in each listed group; one failed balance degrades only its row', async () => {
    supabaseMock.setTable('groups', [
      { id: 'g1', name: 'Flat', description: null, created_at: '2026-09-02T00:00:00Z' },
      { id: 'g2', name: 'Trip', description: null, created_at: '2026-09-01T00:00:00Z' },
      { id: 'g3', name: 'Club', description: null, created_at: '2026-08-01T00:00:00Z' },
    ])
    supabaseMock.setTable('group_members', [])
    supabaseMock.setTable('group_events', [])
    supabaseMock.setTable('expenses', [])
    const row = (user_id: string, net: number) => ({
      user_id, paid_cents: Math.max(net, 0), owed_cents: Math.max(-net, 0), settled_out_cents: 0, settled_in_cents: 0, net_cents: net,
    })
    supabaseMock.rpc.mockImplementation((name, args) => {
      if (name !== 'get_group_balances') return Promise.resolve({ data: [], error: null })
      if (args.p_group_id === 'g1') return Promise.resolve({ data: [row('u1', -4333), row('u2', 4333)], error: null })
      if (args.p_group_id === 'g2') return Promise.resolve({ data: null, error: { message: 'boom' } })
      return Promise.resolve({ data: [], error: null })
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    renderPage()

    const groups = (await screen.findByRole('heading', { name: 'Your groups' })).closest('article') as HTMLElement
    const link = (name: string) => within(groups).getByText(name).closest('a') as HTMLElement
    expect(await within(link('Flat')).findByText('You owe $43.33')).toBeInTheDocument()
    expect(within(link('Trip')).getByText('Balance unavailable')).toBeInTheDocument()
    expect(within(link('Club')).getByText('You are settled up')).toBeInTheDocument()
  })

  it('shows honest empty states and no invented balances', async () => {
    supabaseMock.setTable('groups', [])
    supabaseMock.setTable('group_events', [])
    supabaseMock.setTable('expenses', [])
    renderPage()

    expect(await screen.findByText(/Nothing has happened yet/)).toBeInTheDocument()
    expect(screen.getByText("You're all caught up.")).toBeInTheDocument()
    expect(screen.queryByText(/You owe|You are owed/)).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: '+ Create group' })).toHaveAttribute('href', '/groups?create=1')
  })

  it('shows a retryable error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    supabaseMock.setTable('groups', null, { message: 'boom' })
    renderPage()

    expect(await screen.findByText('Unable to load your groups.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})
