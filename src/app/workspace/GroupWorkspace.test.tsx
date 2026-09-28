import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSupabaseMock } from '../../test/supabaseMock'
import GroupWorkspace from './GroupWorkspace'

const mock = vi.hoisted(() => ({ current: null as unknown, userId: 'u2' }))

vi.mock('../../shared/api/supabase', () => ({
  get supabase() {
    return (mock.current as ReturnType<typeof createSupabaseMock>).client
  },
}))

vi.mock('../../features/auth/useAuth', () => ({
  useAuth: () => ({ session: { user: { id: mock.userId } } }),
}))

let supabaseMock: ReturnType<typeof createSupabaseMock>

const balance = (user_id: string, paid: number, owed: number) => ({
  user_id, paid_cents: paid, owed_cents: owed, settled_out_cents: 0, settled_in_cents: 0, net_cents: paid - owed,
})

function seed() {
  supabaseMock.setTable('groups', [{ id: 'g1', name: 'Flat 4B', description: 'Rent and bills', created_at: '2026-09-01T00:00:00Z' }])
  supabaseMock.setTable('group_members', [
    { group_id: 'g1', user_id: 'u1', role: 'owner', joined_at: '2026-09-01T00:00:00Z' },
    { group_id: 'g1', user_id: 'u2', role: 'member', joined_at: '2026-09-02T00:00:00Z' },
  ])
  supabaseMock.setTable('profiles', [{ id: 'u1', full_name: 'Alice' }, { id: 'u2', full_name: 'Bob' }])
  supabaseMock.setRpc('get_group_balances', [balance('u1', 5000, 2500), balance('u2', 0, 2500)])
  supabaseMock.setTable('expenses', [
    {
      id: 'x1', group_id: 'g1', description: 'Groceries', amount_cents: 5000, expense_date: '2026-09-20',
      paid_by: 'u1', created_by: 'u1', updated_by: null, notes: null, created_at: '2026-09-20T10:00:00Z', updated_at: '2026-09-20T10:00:00Z',
    },
  ])
  supabaseMock.setTable('expense_splits', [{ expense_id: 'x1', user_id: 'u2', share_cents: 2500 }])
  supabaseMock.setTable('group_events', [])
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="groups/:groupId/*" element={<GroupWorkspace />} />
        <Route path="groups" element={<p>Groups list</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

const queriesOf = (table: string) => supabaseMock.queries.filter((q) => q.table === table)

beforeEach(() => {
  supabaseMock = createSupabaseMock()
  mock.current = supabaseMock
  mock.userId = 'u2'
  seed()
})

describe('GroupWorkspace header', () => {
  it('shows the group identity, my role, my server position and the primary action', async () => {
    renderAt('/groups/g1')

    expect(await screen.findByRole('heading', { name: 'Flat 4B', level: 2 })).toBeInTheDocument()
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' })
    expect(within(crumbs).getByRole('link', { name: 'Groups' })).toHaveAttribute('href', '/groups')
    expect(screen.getByText('Member', { selector: 'span' })).toBeInTheDocument()
    expect(screen.getByText(/2 members/)).toBeInTheDocument()
    expect(await screen.findByText('You owe $25.00')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '+ Add expense' })).toHaveAttribute('href', '/groups/g1/expenses/new')
    expect(supabaseMock.rpc).toHaveBeenCalledWith('get_group_balances', { p_group_id: 'g1' })
  })

  it.each([
    ['u1', 'You are owed $25.00'],
    ['u3', 'You are settled up'],
  ])('words the position for %s', async (userId, text) => {
    mock.userId = userId
    supabaseMock.setTable('group_members', [
      { group_id: 'g1', user_id: 'u1', role: 'owner', joined_at: '2026-09-01T00:00:00Z' },
      { group_id: 'g1', user_id: 'u2', role: 'member', joined_at: '2026-09-02T00:00:00Z' },
      { group_id: 'g1', user_id: 'u3', role: 'member', joined_at: '2026-09-03T00:00:00Z' },
    ])
    renderAt('/groups/g1')
    expect(await screen.findByText(text)).toBeInTheDocument()
  })

  it('shows an unavailable group as an error with a way back, not a broken workspace', async () => {
    supabaseMock.setTable('groups', [])
    renderAt('/groups/g1')

    expect(await screen.findByText('Group unavailable')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '← Back to groups' })).toHaveAttribute('href', '/groups')
    expect(screen.queryByRole('navigation', { name: 'Group sections' })).not.toBeInTheDocument()
  })
})

describe('GroupWorkspace sections', () => {
  it('marks the current section and moves focus to its heading on navigation', async () => {
    const user = userEvent.setup()
    renderAt('/groups/g1')
    const sections = await screen.findByRole('navigation', { name: 'Group sections' })
    // Operator decision D2 (Phase 9): four primary sections.
    expect(within(sections).getAllByRole('link').map((l) => l.textContent)).toEqual([
      'Overview', 'Expenses', 'Balances', 'Chat',
    ])
    expect(within(sections).getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page')

    await user.click(within(sections).getByRole('link', { name: 'Balances' }))

    const heading = await screen.findByRole('heading', { name: 'Balances', level: 3 })
    expect(within(sections).getByRole('link', { name: 'Balances' })).toHaveAttribute('aria-current', 'page')
    expect(within(sections).getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current')
    await waitFor(() => expect(heading).toHaveFocus())
  })

  it('reaches Members, Activity and Group settings from the group menu, with a breadcrumb back', async () => {
    const user = userEvent.setup()
    renderAt('/groups/g1')
    await user.click(await screen.findByRole('button', { name: 'Group options' }))
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Members 2', 'Activity', 'Group settings'])

    await user.click(screen.getByRole('menuitem', { name: /Members/ }))

    const heading = await screen.findByRole('heading', { name: 'Members', level: 3 })
    await waitFor(() => expect(heading).toHaveFocus())
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' })
    expect(within(crumbs).getByRole('link', { name: 'Flat 4B' })).toHaveAttribute('href', '/groups/g1')
    expect(within(crumbs).getByText('Members')).toHaveAttribute('aria-current', 'page')
    // No primary tab claims a secondary page.
    const sections = screen.getByRole('navigation', { name: 'Group sections' })
    expect(within(sections).queryByRole('link', { current: 'page' })).not.toBeInTheDocument()
  })

  it.each([
    ['/groups/g1/members', 'Members'],
    ['/groups/g1/activity', 'Activity'],
    ['/groups/g1/settings', 'Group settings'],
  ])('keeps the deep link %s working', async (path, title) => {
    renderAt(path)
    expect(await screen.findByRole('heading', { name: title, level: 3 })).toBeInTheDocument()
  })

  it('links the member count to Members', async () => {
    renderAt('/groups/g1')
    expect(await screen.findByRole('link', { name: '2 members' })).toHaveAttribute('href', '/groups/g1/members')
  })

  it('shows the group details read-only in settings', async () => {
    renderAt('/groups/g1/settings')
    await screen.findByRole('heading', { name: 'Group settings', level: 3 })
    expect(screen.getByText('Rent and bills')).toBeInTheDocument()
    expect(screen.getByText('Alice')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('badges the Chat tab with the open proposals I can act on', async () => {
    supabaseMock.setTable('expense_candidates', [{
      id: 'c1', group_id: 'g1', message_id: 3, proposed_by: 'u2', status: 'proposed', source: 'natural',
      interpreter_version: 'deterministic-1', description: 'pizza', amount_cents: 4200, expense_date: '2026-09-29',
      paid_by: 'u2', participant_ids: ['u1', 'u2'], notes: null, version: 1, expense_id: null, decided_by: null,
      created_at: '2026-09-29T00:00:00Z',
    }])
    renderAt('/groups/g1')
    const sections = await screen.findByRole('navigation', { name: 'Group sections' })
    expect(await within(sections).findByRole('link', { name: /^Chat\s*, 1 proposal needs you$/ })).toHaveAttribute('href', '/groups/g1/chat')
    const calls = queriesOf('expense_candidates')[0].calls
    expect(calls).toContainEqual({ method: 'eq', args: ['group_id', 'g1'] })
  })

  it('shows no badge when nothing needs me', async () => {
    supabaseMock.setTable('expense_candidates', [])
    renderAt('/groups/g1')
    const sections = await screen.findByRole('navigation', { name: 'Group sections' })
    expect(within(sections).getByRole('link', { name: 'Chat' })).toBeInTheDocument()
  })

  it('offers a way back to the overview from chat', async () => {
    renderAt('/groups/g1/chat')
    expect(await screen.findByRole('link', { name: 'Back to Flat 4B overview' })).toHaveAttribute('href', '/groups/g1')
  })

  it('lists only this group’s expenses in the Expenses section', async () => {
    renderAt('/groups/g1/expenses')

    const list = await screen.findByRole('list', { name: 'Expenses' })
    expect(within(list).getByRole('link', { name: 'Groceries' })).toHaveAttribute('href', '/expenses/x1')
    expect(screen.getByText('1 expense · $50.00 in total')).toBeInTheDocument()
    const filters = queriesOf('expenses')[0].calls.filter((c) => c.method === 'eq')
    expect(filters).toEqual([{ method: 'eq', args: ['group_id', 'g1'] }])
  })

  it('offers the first expense when the group has none', async () => {
    supabaseMock.setTable('expenses', [])
    renderAt('/groups/g1/expenses')

    expect(await screen.findByText('No expenses yet')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Add the first expense' })).toHaveAttribute('href', '/groups/g1/expenses/new')
  })

  it('scopes the Activity section to this group', async () => {
    renderAt('/groups/g1/activity')

    expect(await screen.findByText('Nothing has happened in this group yet.')).toBeInTheDocument()
    const filters = queriesOf('group_events')[0].calls.filter((c) => c.method === 'eq')
    expect(filters).toEqual([{ method: 'eq', args: ['group_id', 'g1'] }])
  })

  it('loads only the few recent expenses the overview shows, not the whole history', async () => {
    renderAt('/groups/g1')
    await screen.findByRole('link', { name: 'Groceries' })
    const calls = queriesOf('expenses')[0].calls
    expect(calls).toContainEqual({ method: 'limit', args: [5] })
    expect(calls).toContainEqual({ method: 'eq', args: ['group_id', 'g1'] })
  })

  it('names the payment to make on the overview and links to it pre-filled', async () => {
    renderAt('/groups/g1')

    // Phase 9 (P9): the header states the position; the next step names the payment.
    expect(await screen.findByText('Pay Alice $25.00.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Record your payment' })).toHaveAttribute('href', '/groups/g1/balances?settle=u2~u1')
    expect(await screen.findByRole('link', { name: 'Groceries' })).toBeInTheDocument()
  })

  it('keeps the workspace when the position cannot be loaded and lets me retry it', async () => {
    const user = userEvent.setup()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    supabaseMock.setRpc('get_group_balances', null, { message: 'boom' })
    renderAt('/groups/g1')

    expect(await screen.findByText('Unavailable')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Flat 4B', level: 2 })).toBeInTheDocument()
    expect(screen.queryByText(/You owe|You are owed|settled up/)).not.toBeInTheDocument()

    supabaseMock.setRpc('get_group_balances', [balance('u1', 5000, 2500), balance('u2', 0, 2500)])
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('You owe $25.00')).toBeInTheDocument()
  })

  it('sends an unknown section back to the overview', async () => {
    renderAt('/groups/g1/nonsense')

    expect(await screen.findByRole('heading', { name: 'Overview', level: 3 })).toBeInTheDocument()
  })
})
