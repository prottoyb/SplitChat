import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSupabaseMock } from '../../../test/supabaseMock'
import { FALLBACK_MEMBER_NAME, nameOf, resolveDisplayNames } from './names'

const mock = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('../../../shared/api/supabase', () => ({
  get supabase() {
    return (mock.current as ReturnType<typeof createSupabaseMock>).client
  },
}))

let supabaseMock: ReturnType<typeof createSupabaseMock>

beforeEach(() => {
  supabaseMock = createSupabaseMock()
  mock.current = supabaseMock
})

describe('resolveDisplayNames', () => {
  it('uses profile names and skips the ledger lookup when everyone is an active peer', async () => {
    supabaseMock.setTable('profiles', [
      { id: 'u1', full_name: ' Alice ' },
      { id: 'u2', full_name: 'Bob' },
    ])

    const result = await resolveDisplayNames([{ groupId: 'g1', userIds: ['u1', 'u2'] }])

    expect(result).toEqual({ ok: true, value: new Map([['u1', 'Alice'], ['u2', 'Bob']]) })
    expect(supabaseMock.rpc).not.toHaveBeenCalled()
  })

  it('fills former members from ledger identities, once per group with gaps', async () => {
    supabaseMock.setTable('profiles', [{ id: 'u1', full_name: 'Alice' }])
    supabaseMock.setRpc('get_ledger_identities', [
      { user_id: 'u5', display_name: 'Deleted user' },
      { user_id: 'u1', display_name: 'Should not override' },
    ])

    const result = await resolveDisplayNames([
      { groupId: 'g1', userIds: ['u1', 'u5'] },
      { groupId: 'g1', userIds: ['u5'] },
      { groupId: 'g2', userIds: ['u1'] },
    ])

    expect(result.ok && [...result.value]).toEqual([['u1', 'Alice'], ['u5', 'Deleted user']])
    expect(supabaseMock.rpc).toHaveBeenCalledTimes(1)
    expect(supabaseMock.rpc).toHaveBeenCalledWith('get_ledger_identities', { p_group_id: 'g1' })
  })

  it('falls back to the generic name when the ledger lookup fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    supabaseMock.setTable('profiles', [])
    supabaseMock.setRpc('get_ledger_identities', null, { message: 'not_found_or_forbidden' })

    const result = await resolveDisplayNames([{ groupId: 'g1', userIds: ['u9'] }])

    expect(result.ok).toBe(true)
    expect(result.ok && nameOf(result.value, 'u9')).toBe(FALLBACK_MEMBER_NAME)
  })

  it('fails the call when profiles cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    supabaseMock.setTable('profiles', null, { message: 'boom' })

    const result = await resolveDisplayNames([{ groupId: 'g1', userIds: ['u1'] }])

    expect(result).toEqual({ ok: false, code: 'unknown', message: 'Unable to load member names.' })
  })

  it('treats a blank profile name as unknown, never showing an id', async () => {
    supabaseMock.setTable('profiles', [{ id: 'u1', full_name: '  ' }])

    const result = await resolveDisplayNames([{ groupId: 'g1', userIds: ['u1'] }])

    expect(result.ok && nameOf(result.value, 'u1')).toBe(FALLBACK_MEMBER_NAME)
  })

  it('does nothing for no ids', async () => {
    await expect(resolveDisplayNames([])).resolves.toEqual({ ok: true, value: new Map() })
    expect(supabaseMock.from).not.toHaveBeenCalled()
  })
})
