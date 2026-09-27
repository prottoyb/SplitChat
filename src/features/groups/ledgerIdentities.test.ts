import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSupabaseMock } from '../../test/supabaseMock'
import { fetchLedgerIdentityNames } from './ledgerIdentities'

const mock = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('../../shared/api/supabase', () => ({
  get supabase() {
    return (mock.current as ReturnType<typeof createSupabaseMock>).client
  },
}))

let supabaseMock: ReturnType<typeof createSupabaseMock>

beforeEach(() => {
  supabaseMock = createSupabaseMock()
  mock.current = supabaseMock
})

describe('fetchLedgerIdentityNames', () => {
  it('returns historical display names, one call per distinct group', async () => {
    supabaseMock.setRpc('get_ledger_identities', [
      { user_id: 'u5', display_name: ' Eve ' },
      { user_id: 'u6', display_name: '' },
    ])

    const names = await fetchLedgerIdentityNames(['g1', 'g1'])

    expect(names).toEqual(new Map([['u5', 'Eve']]))
    expect(supabaseMock.rpc).toHaveBeenCalledTimes(1)
    expect(supabaseMock.rpc).toHaveBeenCalledWith('get_ledger_identities', { p_group_id: 'g1' })
  })

  it('returns an empty map when the lookup fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    supabaseMock.setRpc('get_ledger_identities', null, { message: 'not_found_or_forbidden' })

    await expect(fetchLedgerIdentityNames(['g1'])).resolves.toEqual(new Map())
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })
})
