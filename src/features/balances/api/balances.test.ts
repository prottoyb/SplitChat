import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSupabaseMock } from '../../../test/supabaseMock'
import { loadGroupBalances, loadMyBalance } from './balances'

const mock = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('../../../shared/api/supabase', () => ({
  get supabase() {
    return (mock.current as ReturnType<typeof createSupabaseMock>).client
  },
}))

let supabaseMock: ReturnType<typeof createSupabaseMock>

const row = (user_id: string, paid: number, owed: number, out: number, inn: number) => ({
  user_id, paid_cents: paid, owed_cents: owed, settled_out_cents: out, settled_in_cents: inn, net_cents: paid - owed + out - inn,
})

beforeEach(() => {
  supabaseMock = createSupabaseMock()
  mock.current = supabaseMock
  supabaseMock.setTable('profiles', [{ id: 'u1', full_name: 'Alice' }, { id: 'u2', full_name: 'Bob' }])
  supabaseMock.setRpc('get_ledger_identities', [{ user_id: 'u5', display_name: 'Deleted user' }])
})

describe('loadGroupBalances', () => {
  it('reads server balances in cents and names everyone, including former members', async () => {
    supabaseMock.setRpc('get_group_balances', [row('u1', 10000, 5334, 0, 0), row('u2', 1000, 5333, 0, 0), row('u5', 0, 333, 0, 0)])

    const result = await loadGroupBalances('g1')

    expect(supabaseMock.rpc).toHaveBeenCalledWith('get_group_balances', { p_group_id: 'g1' })
    expect(result.ok && result.value.people.map((p) => [p.userId, p.netCents])).toEqual([['u1', 4666], ['u2', -4333], ['u5', -333]])
    expect(result.ok && result.value.names.get('u5')).toBe('Deleted user')
  })

  it('accepts bigint amounts serialised as strings', async () => {
    supabaseMock.setRpc('get_group_balances', [
      { user_id: 'u1', paid_cents: '999999999999', owed_cents: '0', settled_out_cents: '0', settled_in_cents: '0', net_cents: '999999999999' },
      { user_id: 'u2', paid_cents: '0', owed_cents: '999999999999', settled_out_cents: '0', settled_in_cents: '0', net_cents: '-999999999999' },
    ])
    const result = await loadGroupBalances('g1')
    expect(result.ok && result.value.people[1].netCents).toBe(-999999999999)
  })

  it.each([
    ['a fractional amount', [{ ...row('u1', 100, 0, 0, 0), net_cents: 100.5 }, row('u2', 0, 100, 0, 0)]],
    ['a net that does not match its parts', [{ ...row('u1', 100, 0, 0, 0), net_cents: 90 }, row('u2', 0, 100, 0, 0)]],
    ['a group that does not net to zero', [row('u1', 100, 0, 0, 0), row('u2', 0, 90, 0, 0)]],
    ['a missing id', [{ ...row('u1', 0, 0, 0, 0), user_id: null }]],
  ])('refuses to show wrong numbers: %s', async (_label, rows) => {
    supabaseMock.setRpc('get_group_balances', rows)
    await expect(loadGroupBalances('g1')).resolves.toEqual({ ok: false, code: 'unknown', message: 'Balances could not be read. Please try again.' })
  })

  it('maps a refused call to a safe failure', async () => {
    supabaseMock.setRpc('get_group_balances', null, { message: 'not_found_or_forbidden' })
    const result = await loadGroupBalances('g1')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.code).toBe('not_found')
  })
})

describe('loadMyBalance', () => {
  it('returns only the caller’s server net, without name lookups', async () => {
    supabaseMock.setRpc('get_group_balances', [row('u1', 10000, 5334, 0, 0), row('u2', 1000, 5333, 0, 0), row('u5', 0, 333, 0, 0)])

    await expect(loadMyBalance('g1', 'u2')).resolves.toEqual({ ok: true, value: -4333 })
    expect(supabaseMock.rpc.mock.calls.map(([name]) => name)).toEqual(['get_group_balances'])
  })

  it('treats someone with no ledger entries as settled up', async () => {
    supabaseMock.setRpc('get_group_balances', [row('u1', 100, 0, 0, 0), row('u2', 0, 100, 0, 0)])
    await expect(loadMyBalance('g1', 'u3')).resolves.toEqual({ ok: true, value: 0 })
  })

  it('applies the same checks as the full load', async () => {
    supabaseMock.setRpc('get_group_balances', [row('u1', 100, 0, 0, 0), row('u2', 0, 90, 0, 0)])
    await expect(loadMyBalance('g1', 'u1')).resolves.toEqual({ ok: false, code: 'unknown', message: 'Balances could not be read. Please try again.' })
  })
})
