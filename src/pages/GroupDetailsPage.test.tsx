import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSupabaseMock } from '../test/supabaseMock'
import GroupDetailsPage from './GroupDetailsPage'

const mock = vi.hoisted(() => ({ current: null as unknown, userId: 'u1' }))

vi.mock('../lib/supabase', () => ({
  get supabase() {
    return (mock.current as ReturnType<typeof createSupabaseMock>).client
  },
}))

vi.mock('../auth/useAuth', () => ({
  useAuth: () => ({ session: { user: { id: mock.userId } } }),
}))

let supabaseMock: ReturnType<typeof createSupabaseMock>

// u9 created the group, but u1 is the owner after a transfer: ownership must
// follow the membership role, not groups.created_by.
function seedGroup(ownerId = 'u1') {
  supabaseMock.setTable('groups', [
    { id: 'g1', name: 'Flat', description: null, created_by: 'u9', created_at: '2026-09-01', updated_at: '2026-09-01' },
  ])
  supabaseMock.setTable('group_members', [
    { group_id: 'g1', user_id: 'u1', role: ownerId === 'u1' ? 'owner' : 'member', joined_at: '2026-09-01' },
    { group_id: 'g1', user_id: 'u2', role: ownerId === 'u2' ? 'owner' : 'member', joined_at: '2026-09-02' },
  ])
  supabaseMock.setTable('profiles', [
    { id: 'u1', full_name: 'Alice Adams', avatar_url: null },
    { id: 'u2', full_name: 'Bob Brown', avatar_url: null },
  ])
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/groups/g1']}>
      <Routes>
        <Route path="groups/:groupId" element={<GroupDetailsPage />} />
        <Route path="groups" element={<p>Groups list</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  supabaseMock = createSupabaseMock()
  mock.current = supabaseMock
  mock.userId = 'u1'
})

describe('GroupDetailsPage ownership', () => {
  it('treats the member whose role is owner as the owner', async () => {
    seedGroup('u1')
    renderPage()

    expect(await screen.findByRole('button', { name: '+ Add member' })).toBeInTheDocument()
    expect(screen.getByText(/make another member the owner first/i)).toBeInTheDocument()
  })

  it('does not treat the group creator as owner after a transfer', async () => {
    seedGroup('u2')
    mock.userId = 'u1'
    renderPage()

    expect(await screen.findByRole('button', { name: 'Leave group' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '+ Add member' })).not.toBeInTheDocument()
  })
})

describe('GroupDetailsPage membership actions use RPCs', () => {
  it('adds a member and shows their name', async () => {
    seedGroup()
    supabaseMock.setRpc('add_group_member_by_email', [
      { result: 'added', added_user_id: 'u3', added_full_name: 'Cara Cole', added_role: 'member' },
    ])
    const user = userEvent.setup()
    renderPage()

    await user.type(await screen.findByLabelText('Email address'), 'Cara@Example.com ')
    await user.click(screen.getByRole('button', { name: '+ Add member' }))

    expect(await screen.findByText(/Cara Cole was added/)).toBeInTheDocument()
    expect(supabaseMock.rpc).toHaveBeenCalledWith('add_group_member_by_email', {
      target_group_id: 'g1',
      target_email: 'cara@example.com',
    })
  })

  it('does not reveal whether an email has an account', async () => {
    seedGroup()
    supabaseMock.setRpc('add_group_member_by_email', [
      { result: 'member_not_added', added_user_id: null, added_full_name: null, added_role: null },
    ])
    const user = userEvent.setup()
    renderPage()

    await user.type(await screen.findByLabelText('Email address'), 'someone@example.com')
    await user.click(screen.getByRole('button', { name: '+ Add member' }))

    expect(await screen.findByText(/could not add anyone with that email/i)).toBeInTheDocument()
  })

  it('removes a member through remove_group_member', async () => {
    seedGroup()
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Remove' }))
    await user.click(screen.getByRole('button', { name: 'Confirm' }))

    await waitFor(() =>
      expect(supabaseMock.rpc).toHaveBeenCalledWith('remove_group_member', { p_group_id: 'g1', p_user_id: 'u2' }),
    )
    expect(await screen.findByText(/Bob Brown was removed/)).toBeInTheDocument()
  })

  it('transfers ownership after confirmation', async () => {
    seedGroup()
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Make owner' }))
    await user.click(screen.getByRole('button', { name: 'Confirm owner' }))

    await waitFor(() =>
      expect(supabaseMock.rpc).toHaveBeenCalledWith('transfer_group_ownership', {
        p_group_id: 'g1',
        p_new_owner_id: 'u2',
      }),
    )
    expect(await screen.findByText(/Bob Brown is now the owner/)).toBeInTheDocument()
  })

  it('leaves through leave_group and returns to the groups list', async () => {
    seedGroup('u2')
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Leave group' }))
    await user.click(screen.getByRole('button', { name: 'Yes, leave' }))

    expect(await screen.findByText('Groups list')).toBeInTheDocument()
    expect(supabaseMock.rpc).toHaveBeenCalledWith('leave_group', { p_group_id: 'g1' })
  })

  it('shows mapped server errors, never raw messages', async () => {
    seedGroup('u2')
    supabaseMock.setRpc('leave_group', null, { message: 'not_found_or_forbidden' })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Leave group' }))
    await user.click(screen.getByRole('button', { name: 'Yes, leave' }))

    expect(await screen.findByText(/do not have permission to do that/)).toBeInTheDocument()
  })
})
