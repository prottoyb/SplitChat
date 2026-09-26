import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSupabaseMock } from '../test/supabaseMock'
import AddExpensePage from './AddExpensePage'

const mock = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('../lib/supabase', () => ({
  get supabase() {
    return (mock.current as ReturnType<typeof createSupabaseMock>)
      .client
  },
}))

vi.mock('../auth/useAuth', () => ({
  useAuth: () => ({ session: { user: { id: 'u1' } } }),
}))

let supabaseMock: ReturnType<typeof createSupabaseMock>

function seedGroup() {
  supabaseMock.setTable('groups', [
    { id: 'g1', name: 'Flat', description: null },
  ])
  supabaseMock.setTable('group_members', [
    { group_id: 'g1', user_id: 'u1', role: 'owner', joined_at: '1' },
    { group_id: 'g1', user_id: 'u2', role: 'member', joined_at: '2' },
    { group_id: 'g1', user_id: 'u3', role: 'member', joined_at: '3' },
  ])
  supabaseMock.setTable('profiles', [
    { id: 'u1', full_name: 'Alice Adams', avatar_url: null },
    { id: 'u2', full_name: 'Bob Brown', avatar_url: null },
    { id: 'u3', full_name: 'Cara Cole', avatar_url: null },
  ])
}

function renderPage(path = '/groups/g1/expenses/new') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="groups/:groupId/expenses/new"
          element={<AddExpensePage />}
        />
      </Routes>
    </MemoryRouter>,
  )
}

async function fillAndSubmit(
  user: ReturnType<typeof userEvent.setup>,
  amount: string,
) {
  await user.type(screen.getByLabelText('Description'), 'Dinner')
  await user.type(screen.getByLabelText(/^Amount/), amount)
  await user.click(
    screen.getByRole('button', { name: 'Create expense' }),
  )
}

beforeEach(() => {
  supabaseMock = createSupabaseMock()
  mock.current = supabaseMock
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('AddExpensePage', () => {
  it('shows a loading state, then the form with everyone selected', async () => {
    seedGroup()
    renderPage()

    expect(screen.getByText('Loading expense form')).toBeInTheDocument()

    expect(
      await screen.findByRole('button', { name: 'Create expense' }),
    ).toBeInTheDocument()

    expect(screen.getByText('3/3')).toBeInTheDocument()
    expect(screen.getByLabelText('Paid by')).toHaveValue('u1')
  })

  it('shows an error when the group cannot be found', async () => {
    supabaseMock.setTable('groups', [])
    renderPage()

    expect(
      await screen.findByText(
        'This group does not exist or you do not have access to it.',
      ),
    ).toBeInTheDocument()
  })

  it('shows an error when loading the group fails', async () => {
    supabaseMock.setTable('groups', null, { message: 'boom' })
    renderPage()

    expect(
      await screen.findByText('Unable to load this group.'),
    ).toBeInTheDocument()
  })

  it('previews an equal split that adds up to the exact total', async () => {
    seedGroup()
    const user = userEvent.setup()
    renderPage()

    await user.type(await screen.findByLabelText(/^Amount/), '10')

    expect(screen.getByText('$3.34')).toBeInTheDocument()
    expect(screen.getAllByText('$3.33')).toHaveLength(2)
  })

  it('submits integer-cent-safe values to the create_equal_split_expense RPC', async () => {
    seedGroup()
    const user = userEvent.setup()
    renderPage()

    await screen.findByRole('button', { name: 'Create expense' })
    await fillAndSubmit(user, '10.50')

    await waitFor(() => expect(supabaseMock.rpc).toHaveBeenCalledOnce())

    const [name, args] = supabaseMock.rpc.mock.calls[0]

    expect(name).toBe('create_equal_split_expense')
    expect(args).toMatchObject({
      p_group_id: 'g1',
      p_description: 'Dinner',
      p_amount: 10.5,
      p_paid_by: 'u1',
      p_participant_ids: ['u1', 'u2', 'u3'],
      p_notes: null,
    })

    expect(
      await screen.findByText(
        'Expense created successfully and split between 3 people.',
      ),
    ).toBeInTheDocument()
  })

  it('blocks submission when no participant is selected', async () => {
    seedGroup()
    const user = userEvent.setup()
    renderPage()

    await screen.findByRole('button', { name: 'Create expense' })
    await user.click(screen.getByRole('button', { name: 'Clear' }))
    await fillAndSubmit(user, '10')

    expect(
      await screen.findByText('Please select at least one participant.'),
    ).toBeInTheDocument()
    expect(supabaseMock.rpc).not.toHaveBeenCalled()
  })

  it('blocks submission when the amount is too small to split', async () => {
    seedGroup()
    const user = userEvent.setup()
    renderPage()

    await screen.findByRole('button', { name: 'Create expense' })
    await fillAndSubmit(user, '0.02')

    expect(
      await screen.findByText(
        'The amount is too small to split between the selected participants.',
      ),
    ).toBeInTheDocument()
    expect(supabaseMock.rpc).not.toHaveBeenCalled()
  })

  it('never calls the RPC for more than two decimal places', async () => {
    // The browser's step="0.01" constraint stops this before our own
    // validation runs (which is covered in expenseSplit.test.ts).
    seedGroup()
    const user = userEvent.setup()
    renderPage()

    await screen.findByRole('button', { name: 'Create expense' })
    await fillAndSubmit(user, '10.555')

    expect(supabaseMock.rpc).not.toHaveBeenCalled()
  })

  it('shows the RPC error message and keeps the form values', async () => {
    seedGroup()
    supabaseMock.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'You are not a member of this group' },
    })
    const user = userEvent.setup()
    renderPage()

    await screen.findByRole('button', { name: 'Create expense' })
    await fillAndSubmit(user, '10')

    expect(
      await screen.findByText('You are not a member of this group'),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Description')).toHaveValue('Dinner')
  })
})
