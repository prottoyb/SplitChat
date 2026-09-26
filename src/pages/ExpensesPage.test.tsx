import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSupabaseMock } from '../test/supabaseMock'
import ExpensesPage from './ExpensesPage'

const mock = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('../lib/supabase', () => ({
  get supabase() {
    return (mock.current as ReturnType<typeof createSupabaseMock>).client
  },
}))

vi.mock('../auth/useAuth', () => ({
  useAuth: () => ({ session: { user: { id: 'u1' } } }),
}))

let supabaseMock: ReturnType<typeof createSupabaseMock>

const expense = (id: string, amountCents: unknown) => ({
  id, group_id: 'g1', description: `Expense ${id}`, amount_cents: amountCents,
  expense_date: '2026-09-20', paid_by: 'u1', created_by: 'u1', split_type: 'equal',
  notes: null, created_at: '2026-09-20T10:00:00Z', updated_at: '2026-09-20T10:00:00Z',
})

// 0.10 + 0.20 is 0.30000000000000004 in floating point; integer cents keep
// the totals exact.
function seed() {
  supabaseMock.setTable('expenses', [expense('x1', 10), expense('x2', 20)])
  supabaseMock.setTable('groups', [{ id: 'g1', name: 'Flat' }])
  supabaseMock.setTable('profiles', [{ id: 'u1', full_name: 'Alice Adams', avatar_url: null }])
  supabaseMock.setTable('expense_splits', [
    { expense_id: 'x1', user_id: 'u1', share_cents: 5 },
    { expense_id: 'x2', user_id: 'u1', share_cents: 7 },
  ])
}

function renderPage() {
  return render(
    <MemoryRouter>
      <ExpensesPage />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  supabaseMock = createSupabaseMock()
  mock.current = supabaseMock
})

describe('ExpensesPage amounts', () => {
  it('totals integer cents exactly', async () => {
    seed()
    renderPage()

    expect(await screen.findByText('$0.30')).toBeInTheDocument()
    expect(screen.getByText('$0.12')).toBeInTheDocument()
    expect(screen.getByText('$0.10')).toBeInTheDocument()
    expect(screen.getByText('$0.20')).toBeInTheDocument()
  })

  it('treats a non-integer cents value as an unexpected response', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    seed()
    supabaseMock.setTable('expenses', [expense('x1', 10), expense('x2', 20.5)])
    renderPage()

    expect(await screen.findByText('Unable to load your expenses.')).toBeInTheDocument()
    consoleError.mockRestore()
  })
})
