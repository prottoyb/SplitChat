import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSupabaseMock } from '../../test/supabaseMock'
import ActivityPage from './ActivityPage'

const mock = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('../../shared/api/supabase', () => ({
  get supabase() {
    return (mock.current as ReturnType<typeof createSupabaseMock>).client
  },
}))

vi.mock('../auth/useAuth', () => ({
  useAuth: () => ({ session: { user: { id: 'u1' } } }),
}))

let supabaseMock: ReturnType<typeof createSupabaseMock>

const event = (id: number, fields: Record<string, unknown> = {}) => ({
  id, group_id: 'g1', kind: 'member_added', actor_id: 'u1', subject_id: null, subject_user_id: 'u2',
  people: ['u1', 'u2'], payload: { v: 1 }, backfilled: false, created_at: `2026-09-2${id}T10:00:00Z`, ...fields,
})

beforeEach(() => {
  supabaseMock = createSupabaseMock()
  mock.current = supabaseMock
  supabaseMock.setTable('groups', [{ id: 'g1', name: 'Flat', description: null, created_at: '2026-09-01T00:00:00Z' }])
  supabaseMock.setTable('group_members', [{ group_id: 'g1', user_id: 'u1', role: 'owner', joined_at: '2026-09-01' }])
  supabaseMock.setTable('profiles', [{ id: 'u1', full_name: 'Alice' }, { id: 'u2', full_name: 'Bob' }])
})

const renderPage = (path = '/activity') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <ActivityPage />
    </MemoryRouter>,
  )

describe('ActivityPage', () => {
  it('lists events as sentences with the group, and loads more with the keyset cursor', async () => {
    // 26 rows for a page size of 25 -> a next page exists.
    supabaseMock.setTable('group_events', Array.from({ length: 26 }, (_, i) => event(26 - i, { created_at: `2026-09-01T10:${String(59 - i).padStart(2, '0')}:00Z` })))
    const user = userEvent.setup()
    renderPage()

    expect((await screen.findAllByText('added')).length).toBe(25)
    expect(screen.getAllByText('Bob').length).toBeGreaterThan(0)
    expect(screen.getAllByRole('link', { name: 'Flat' }).length).toBe(25)

    supabaseMock.setTable('group_events', [event(1, { id: 1, kind: 'member_left', actor_id: 'u2', created_at: '2026-08-31T10:00:00Z' })])
    await user.click(screen.getByRole('button', { name: 'Load more' }))

    expect(await screen.findByText('left the group')).toBeInTheDocument()
    const orCall = supabaseMock.queries.flatMap((q) => q.calls).find((c) => c.method === 'or')
    expect(orCall?.args[0]).toMatch(/^created_at\.lt\."2026-09-01T10:35:00Z",and\(created_at\.eq\."2026-09-01T10:35:00Z",id\.lt\.2\)$/)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument())
  })

  it('filters by group from the URL and hides the per-entry group name', async () => {
    supabaseMock.setTable('group_events', [event(1)])
    renderPage('/activity?group=g1')

    expect(await screen.findByText('added')).toBeInTheDocument()
    expect(screen.getByLabelText('Group')).toHaveValue('g1')
    expect(screen.queryByRole('link', { name: 'Flat' })).not.toBeInTheDocument()
    const eqCalls = supabaseMock.queries.filter((q) => q.table === 'group_events').flatMap((q) => q.calls)
    expect(eqCalls).toContainEqual({ method: 'eq', args: ['group_id', 'g1'] })
  })

  it('shows an empty state', async () => {
    supabaseMock.setTable('group_events', [])
    renderPage()
    expect(await screen.findByText(/Nothing has happened in your groups yet/)).toBeInTheDocument()
  })

  it('notes that history before activity tracking may be incomplete', async () => {
    supabaseMock.setTable('group_events', [event(1, { backfilled: true })])
    renderPage()
    expect(await screen.findByText(/reconstructed when activity tracking started/)).toBeInTheDocument()
  })
})
