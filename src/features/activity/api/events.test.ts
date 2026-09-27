import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSupabaseMock } from '../../../test/supabaseMock'
import { appendPage, isValidCursor, listActivity } from './events'

const mock = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('../../../shared/api/supabase', () => ({
  get supabase() {
    return (mock.current as ReturnType<typeof createSupabaseMock>).client
  },
}))

let supabaseMock: ReturnType<typeof createSupabaseMock>

const row = (id: number, fields: Record<string, unknown> = {}) => ({
  id, group_id: 'g1', kind: 'expense_created', actor_id: 'u1', subject_id: 'x1', subject_user_id: null,
  people: ['u1', 'u5'], payload: { v: 1, amount_cents: 100 }, backfilled: false,
  created_at: `2026-09-27T10:00:0${id}.123456+00:00`, ...fields,
})

beforeEach(() => {
  supabaseMock = createSupabaseMock()
  mock.current = supabaseMock
  supabaseMock.setTable('groups', [{ id: 'g1', name: 'Flat' }])
  supabaseMock.setTable('expenses', [{ id: 'x1', description: 'Dinner' }])
  supabaseMock.setTable('profiles', [{ id: 'u1', full_name: 'Alice' }])
  supabaseMock.setRpc('get_ledger_identities', [{ user_id: 'u5', display_name: 'Deleted user' }])
})

const callsOn = (table: string) => supabaseMock.queries.filter((q) => q.table === table).flatMap((q) => q.calls)

describe('listActivity', () => {
  it('reads newest first with a bounded page and resolves names, groups and titles', async () => {
    supabaseMock.setTable('group_events', [row(3), row(2), row(1)])

    const result = await listActivity({ limit: 2 })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.events.map((e) => e.id)).toEqual([3, 2])
    expect(result.value.next).toEqual({ createdAt: '2026-09-27T10:00:02.123456+00:00', id: 2 })
    expect(result.value.names.get('u5')).toBe('Deleted user')
    expect(result.value.groupNames.get('g1')).toBe('Flat')
    expect(result.value.expenseTitles.get('x1')).toBe('Dinner')
    const calls = callsOn('group_events')
    expect(calls).toContainEqual({ method: 'order', args: ['created_at', { ascending: false }] })
    expect(calls).toContainEqual({ method: 'order', args: ['id', { ascending: false }] })
    expect(calls).toContainEqual({ method: 'limit', args: [3] })
  })

  it('continues after a cursor with a quoted keyset filter, optionally for one group', async () => {
    supabaseMock.setTable('group_events', [row(1)])

    const result = await listActivity({ groupId: 'g1', before: { createdAt: '2026-09-27T10:00:02.5+00:00', id: 2 } })

    expect(result.ok && result.value.next).toBeNull()
    const calls = callsOn('group_events')
    expect(calls).toContainEqual({ method: 'eq', args: ['group_id', 'g1'] })
    expect(calls).toContainEqual({
      method: 'or',
      args: ['created_at.lt."2026-09-27T10:00:02.5+00:00",and(created_at.eq."2026-09-27T10:00:02.5+00:00",id.lt.2)'],
    })
  })

  it('caps the page size', async () => {
    supabaseMock.setTable('group_events', [])
    await listActivity({ limit: 10_000 })
    expect(callsOn('group_events')).toContainEqual({ method: 'limit', args: [51] })
  })

  it('treats a malformed payload as empty and never fails on it', async () => {
    supabaseMock.setTable('group_events', [row(1, { payload: null, people: null })])
    const result = await listActivity()
    expect(result.ok && result.value.events[0]).toMatchObject({ payload: {}, people: [] })
  })

  it('returns a safe failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    supabaseMock.setTable('group_events', null, { message: 'permission denied for table group_events' })
    await expect(listActivity()).resolves.toEqual({ ok: false, code: 'unknown', message: 'Unable to load recent activity.' })
  })
})

describe('appendPage', () => {
  it('merges pages without duplicating events', async () => {
    supabaseMock.setTable('group_events', [row(3), row(2)])
    const first = await listActivity({ limit: 5 })
    supabaseMock.setTable('group_events', [row(2), row(1)])
    const second = await listActivity({ limit: 5 })
    if (!first.ok || !second.ok) throw new Error('unexpected')

    expect(appendPage(first.value, second.value).events.map((e) => e.id)).toEqual([3, 2, 1])
  })
})

describe('cursor validation (keyset filter safety)', () => {
  it.each([
    '2026-09-27T10:00:02.123456+00:00',
    '2026-09-27T10:00:02Z',
    '2026-09-27 10:00:02.5+10',
  ])('accepts server timestamp %s', (createdAt) => {
    expect(isValidCursor({ createdAt, id: 7 })).toBe(true)
  })

  it.each([
    ['a quote break-out', '2026-09-27T10:00:02Z",id.gt.0,created_at.lt."x', 7],
    ['a comma clause', '2026-09-27T10:00:02Z,id.gt.0', 7],
    ['parentheses', '2026-09-27T10:00:02Z)', 7],
    ['free text', 'yesterday', 7],
    ['a fractional id', '2026-09-27T10:00:02Z', 1.5],
    ['a negative id', '2026-09-27T10:00:02Z', -1],
    ['an unsafe id', '2026-09-27T10:00:02Z', Number.MAX_SAFE_INTEGER + 2],
  ])('rejects %s', (_label, createdAt, id) => {
    expect(isValidCursor({ createdAt: createdAt as string, id: id as number })).toBe(false)
  })

  it('refuses an invalid cursor before sending any query', async () => {
    const result = await listActivity({ before: { createdAt: '2026-09-27T10:00:02Z",id.gt.0', id: 2 } })

    expect(result).toEqual({ ok: false, code: 'validation', message: 'Unable to load more activity.' })
    expect(supabaseMock.from).not.toHaveBeenCalled()
  })
})
