import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSupabaseMock } from '../../../test/supabaseMock'
import EditProposalPage from './EditProposalPage'

const mock = vi.hoisted(() => ({ current: null as unknown, userId: 'u1' }))

vi.mock('../../../shared/api/supabase', () => ({
  get supabase() {
    return (mock.current as ReturnType<typeof createSupabaseMock>).client
  },
}))
vi.mock('../../auth/useAuth', () => ({
  useAuth: () => ({ session: { user: { id: mock.userId } } }),
}))

let supabaseMock: ReturnType<typeof createSupabaseMock>
const G = '10000000-0000-4000-8000-000000000001'
const candidate = (over: Record<string, unknown> = {}) => ({
  id: 'c1', group_id: G, message_id: 7, proposed_by: 'u1', status: 'proposed', source: 'command',
  interpreter_version: 'deterministic-1', description: 'Parking', amount_cents: 1850, expense_date: '2026-09-28',
  paid_by: 'u2', participant_ids: null, notes: null, version: 3, expense_id: null, decided_by: null, created_at: '2026-09-28T10:00:00Z',
  ...over,
})

function renderPage(groupId = G) {
  return render(
    <MemoryRouter initialEntries={[`/groups/${groupId}/proposals/c1/edit`]}>
      <Routes>
        <Route path="groups/:groupId/proposals/:candidateId/edit" element={<EditProposalPage />} />
        <Route path="groups/:groupId/chat" element={<p>Chat page</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  supabaseMock = createSupabaseMock()
  mock.current = supabaseMock
  mock.userId = 'u1'
  supabaseMock.setTable('expense_candidates', [candidate()])
  supabaseMock.setTable('groups', [{ id: G, name: 'Flat', description: null, created_at: '2026-09-01T00:00:00Z' }])
  supabaseMock.setTable('group_members', [
    { group_id: G, user_id: 'u1', role: 'member', joined_at: '2026-09-01T00:00:00Z' },
    { group_id: G, user_id: 'u2', role: 'owner', joined_at: '2026-09-01T00:00:00Z' },
  ])
  supabaseMock.setTable('profiles', [{ id: 'u1', full_name: 'Priya' }, { id: 'u2', full_name: 'Sam' }])
})

describe('EditProposalPage', () => {
  it('completes a proposal with the expense form and returns to the chat, sending the reviewed version', async () => {
    const user = userEvent.setup()
    supabaseMock.setRpc('update_expense_candidate', candidate({ participant_ids: ['u1', 'u2'], version: 4 }))
    renderPage()

    expect(await screen.findByRole('form', { name: 'Edit expense proposal' })).toBeInTheDocument()
    expect(screen.getByText(/Nothing is added to the group’s expenses until it is approved/)).toBeInTheDocument()
    // Participants were never guessed: the form will not save until they are chosen.
    await user.click(screen.getByRole('button', { name: 'Save proposal' }))
    expect(supabaseMock.rpc.mock.calls.some(([n]) => n === 'update_expense_candidate')).toBe(false)
    await user.click(screen.getByRole('button', { name: /Select everyone/ }))
    await user.click(screen.getByRole('button', { name: 'Save proposal' }))

    expect(await screen.findByText('Chat page')).toBeInTheDocument()
    const [, args] = supabaseMock.rpc.mock.calls.find(([n]) => n === 'update_expense_candidate')!
    expect(args).toMatchObject({ p_id: 'c1', p_expected_version: 3, p_description: 'Parking', p_amount_cents: 1850, p_paid_by: 'u2' })
    expect([...(args.p_participant_ids as string[])].sort()).toEqual(['u1', 'u2'])
    expect(supabaseMock.rpc.mock.calls.some(([n]) => n === 'approve_expense_candidate')).toBe(false)
  })

  it('treats a proposal opened under another group’s URL as not found', async () => {
    renderPage('10000000-0000-4000-8000-000000000002')
    expect(await screen.findByText('This proposal does not exist or you do not have access to it.')).toBeInTheDocument()
    expect(screen.queryByRole('form', { name: 'Edit expense proposal' })).not.toBeInTheDocument()
  })

  it('is read-only for a member who is neither the proposer nor the owner', async () => {
    mock.userId = 'u3'
    supabaseMock.setTable('group_members', [
      { group_id: G, user_id: 'u1', role: 'member', joined_at: '2026-09-01T00:00:00Z' },
      { group_id: G, user_id: 'u2', role: 'owner', joined_at: '2026-09-01T00:00:00Z' },
      { group_id: G, user_id: 'u3', role: 'member', joined_at: '2026-09-01T00:00:00Z' },
    ])
    renderPage()
    expect(await screen.findByText('Only the person who proposed this or the group owner can change it.')).toBeInTheDocument()
  })

  it('does not offer changes to a decided proposal', async () => {
    supabaseMock.setTable('expense_candidates', [candidate({ status: 'approved', expense_id: 'x1', decided_by: 'u1', participant_ids: ['u1', 'u2'] })])
    renderPage()
    expect(await screen.findByText('This proposal has already been decided, so it cannot be changed.')).toBeInTheDocument()
  })

  it('offers a reload after a concurrent change', async () => {
    const user = userEvent.setup()
    supabaseMock.setTable('expense_candidates', [candidate({ participant_ids: ['u1', 'u2'] })])
    supabaseMock.setRpc('update_expense_candidate', null, { message: 'stale_candidate' })
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Save proposal' }))
    expect(await screen.findByText(/changed by someone else/)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reload proposal' })).toBeInTheDocument())
  })
})
