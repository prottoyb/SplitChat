import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSupabaseMock } from '../../../test/supabaseMock'
import GroupBalancesPage from './GroupBalancesPage'

const mock = vi.hoisted(() => ({ current: null as unknown, userId: 'u2' }))

vi.mock('../../../shared/api/supabase', () => ({
  get supabase() {
    return (mock.current as ReturnType<typeof createSupabaseMock>).client
  },
}))

vi.mock('../../auth/useAuth', () => ({
  useAuth: () => ({ session: { user: { id: mock.userId } } }),
}))

let supabaseMock: ReturnType<typeof createSupabaseMock>

const balance = (user_id: string, paid: number, owed: number, out = 0, inn = 0) => ({
  user_id, paid_cents: paid, owed_cents: owed, settled_out_cents: out, settled_in_cents: inn, net_cents: paid - owed + out - inn,
})

// Alice (u1, owner) is owed 46.66; Bob (u2) owes 43.33; Eve (u5) has left
// and owes 3.33. Bob once paid Alice 10.00 and it was voided.
function seed() {
  supabaseMock.setTable('groups', [{ id: 'g1', name: 'Flat', description: null, created_at: '2026-09-01T00:00:00Z' }])
  supabaseMock.setTable('group_members', [
    { group_id: 'g1', user_id: 'u1', role: 'owner', joined_at: '2026-09-01T00:00:00Z' },
    { group_id: 'g1', user_id: 'u2', role: 'member', joined_at: '2026-09-02T00:00:00Z' },
  ])
  supabaseMock.setTable('profiles', [{ id: 'u1', full_name: 'Alice' }, { id: 'u2', full_name: 'Bob' }])
  supabaseMock.setRpc('get_ledger_identities', [{ user_id: 'u5', display_name: 'Eve' }])
  supabaseMock.setRpc('get_group_balances', [balance('u1', 10000, 5334), balance('u2', 1000, 5333), balance('u5', 0, 333)])
  supabaseMock.setTable('settlements', [
    {
      id: 's1', from_user: 'u2', to_user: 'u1', amount_cents: 1000, settled_on: '2026-09-20', note: 'Cash',
      created_by: 'u2', created_at: '2026-09-20T10:00:00Z', voided_at: '2026-09-21T10:00:00Z', voided_by: 'u1',
      void_reason: 'Recorded twice',
    },
  ])
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/groups/g1/balances']}>
      <Routes>
        <Route path="groups/:groupId/balances" element={<GroupBalancesPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

const recordCalls = () => supabaseMock.rpc.mock.calls.filter(([name]) => name === 'record_settlement')

beforeEach(() => {
  supabaseMock = createSupabaseMock()
  mock.current = supabaseMock
  mock.userId = 'u2'
  seed()
})

describe('GroupBalancesPage', () => {
  it('shows my position, everyone’s balance and the fewest payments to settle up', async () => {
    renderPage()

    expect(await screen.findByText('You owe $43.33')).toBeInTheDocument()
    const balances = screen.getByRole('list', { name: 'Balances' })
    expect(within(balances).getByText('is owed $46.66')).toBeInTheDocument()
    expect(within(balances).getByText('Former member')).toBeInTheDocument()
    const plan = screen.getByRole('list', { name: 'Suggested payments' })
    const items = within(plan).getAllByRole('listitem')
    expect(items.map((li) => li.textContent)).toEqual([expect.stringMatching(/^You pay Alice \$43\.33Record$/), 'Eve pays Alice $3.33'])
  })

  it('records a partial payment through the server with a request id, then reloads', async () => {
    const user = userEvent.setup()
    supabaseMock.setRpc('record_settlement', 'new-id')
    renderPage()
    const form = await screen.findByRole('form', { name: 'Record a payment' })

    expect(within(form).getByLabelText('Paid by')).toHaveValue('u2')
    expect(within(form).getByLabelText('Paid to')).toHaveValue('u1')
    expect(within(form).getByText('Up to $43.33. Part payments are fine.')).toBeInTheDocument()
    await user.type(within(form).getByLabelText('Amount'), '10.50')
    await user.type(within(form).getByLabelText('Note (optional)'), ' transfer ')
    await user.click(within(form).getByRole('button', { name: 'Record payment' }))

    expect(await screen.findByText('Payment of $10.50 recorded.')).toBeInTheDocument()
    const [, args] = recordCalls()[0]
    expect(args).toMatchObject({ p_group_id: 'g1', p_from_user: 'u2', p_to_user: 'u1', p_amount_cents: 1050, p_note: 'transfer' })
    expect(args.p_client_request_id).toMatch(/^[0-9a-f-]{36}$/)
    await waitFor(() => expect(supabaseMock.rpc.mock.calls.filter(([n]) => n === 'get_group_balances')).toHaveLength(2))
  })

  it('refuses more than is owed before calling the server', async () => {
    const user = userEvent.setup()
    renderPage()
    const form = await screen.findByRole('form', { name: 'Record a payment' })

    await user.type(within(form).getByLabelText('Amount'), '43.34')
    await user.click(within(form).getByRole('button', { name: 'Record payment' }))

    expect(within(form).getByText('That is more than is owed. The most that can be paid is $43.33.')).toBeInTheDocument()
    expect(within(form).getByLabelText('Amount')).toHaveAttribute('aria-invalid', 'true')
    expect(recordCalls()).toHaveLength(0)
  })

  it('explains a server-side balance conflict and offers a reload; a retry reuses the request id', async () => {
    const user = userEvent.setup()
    supabaseMock.setRpc('record_settlement', null, { message: 'exceeds_balance' })
    renderPage()
    const form = await screen.findByRole('form', { name: 'Record a payment' })
    await user.type(within(form).getByLabelText('Amount'), '5')
    await user.click(within(form).getByRole('button', { name: 'Record payment' }))

    expect(await screen.findByText(/more than is owed right now/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reload balances' })).toBeInTheDocument()

    await user.click(within(form).getByRole('button', { name: 'Record payment' }))
    await waitFor(() => expect(recordCalls()).toHaveLength(2))
    expect(recordCalls()[1][1].p_client_request_id).toBe(recordCalls()[0][1].p_client_request_id)
  })

  it('prefills the form from a suggested payment', async () => {
    const user = userEvent.setup()
    mock.userId = 'u1' // the owner can record any suggested payment
    renderPage()
    const plan = await screen.findByRole('list', { name: 'Suggested payments' })
    const recordButtons = within(plan).getAllByRole('button', { name: 'Record' })
    expect(recordButtons).toHaveLength(2)

    await user.click(recordButtons[1])

    const form = screen.getByRole('form', { name: 'Record a payment' })
    expect(within(form).getByLabelText('Paid by')).toHaveValue('u5')
    expect(within(form).getByLabelText('Amount')).toHaveValue('3.33')
  })

  it('lists voided payments with who voided them and why', async () => {
    renderPage()
    const history = await screen.findByRole('list', { name: 'Payment history' })
    expect(within(history).getByText('Voided')).toBeInTheDocument()
    expect(within(history).getByText('Voided by Alice: Recorded twice')).toBeInTheDocument()
    expect(within(history).queryByRole('button', { name: 'Void' })).not.toBeInTheDocument()
  })

  it('voids a payment with a required reason', async () => {
    const user = userEvent.setup()
    supabaseMock.setTable('settlements', [
      {
        id: 's2', from_user: 'u2', to_user: 'u1', amount_cents: 700, settled_on: '2026-09-22', note: null,
        created_by: 'u1', created_at: '2026-09-22T10:00:00Z', voided_at: null, voided_by: null, void_reason: null,
      },
    ])
    renderPage()
    const history = await screen.findByRole('list', { name: 'Payment history' })
    expect(within(history).getByText(/recorded by Alice/)).toBeInTheDocument()

    await user.click(within(history).getByRole('button', { name: 'Void' }))
    await user.click(within(history).getByRole('button', { name: 'Void payment' }))
    expect(within(history).getByText('Please say why this payment is being voided.')).toBeInTheDocument()

    await user.type(within(history).getByLabelText('Why is this payment being voided?'), ' Wrong amount ')
    await user.click(within(history).getByRole('button', { name: 'Void payment' }))

    expect(await screen.findByText(/Payment of \$7\.00 voided/)).toBeInTheDocument()
    expect(supabaseMock.rpc).toHaveBeenCalledWith('void_settlement', { p_settlement_id: 's2', p_reason: 'Wrong amount' })
  })

  it('tells a settled member there is nothing of theirs to record', async () => {
    supabaseMock.setRpc('get_group_balances', [balance('u1', 333, 0), balance('u5', 0, 333)])
    renderPage()
    expect(await screen.findByText('You are settled up')).toBeInTheDocument()
    expect(screen.getByText('You are settled up, so there is no payment of yours to record.')).toBeInTheDocument()
  })

  it('shows an actionable error when balances cannot be loaded', async () => {
    supabaseMock.setRpc('get_group_balances', [balance('u1', 100, 0)]) // does not net to zero
    renderPage()
    expect(await screen.findByText('Balances unavailable')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '← Back to group' })).toHaveAttribute('href', '/groups/g1')
  })
})
