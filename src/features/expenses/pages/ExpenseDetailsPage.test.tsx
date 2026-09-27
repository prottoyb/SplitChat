import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSupabaseMock } from '../../../test/supabaseMock'
import ExpenseDetailsPage from './ExpenseDetailsPage'

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

// Eve (u5) paid and has since left the group, so her profile is no longer
// visible under RLS; her name must come from the ledger identities RPC.
function seedExpense() {
  supabaseMock.setTable('expenses', [
    {
      id: 'x1', group_id: 'g1', description: 'Snacks', amount_cents: 1001, expense_date: '2026-09-20',
      paid_by: 'u5', created_by: 'u5', split_type: 'equal', notes: null,
      created_at: '2026-09-20T10:00:00Z', updated_at: '2026-09-20T10:00:00Z',
    },
  ])
  supabaseMock.setTable('groups', [{ id: 'g1', name: 'Flat', description: null }])
  supabaseMock.setTable('expense_splits', [
    { expense_id: 'x1', user_id: 'u1', share_cents: 501, percentage: null, created_at: '2026-09-20T10:00:00Z' },
    { expense_id: 'x1', user_id: 'u5', share_cents: 500, percentage: null, created_at: '2026-09-20T10:00:00Z' },
  ])
  supabaseMock.setTable('profiles', [{ id: 'u1', full_name: 'Alice Adams', avatar_url: null }])
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/expenses/x1']}>
      <Routes>
        <Route path="expenses/:expenseId" element={<ExpenseDetailsPage />} />
        <Route path="expenses" element={<p>Expense list</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  supabaseMock = createSupabaseMock()
  mock.current = supabaseMock
})

describe('ExpenseDetailsPage historical identities', () => {
  it('shows a former member by their preserved ledger name', async () => {
    seedExpense()
    supabaseMock.setRpc('get_ledger_identities', [{ user_id: 'u5', display_name: 'Eve' }])
    renderPage()

    expect((await screen.findAllByText('Eve')).length).toBeGreaterThan(0)
    expect(supabaseMock.rpc).toHaveBeenCalledWith('get_ledger_identities', { p_group_id: 'g1' })
  })

  it('falls back to a generic name, never an id, when the lookup fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    seedExpense()
    supabaseMock.setRpc('get_ledger_identities', null, { message: 'not_found_or_forbidden' })
    renderPage()

    expect((await screen.findAllByText('SplitChat member')).length).toBeGreaterThan(0)
    expect(screen.queryByText('u5')).not.toBeInTheDocument()
    consoleError.mockRestore()
  })

  it('does not call the identities RPC when every person is an active member', async () => {
    seedExpense()
    supabaseMock.setTable('profiles', [
      { id: 'u1', full_name: 'Alice Adams', avatar_url: null },
      { id: 'u5', full_name: 'Eve', avatar_url: null },
    ])
    renderPage()

    expect((await screen.findAllByText('Eve')).length).toBeGreaterThan(0)
    expect(supabaseMock.rpc).not.toHaveBeenCalled()
  })
})

describe('ExpenseDetailsPage amounts', () => {
  it('shows exact amounts from integer cents', async () => {
    seedExpense()
    supabaseMock.setRpc('get_ledger_identities', [{ user_id: 'u5', display_name: 'Eve' }])
    renderPage()

    // Header badge, total card and split total all show the full amount.
    expect(await screen.findAllByText('$10.01')).toHaveLength(3)
    // Alice's share appears in "Your share" and in her split row.
    expect(screen.getAllByText('$5.01')).toHaveLength(2)
    expect(screen.getByText('$5.00')).toBeInTheDocument()
  })

  it.each([
    ['a decimal amount', { amount_cents: '10.01' }],
    ['a missing amount', { amount_cents: null }],
  ])('treats %s as an unexpected response', async (_label, override) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    seedExpense()
    supabaseMock.setTable('expenses', [
      {
        id: 'x1', group_id: 'g1', description: 'Snacks', expense_date: '2026-09-20',
        paid_by: 'u5', created_by: 'u5', split_type: 'equal', notes: null,
        created_at: '2026-09-20T10:00:00Z', updated_at: '2026-09-20T10:00:00Z', ...override,
      },
    ])
    renderPage()

    expect(await screen.findByText('Unable to load this expense.')).toBeInTheDocument()
    expect(screen.queryByText(/\$10/)).not.toBeInTheDocument()
    consoleError.mockRestore()
  })
})

describe('ExpenseDetailsPage delete', () => {
  const UPDATED_AT = '2026-09-20T10:00:00.123456+00:00'

  // Alice (u1, the session user) created the expense.
  function seedOwnExpense(role: 'owner' | 'member') {
    seedExpense()
    supabaseMock.setRpc('get_ledger_identities', [{ user_id: 'u5', display_name: 'Eve' }])
    supabaseMock.setTable('expenses', [
      {
        id: 'x1', group_id: 'g1', description: 'Snacks', amount_cents: 1001, expense_date: '2026-09-20',
        paid_by: 'u5', created_by: 'u1', split_type: 'equal', notes: null,
        created_at: '2026-09-20T10:00:00Z', updated_at: UPDATED_AT,
      },
    ])
    supabaseMock.setTable('group_members', [{ role }])
  }

  it('lets the creator delete after confirming, sending the loaded updated_at', async () => {
    seedOwnExpense('member')
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Delete expense' }))
    expect(supabaseMock.rpc).not.toHaveBeenCalledWith('delete_expense', expect.anything())

    await user.click(screen.getByRole('button', { name: 'Yes, delete' }))

    expect(await screen.findByText('Expense list')).toBeInTheDocument()
    expect(supabaseMock.rpc).toHaveBeenCalledWith('delete_expense', {
      p_expense_id: 'x1',
      p_expected_updated_at: UPDATED_AT,
    })
  })

  it('can be cancelled', async () => {
    seedOwnExpense('member')
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Delete expense' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.getByRole('button', { name: 'Delete expense' })).toBeInTheDocument()
    expect(supabaseMock.rpc).not.toHaveBeenCalledWith('delete_expense', expect.anything())
  })

  it('shows a stale-expense error and stays on the page', async () => {
    seedOwnExpense('member')
    supabaseMock.setRpc('delete_expense', null, { message: 'stale_expense' })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Delete expense' }))
    await user.click(screen.getByRole('button', { name: 'Yes, delete' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This expense was changed by someone else. Reload it and try again.',
    )
    expect(screen.queryByText('Expense list')).not.toBeInTheDocument()
  })

  it("offers delete to the group owner for another member's expense", async () => {
    seedExpense()  // created by Eve (u5)
    supabaseMock.setRpc('get_ledger_identities', [{ user_id: 'u5', display_name: 'Eve' }])
    supabaseMock.setTable('group_members', [{ role: 'owner' }])
    renderPage()

    expect(await screen.findByRole('button', { name: 'Delete expense' })).toBeInTheDocument()
  })

  it("does not offer delete to a member for someone else's expense", async () => {
    seedExpense()  // created by Eve (u5)
    supabaseMock.setRpc('get_ledger_identities', [{ user_id: 'u5', display_name: 'Eve' }])
    supabaseMock.setTable('group_members', [{ role: 'member' }])
    renderPage()

    expect((await screen.findAllByText('Eve')).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Delete expense' })).not.toBeInTheDocument()
  })
})
