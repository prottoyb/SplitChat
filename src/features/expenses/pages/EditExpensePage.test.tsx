import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSupabaseMock } from '../../../test/supabaseMock'
import EditExpensePage from './EditExpensePage'

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
const UPDATED_AT = '2026-09-26T12:46:35.510649+00:00'

// Alice (u1) created a 10.01 expense split between herself and Eve (u5),
// who has since left the group; Bob (u2) is a current member.
function seed({ role = 'member', createdBy = 'u1' } = {}) {
  supabaseMock.setTable('expenses', [
    {
      id: 'x1', group_id: 'g1', description: 'Snacks', amount_cents: 1001, expense_date: '2026-09-20',
      paid_by: 'u5', created_by: createdBy, updated_by: null, notes: 'corner shop',
      created_at: '2026-09-20T10:00:00Z', updated_at: UPDATED_AT,
    },
  ])
  supabaseMock.setTable('groups', [{ id: 'g1', name: 'Flat', description: null, created_at: '2026-09-01T00:00:00Z' }])
  supabaseMock.setTable('expense_splits', [
    { expense_id: 'x1', user_id: 'u1', share_cents: 501 },
    { expense_id: 'x1', user_id: 'u5', share_cents: 500 },
  ])
  supabaseMock.setTable('group_members', [
    { group_id: 'g1', user_id: 'u1', role, joined_at: '2026-09-01' },
    { group_id: 'g1', user_id: 'u2', role: role === 'owner' ? 'member' : 'owner', joined_at: '2026-09-02' },
  ])
  supabaseMock.setTable('profiles', [
    { id: 'u1', full_name: 'Alice Adams' },
    { id: 'u2', full_name: 'Bob Brown' },
  ])
  supabaseMock.setRpc('get_ledger_identities', [{ user_id: 'u5', display_name: 'Eve' }])
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/expenses/x1/edit']}>
      <Routes>
        <Route path="expenses/:expenseId/edit" element={<EditExpensePage />} />
        <Route path="expenses/:expenseId" element={<p>Expense page</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  supabaseMock = createSupabaseMock()
  mock.current = supabaseMock
  mock.userId = 'u1'
})

describe('EditExpensePage', () => {
  it('prefills the form from the stored expense (cents as text, no floats)', async () => {
    seed()
    renderPage()

    expect(await screen.findByLabelText('Description')).toHaveValue('Snacks')
    expect(screen.getByLabelText('Amount')).toHaveValue('10.01')
    expect(screen.getByLabelText('Date')).toHaveValue('2026-09-20')
    expect(screen.getByLabelText('Paid by')).toHaveValue('u5')
    expect(screen.getByRole('checkbox', { name: /Alice Adams/ })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /Eve/ })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /Bob Brown/ })).not.toBeChecked()
  })

  it('labels the former member and keeps them selectable as payer and participant', async () => {
    seed()
    renderPage()

    const eve = await screen.findByRole('checkbox', { name: /Eve/ })
    expect(eve.closest('label')).toHaveTextContent('Former member')
    expect(within(screen.getByLabelText('Paid by')).getByRole('option', { name: /Eve \(former member\)/ })).toBeInTheDocument()
  })

  it('saves through update_equal_split_expense with the loaded updated_at string, then shows the expense', async () => {
    seed()
    supabaseMock.setRpc('update_equal_split_expense', '2026-09-27T01:00:00.000001+00:00')
    const user = userEvent.setup()
    renderPage()

    const amount = await screen.findByLabelText('Amount')
    await user.clear(amount)
    await user.type(amount, '12.50')
    await user.click(screen.getByRole('checkbox', { name: /Bob Brown/ }))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('Expense page')).toBeInTheDocument()
    expect(supabaseMock.rpc).toHaveBeenCalledWith('update_equal_split_expense', {
      p_expense_id: 'x1',
      p_expected_updated_at: UPDATED_AT,
      p_description: 'Snacks',
      p_amount_cents: 1250,
      p_expense_date: '2026-09-20',
      p_paid_by: 'u5',
      p_participant_ids: ['u1', 'u5', 'u2'],
      p_notes: 'corner shop',
    })
  })

  it('on a stale save offers a reload and never retries on its own', async () => {
    seed()
    supabaseMock.setRpc('update_equal_split_expense', null, { message: 'stale_expense' })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText(/changed by someone else/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reload expense' })).toBeInTheDocument()
    expect(supabaseMock.rpc.mock.calls.filter(([name]) => name === 'update_equal_split_expense')).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: 'Reload expense' }))
    await waitFor(() => expect(screen.queryByText(/changed by someone else/)).not.toBeInTheDocument())
  })

  it('makes the form read-only after a forbidden result', async () => {
    seed()
    supabaseMock.setRpc('update_equal_split_expense', null, { message: 'forbidden' })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText(/added this expense or the group owner/)).toBeInTheDocument()
    expect(screen.getByLabelText('Description')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()
  })

  it('is read-only for a member who neither created the expense nor owns the group', async () => {
    seed({ createdBy: 'u5' })
    renderPage()

    expect(await screen.findByText(/Only the person who added this expense or the group owner/)).toBeInTheDocument()
    expect(screen.getByLabelText('Description')).toBeDisabled()
  })

  it('lets the group owner edit another member\'s expense', async () => {
    seed({ role: 'owner', createdBy: 'u5' })
    renderPage()

    expect(await screen.findByLabelText('Description')).not.toBeDisabled()
  })

  it('shows field errors and does not call the server for invalid input', async () => {
    seed()
    const user = userEvent.setup()
    renderPage()

    const amount = await screen.findByLabelText('Amount')
    await user.clear(amount)
    await user.type(amount, '1e2')
    await user.clear(screen.getByLabelText('Date'))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(screen.getByLabelText('Amount')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('Expense amount must be greater than zero.')).toBeInTheDocument()
    expect(screen.getByText('Please select the expense date.')).toBeInTheDocument()
    expect(supabaseMock.rpc).not.toHaveBeenCalledWith('update_equal_split_expense', expect.anything())
  })
})
