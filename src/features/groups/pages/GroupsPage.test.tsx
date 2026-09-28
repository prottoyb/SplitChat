import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSupabaseMock } from '../../../test/supabaseMock'
import GroupsPage from './GroupsPage'

const mock = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('../../../shared/api/supabase', () => ({
  get supabase() {
    return (mock.current as ReturnType<typeof createSupabaseMock>).client
  },
}))

vi.mock('../../auth/useAuth', () => ({
  useAuth: () => ({ session: { user: { id: 'u1' } } }),
}))

let supabaseMock: ReturnType<typeof createSupabaseMock>

beforeEach(() => {
  supabaseMock = createSupabaseMock()
  mock.current = supabaseMock
})

const renderPage = () =>
  render(
    <MemoryRouter>
      <GroupsPage />
    </MemoryRouter>,
  )

function seedGroups() {
  supabaseMock.setTable('groups', [
    // u1 created "Flat" but transferred ownership; u1 owns "Trip".
    { id: 'g1', name: 'Flat', description: null, created_at: '2026-09-01T00:00:00Z' },
    { id: 'g2', name: 'Trip', description: 'Bali', created_at: '2026-09-02T00:00:00Z' },
  ])
  supabaseMock.setTable('group_members', [
    { group_id: 'g1', user_id: 'u1', role: 'member', joined_at: '2026-09-01' },
    { group_id: 'g1', user_id: 'u2', role: 'owner', joined_at: '2026-09-01' },
    { group_id: 'g2', user_id: 'u1', role: 'owner', joined_at: '2026-09-02' },
  ])
}

describe('GroupsPage', () => {
  it('shows the role from the membership, not groups.created_by, and member counts', async () => {
    seedGroups()
    renderPage()

    const flat = (await screen.findByText('Flat')).closest('a')
    const trip = screen.getByText('Trip').closest('a')
    expect(flat).toHaveTextContent('Member')
    expect(flat).not.toHaveTextContent('Owner')
    expect(flat).toHaveTextContent('2 members')
    expect(trip).toHaveTextContent('Owner')
    expect(trip).toHaveTextContent('1 member')
  })

  it('shows an empty state with a create action', async () => {
    supabaseMock.setTable('groups', [])
    renderPage()

    expect(await screen.findByText('No groups yet')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create your first group' })).toBeInTheDocument()
  })

  it('shows a retryable error without raw database text', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    supabaseMock.setTable('groups', null, { message: 'relation "groups" does not exist' })
    renderPage()

    expect(await screen.findByText('Unable to load your groups.')).toBeInTheDocument()
    expect(screen.queryByText(/relation/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('validates and creates a group with trimmed values', async () => {
    supabaseMock.setTable('groups', [])
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: '+ Create group' }))
    await user.click(screen.getByRole('button', { name: 'Create group' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Please enter a group name.')

    await user.type(screen.getByLabelText('Group name'), '  Flat 12  ')
    await user.click(screen.getByRole('button', { name: 'Create group' }))

    expect(await screen.findByText('Group created successfully.')).toBeInTheDocument()
    const insert = supabaseMock.queries.flatMap((q) => q.calls).find((c) => c.method === 'insert')
    expect(insert?.args[0]).toEqual({ name: 'Flat 12', description: null, created_by: 'u1' })
  })

  it('keeps the form open with a safe message when creation fails', async () => {
    supabaseMock.setTable('groups', [])
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: '+ Create group' }))
    supabaseMock.setTable('groups', null, { message: 'new row violates row-level security policy' })
    await user.type(screen.getByLabelText('Group name'), 'Flat')
    await user.click(screen.getByRole('button', { name: 'Create group' }))

    expect(await screen.findByText('Unable to create the group. Please try again.')).toBeInTheDocument()
    expect(screen.queryByText(/row-level security/)).not.toBeInTheDocument()
    expect(screen.getByLabelText('Group name')).toHaveValue('Flat')
  })
})
