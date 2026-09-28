import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { localIsoDate } from '../../../shared/domain/dates'
import { createSupabaseMock } from '../../../test/supabaseMock'
import type { GroupDetail } from '../../groups'
import { SmartChat } from './SmartChat'

const mock = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('../../../shared/api/supabase', () => ({
  get supabase() {
    return (mock.current as ReturnType<typeof createSupabaseMock>).client
  },
}))

let supabaseMock: ReturnType<typeof createSupabaseMock>

const G = '10000000-0000-4000-8000-000000000001'
const P = '00000000-0000-4000-8000-00000000000a' // Priya (owner in some tests)
const S = '00000000-0000-4000-8000-00000000000b' // Sam
const J = '00000000-0000-4000-8000-00000000000c' // Jo
const now = new Date().toISOString()
const today = localIsoDate() // the sender's local date, as the app uses

const group = (myRole: 'owner' | 'member'): GroupDetail => ({
  id: G,
  name: 'Flat',
  description: null,
  createdAt: now,
  myRole,
  members: [
    { userId: P, fullName: 'Priya Raman', role: myRole === 'owner' ? 'owner' : 'member', joinedAt: now },
    { userId: S, fullName: 'Sam Lee', role: myRole === 'owner' ? 'member' : 'owner', joinedAt: now },
    { userId: J, fullName: 'Jo Nguyen', role: 'member', joinedAt: now },
  ],
})

const message = (id: number, sender: string, body: string, rid = `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`) => ({
  id, group_id: G, sender_id: sender, body, client_request_id: rid, created_at: now,
})
const candidate = (over: Record<string, unknown> = {}) => ({
  id: 'c1', group_id: G, message_id: 1, proposed_by: P, status: 'proposed', source: 'natural',
  interpreter_version: 'deterministic-1', description: 'lunch', amount_cents: 3000, expense_date: today,
  paid_by: P, participant_ids: [P, S, J], notes: null, version: 1, expense_id: null, decided_by: null, created_at: now,
  ...over,
})

function renderChat(myRole: 'owner' | 'member' = 'member', userId = P) {
  return render(
    <MemoryRouter>
      <SmartChat group={group(myRole)} userId={userId} />
    </MemoryRouter>,
  )
}
const rpcCalls = (name: string) => supabaseMock.rpc.mock.calls.filter(([n]) => n === name)

beforeEach(() => {
  supabaseMock = createSupabaseMock()
  mock.current = supabaseMock
  supabaseMock.setTable('profiles', [{ id: P, full_name: 'Priya Raman' }, { id: S, full_name: 'Sam Lee' }, { id: J, full_name: 'Jo Nguyen' }])
  supabaseMock.setTable('group_messages', [message(1, P, 'I paid $30 for lunch, split with everyone')])
  supabaseMock.setTable('expense_candidates', [candidate()])
})

describe('Smart Expense in chat', () => {
  it('shows a proposal as its own card after the message, not inside the bubble', async () => {
    renderChat()
    const card = await screen.findByRole('article', { name: 'Expense proposal: Ready to review' })
    expect(card.closest('li')).not.toContainElement(screen.getByText('I paid $30 for lunch, split with everyone'))
    expect(within(card).getByText('$30.00')).toBeInTheDocument()
    expect(within(card).getByText('You, Sam Lee, Jo Nguyen')).toBeInTheDocument()
  })

  it('pins the proposals I can act on above the messages and jumps to a card', async () => {
    const user = userEvent.setup()
    renderChat()
    const strip = await screen.findByRole('navigation', { name: '1 open proposal needs you' })
    await user.click(within(strip).getByRole('button', { name: /lunch \$30\.00/ }))
    expect(screen.getByRole('article', { name: /Expense proposal/ })).toHaveFocus()
  })

  it('pins nothing for a member who cannot act on the proposal', async () => {
    renderChat('member', J)
    await screen.findByRole('article', { name: /Expense proposal/ })
    expect(screen.queryByRole('navigation', { name: /open proposal/ })).not.toBeInTheDocument()
  })

  it('never proposes from history: loading the chat calls no propose RPC', async () => {
    supabaseMock.setTable('expense_candidates', [])
    renderChat()
    await screen.findByText('I paid $30 for lunch, split with everyone')
    await waitFor(() => expect(supabaseMock.queries.some((q) => q.table === 'expense_candidates')).toBe(true))
    expect(rpcCalls('propose_expense_candidate')).toHaveLength(0)
  })

  it('proposes the interpreted draft for a message I just sent', async () => {
    const user = userEvent.setup()
    supabaseMock.setTable('group_messages', [])
    supabaseMock.setTable('expense_candidates', [])
    supabaseMock.rpc.mockImplementation((name, args) => {
      if (name === 'send_group_message') return Promise.resolve({ data: message(7, P, args.p_body as string, args.p_client_request_id as string), error: null })
      if (name === 'propose_expense_candidate') return Promise.resolve({ data: candidate({ id: 'c7', message_id: 7 }), error: null })
      return Promise.resolve({ data: [], error: null })
    })
    renderChat()
    await screen.findByText('No messages yet')

    await user.type(screen.getByLabelText('Message'), 'Sam paid $45.20 for dinner, split with Jo')
    await user.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(rpcCalls('propose_expense_candidate')).toHaveLength(1))
    expect(rpcCalls('propose_expense_candidate')[0][1]).toEqual({
      p_message_id: 7, p_source: 'natural', p_interpreter_version: 'deterministic-1',
      p_description: 'dinner', p_amount_cents: 4520, p_expense_date: today, p_paid_by: S, p_participant_ids: [P, J], p_notes: null,
    })
    expect(await screen.findByRole('article', { name: /Expense proposal/ })).toBeInTheDocument()
  })

  it('does not propose for an ordinary message', async () => {
    const user = userEvent.setup()
    supabaseMock.setTable('group_messages', [])
    supabaseMock.rpc.mockImplementation((name, args) =>
      Promise.resolve(name === 'send_group_message'
        ? { data: message(8, P, args.p_body as string, args.p_client_request_id as string), error: null }
        : { data: [], error: null }),
    )
    renderChat()
    await screen.findByText('No messages yet')
    await user.type(screen.getByLabelText('Message'), 'See you at 7?')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(rpcCalls('send_group_message')).toHaveLength(1))
    expect(rpcCalls('propose_expense_candidate')).toHaveLength(0)
  })

  it('shows what is missing and blocks adding an incomplete proposal', async () => {
    supabaseMock.setTable('group_messages', [message(1, P, 'Dinner cost $60, split with Sam')])
    supabaseMock.setTable('expense_candidates', [candidate({ paid_by: null, description: null })])
    renderChat()
    const card = await screen.findByRole('article', { name: 'Expense proposal: Needs details' })
    expect(within(card).getAllByText('Not set')).toHaveLength(2)
    expect(within(card).getByText('— add who paid')).toBeInTheDocument()
    // Only the usable action leads; the approval path appears once complete.
    expect(within(card).queryByRole('button', { name: 'Review and add' })).not.toBeInTheDocument()
    expect(within(card).getByRole('link', { name: 'Add details' })).toHaveAttribute('href', `/groups/${G}/proposals/c1/edit`)
    expect(within(card).getByText('To add it, fill in: what it was for, who paid.')).toBeInTheDocument()
  })

  it('explains an ambiguous name from the message', async () => {
    supabaseMock.setTable('group_messages', [message(1, P, '/expense 30 lunch paid:Sam split:all')])
    supabaseMock.setTable('expense_candidates', [candidate({ paid_by: null })])
    const twins = group('member')
    twins.members.push({ userId: 'id-sam-park', fullName: 'Sam Park', role: 'member', joinedAt: now })
    render(
      <MemoryRouter>
        <SmartChat group={twins} userId={P} />
      </MemoryRouter>,
    )
    expect(await screen.findByText('— Choose: Sam Lee or Sam Park')).toBeInTheDocument()
  })

  it('confirms with the amount and each share before adding, with Cancel focused', async () => {
    const user = userEvent.setup()
    let resolveApprove: (v: { data: unknown; error: null }) => void = () => {}
    supabaseMock.rpc.mockImplementation((name) =>
      name === 'approve_expense_candidate' ? new Promise((r) => (resolveApprove = r)) : Promise.resolve({ data: [], error: null }),
    )
    renderChat()
    const card = await screen.findByRole('article', { name: /Expense proposal/ })

    await user.click(within(card).getByRole('button', { name: 'Review and add' }))

    const confirm = within(card).getByRole('group', { name: 'Confirm the expense' })
    expect(within(confirm).getByText('Add this $30.00 expense?')).toBeInTheDocument()
    expect(within(confirm).getByText(/“lunch” on .*, paid by You/)).toBeInTheDocument()
    const shares = within(confirm).getByRole('list', { name: 'Each person’s share' })
    expect(within(shares).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['You$10.00', 'Sam Lee$10.00', 'Jo Nguyen$10.00'])
    expect(within(confirm).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    expect(rpcCalls('approve_expense_candidate')).toHaveLength(0)

    // Escape cancels and returns focus to the trigger; nothing is approved.
    await user.keyboard('{Escape}')
    expect(within(card).getByRole('button', { name: 'Review and add' })).toHaveFocus()
    expect(rpcCalls('approve_expense_candidate')).toHaveLength(0)
    await user.click(within(card).getByRole('button', { name: 'Review and add' }))
    const confirmAgain = within(card).getByRole('group', { name: 'Confirm the expense' })
    expect(within(confirmAgain).getByRole('button', { name: 'Cancel' })).toHaveFocus()

    await user.click(within(confirmAgain).getByRole('button', { name: 'Add expense' }))
    expect(within(confirmAgain).getByRole('button', { name: 'Adding…' })).toBeDisabled()
    expect(rpcCalls('approve_expense_candidate')[0][1]).toEqual({ p_id: 'c1', p_expected_version: 1 })

    supabaseMock.setTable('expense_candidates', [candidate({ status: 'approved', expense_id: 'x9', decided_by: P, version: 2 })])
    await act(async () => resolveApprove({ data: 'x9', error: null }))
    const done = await screen.findByRole('article', { name: 'Expense proposal: Expense added' })
    expect(within(done).getByRole('link', { name: 'View expense' })).toHaveAttribute('href', '/expenses/x9')
  })

  it('shows no actions to a member who is neither the proposer nor the owner', async () => {
    renderChat('member', J)
    const card = await screen.findByRole('article', { name: /Expense proposal/ })
    expect(within(card).queryByRole('button')).not.toBeInTheDocument()
    expect(within(card).getByText('Waiting for Priya Raman or the group owner to review it.')).toBeInTheDocument()
  })

  it('lets the owner act on someone else’s proposal', async () => {
    supabaseMock.setTable('expense_candidates', [candidate({ proposed_by: S })])
    renderChat('owner', P)
    const card = await screen.findByRole('article', { name: /Expense proposal/ })
    expect(within(card).getByRole('button', { name: 'Review and add' })).toBeEnabled()
  })

  it('rejects only after a confirmation', async () => {
    const user = userEvent.setup()
    renderChat()
    const card = await screen.findByRole('article', { name: /Expense proposal/ })
    await user.click(within(card).getByRole('button', { name: 'Reject' }))
    expect(rpcCalls('reject_expense_candidate')).toHaveLength(0)
    await user.click(within(card).getByRole('button', { name: 'Reject proposal' }))
    await waitFor(() => expect(rpcCalls('reject_expense_candidate')[0][1]).toEqual({ p_id: 'c1', p_expected_version: 1 }))
  })

  it('offers no way to leave for the editor while a decision is in flight', async () => {
    const user = userEvent.setup()
    let finish: (value: { data: null; error: null }) => void = () => {}
    renderChat()
    const card = await screen.findByRole('article', { name: /Expense proposal/ })
    expect(within(card).getByRole('link', { name: 'Edit' })).toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: 'Reject' }))
    supabaseMock.rpc.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    await user.click(within(card).getByRole('button', { name: 'Reject proposal' }))
    expect(await within(card).findByRole('button', { name: 'Edit' })).toBeDisabled()
    expect(within(card).queryByRole('link', { name: 'Edit' })).not.toBeInTheDocument()
    await act(async () => finish({ data: null, error: null }))
    expect(await within(card).findByRole('link', { name: 'Edit' })).toBeInTheDocument()
  })

  it('shows a decision made elsewhere as it arrives', async () => {
    renderChat('member', J)
    await screen.findByRole('article', { name: 'Expense proposal: Ready to review' })
    act(() => supabaseMock.emit(candidate({ status: 'rejected', decided_by: P, version: 2 }), 'expense-candidates'))
    expect(await screen.findByRole('article', { name: 'Expense proposal: Rejected' })).toBeInTheDocument()
    expect(screen.getByText('Rejected by Priya Raman. Nothing was added.')).toBeInTheDocument()
  })

  it('ignores an older version arriving late', async () => {
    supabaseMock.setTable('expense_candidates', [candidate({ status: 'rejected', decided_by: P, version: 2 })])
    renderChat()
    await screen.findByRole('article', { name: 'Expense proposal: Rejected' })
    act(() => supabaseMock.emit(candidate({ version: 1 }), 'expense-candidates'))
    expect(screen.getByRole('article', { name: 'Expense proposal: Rejected' })).toBeInTheDocument()
  })

  it('offers "Record as expense" on my own message with a number and no proposal', async () => {
    const user = userEvent.setup()
    supabaseMock.setTable('group_messages', [message(1, P, 'Groceries were 96.30 today')])
    supabaseMock.setTable('expense_candidates', [])
    supabaseMock.setRpc('propose_expense_candidate', candidate({ source: 'manual', description: null, amount_cents: null, paid_by: null, participant_ids: null }))
    renderChat()
    await user.click(await screen.findByRole('button', { name: 'Record as expense' }))
    expect(rpcCalls('propose_expense_candidate')[0][1]).toMatchObject({ p_message_id: 1, p_source: 'manual', p_amount_cents: null, p_paid_by: null })
    expect(await screen.findByRole('article', { name: 'Expense proposal: Needs details' })).toBeInTheDocument()
  })
})
