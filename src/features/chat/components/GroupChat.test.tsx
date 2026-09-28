import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSupabaseMock } from '../../../test/supabaseMock'
import { GroupChat } from './GroupChat'

const mock = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('../../../shared/api/supabase', () => ({
  get supabase() {
    return (mock.current as ReturnType<typeof createSupabaseMock>).client
  },
}))

let supabaseMock: ReturnType<typeof createSupabaseMock>

const G = '10000000-0000-4000-8000-000000000001'
const ME = 'u1'
const row = (id: number, sender: string, body: string, createdAt: string, rid = `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`) => ({
  id, group_id: G, sender_id: sender, body, client_request_id: rid, created_at: createdAt,
})
const now = new Date()
const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString()

function seed(rows = [row(2, 'u2', 'Rent is due Friday', at(10)), row(1, ME, 'Who has the bond receipt?', at(20))]) {
  supabaseMock.setTable('group_messages', rows) // newest first, as the query orders
  supabaseMock.setTable('profiles', [{ id: 'u1', full_name: 'Alice' }, { id: 'u2', full_name: 'Bob' }])
}

const messageQueries = () => supabaseMock.queries.filter((q) => q.table === 'group_messages')
const sendCalls = () => supabaseMock.rpc.mock.calls.filter(([name]) => name === 'send_group_message')
const log = () => screen.getByRole('log', { name: 'Messages' })

beforeEach(() => {
  supabaseMock = createSupabaseMock()
  mock.current = supabaseMock
  seed()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GroupChat', () => {
  it('shows the newest messages oldest first, with senders and "You" for my own', async () => {
    render(<GroupChat groupId={G} userId={ME} />)

    const messages = await screen.findByRole('log', { name: 'Messages' })
    const texts = within(messages).getAllByRole('listitem').map((li) => li.textContent)
    expect(texts[0]).toMatch(/You.*Who has the bond receipt\?/)
    expect(texts[1]).toMatch(/Bob.*Rent is due Friday/)
    const filters = messageQueries()[0].calls.filter((c) => c.method === 'eq')
    expect(filters).toEqual([{ method: 'eq', args: ['group_id', G] }])
  })

  it('renders message text as text, never as HTML', async () => {
    seed([row(1, 'u2', '<img src=x onerror=alert(1)> **bold**', at(1))])
    render(<GroupChat groupId={G} userId={ME} />)

    expect(await screen.findByText('<img src=x onerror=alert(1)> **bold**')).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
  })

  it('sends through the RPC, shows it at once, and shows it once when Realtime echoes it', async () => {
    const user = userEvent.setup()
    type RpcResult = { data: unknown; error: { message: string } | null }
    let resolveSend: (v: RpcResult) => void = () => {}
    supabaseMock.rpc.mockImplementation((name) =>
      name === 'send_group_message'
        ? new Promise<RpcResult>((r) => (resolveSend = r))
        : Promise.resolve({ data: [], error: null }),
    )
    render(<GroupChat groupId={G} userId={ME} />)
    await screen.findByRole('log')

    await user.type(screen.getByLabelText('Message'), '  Dinner 84.50 split with Bob  ')
    await user.click(screen.getByRole('button', { name: 'Send' }))

    expect(screen.getByText('Sending…')).toBeInTheDocument()
    expect(screen.getByLabelText('Message')).toHaveValue('')
    const [, args] = sendCalls()[0]
    expect(args).toMatchObject({ p_group_id: G, p_body: 'Dinner 84.50 split with Bob' })
    const sent = row(3, ME, 'Dinner 84.50 split with Bob', at(0), args.p_client_request_id as string)

    act(() => supabaseMock.emit(sent))
    await act(async () => resolveSend({ data: sent, error: null }))

    expect(within(log()).getAllByText('Dinner 84.50 split with Bob')).toHaveLength(1)
    expect(screen.queryByText('Sending…')).not.toBeInTheDocument()
  })

  it('offers Retry for a failed send and retries with the same request id', async () => {
    const user = userEvent.setup()
    supabaseMock.setRpc('send_group_message', null, { message: 'rate_limited' })
    render(<GroupChat groupId={G} userId={ME} />)
    await screen.findByRole('log')

    await user.type(screen.getByLabelText('Message'), 'Hello')
    await user.click(screen.getByRole('button', { name: 'Send' }))

    expect(await screen.findByText(/Not sent\. You are sending messages too quickly/)).toBeInTheDocument()
    supabaseMock.setRpc('send_group_message', row(3, ME, 'Hello', at(0), sendCalls()[0][1].p_client_request_id as string))
    await user.click(screen.getByRole('button', { name: 'Retry sending “Hello”' }))

    await waitFor(() => expect(screen.queryByText(/Not sent/)).not.toBeInTheDocument())
    expect(sendCalls()).toHaveLength(2)
    expect(sendCalls()[1][1].p_client_request_id).toBe(sendCalls()[0][1].p_client_request_id)
    expect(within(log()).getAllByText('Hello')).toHaveLength(1)
  })

  it('refuses an empty message without calling the server', async () => {
    const user = userEvent.setup()
    render(<GroupChat groupId={G} userId={ME} />)
    await screen.findByRole('log')

    await user.type(screen.getByLabelText('Message'), '   ')
    await user.click(screen.getByRole('button', { name: 'Send' }))

    expect(screen.getByText('Write a message first.')).toBeInTheDocument()
    expect(screen.getByLabelText('Message')).toHaveAttribute('aria-invalid', 'true')
    expect(sendCalls()).toHaveLength(0)
  })

  it('shows messages from others as they arrive, subscribed to this group only', async () => {
    render(<GroupChat groupId={G} userId={ME} />)
    await screen.findByRole('log')

    expect(supabaseMock.channels[0].filter).toMatchObject({ event: 'INSERT', table: 'group_messages', filter: `group_id=eq.${G}` })
    act(() => supabaseMock.emit(row(9, 'u2', 'On my way', at(0))))
    expect(await within(log()).findByText('On my way')).toBeInTheDocument()
  })

  it('fetches the truth instead of trusting a malformed or foreign payload', async () => {
    render(<GroupChat groupId={G} userId={ME} />)
    await screen.findByRole('log')
    const before = messageQueries().length

    act(() => supabaseMock.emit({ id: 'not-a-number', body: 'x' }))
    act(() => supabaseMock.emit({ ...row(10, 'u2', 'Other group', at(0)), group_id: '10000000-0000-4000-8000-000000000002' }))

    await waitFor(() => expect(messageQueries().length).toBeGreaterThan(before))
    expect(screen.queryByText('Other group')).not.toBeInTheDocument()
  })

  it('says live updates are paused while disconnected, and catches up when reconnected', async () => {
    render(<GroupChat groupId={G} userId={ME} />)
    await screen.findByRole('log')

    act(() => supabaseMock.setStatus('CHANNEL_ERROR'))
    expect(screen.getByText(/Live updates paused/)).toBeInTheDocument()

    const before = messageQueries().length
    supabaseMock.setTable('group_messages', [row(4, 'u2', 'Missed while offline', at(1)), row(2, 'u2', 'Rent is due Friday', at(10))])
    act(() => supabaseMock.setStatus('SUBSCRIBED'))

    expect(await within(log()).findByText('Missed while offline')).toBeInTheDocument()
    expect(messageQueries().length).toBeGreaterThan(before)
    expect(screen.queryByText(/Live updates paused/)).not.toBeInTheDocument()
  })

  it('loads earlier messages on request with a keyset cursor', async () => {
    const user = userEvent.setup()
    const rows = Array.from({ length: 31 }, (_, i) => row(100 - i, 'u2', `m${100 - i}`, at(i + 1)))
    seed(rows)
    render(<GroupChat groupId={G} userId={ME} />)
    await screen.findByRole('log')
    expect(within(log()).queryByText('m70')).not.toBeInTheDocument()

    seed([row(69, 'u2', 'm69', at(40))])
    await user.click(screen.getByRole('button', { name: 'Load earlier messages' }))

    expect(await within(log()).findByText('m69')).toBeInTheDocument()
    const older = messageQueries().at(-1)!.calls.find((c) => c.method === 'or')
    expect(older?.args[0]).toMatch(/^created_at\.lt\."[^"]+",and\(created_at\.eq\."[^"]+",id\.lt\.71\)$/)
    expect(screen.queryByRole('button', { name: 'Load earlier messages' })).not.toBeInTheDocument()
  })

  it('stops offering the composer once the server says I am no longer a member', async () => {
    const user = userEvent.setup()
    supabaseMock.setRpc('send_group_message', null, { message: 'not_found_or_forbidden' })
    render(<GroupChat groupId={G} userId={ME} />)
    await screen.findByRole('log')

    await user.type(screen.getByLabelText('Message'), 'Hello?')
    await user.click(screen.getByRole('button', { name: 'Send' }))

    expect(await screen.findByText('You are no longer a member of this group, so you cannot send messages here.', { selector: 'div' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument()
  })

  it('sends with Enter on a keyboard device; Shift+Enter adds a line', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(pointer: fine)' }))
    const user = userEvent.setup()
    supabaseMock.setRpc('send_group_message', row(5, ME, 'a\nb', at(0)))
    render(<GroupChat groupId={G} userId={ME} />)
    await screen.findByRole('log')

    await user.type(screen.getByLabelText('Message'), 'a{Shift>}{Enter}{/Shift}b')
    expect(sendCalls()).toHaveLength(0)
    await user.keyboard('{Enter}')
    expect(sendCalls()[0][1].p_body).toBe('a\nb')
  })

  it('shows a friendly empty state', async () => {
    seed([])
    render(<GroupChat groupId={G} userId={ME} />)
    expect(await screen.findByText('No messages yet')).toBeInTheDocument()
  })

  it('never queries for a malformed group id', async () => {
    render(<GroupChat groupId="nonsense" userId={ME} />)
    expect(await screen.findByText('Chat unavailable')).toBeInTheDocument()
    expect(messageQueries()).toHaveLength(0)
    expect(supabaseMock.channels).toHaveLength(0)
  })

  it('unsubscribes when it goes away', async () => {
    const { unmount } = render(<GroupChat groupId={G} userId={ME} />)
    await screen.findByRole('log')
    unmount()
    expect(supabaseMock.channels[0].removed).toBe(true)
  })
})
