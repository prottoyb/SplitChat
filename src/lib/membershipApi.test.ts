import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSupabaseMock } from '../test/supabaseMock'
import {
  addMemberByEmail,
  deleteGroup,
  leaveGroup,
  removeMember,
  transferOwnership,
} from './membershipApi'

const mock = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('./supabase', () => ({
  get supabase() {
    return (mock.current as ReturnType<typeof createSupabaseMock>).client
  },
}))

let supabaseMock: ReturnType<typeof createSupabaseMock>

beforeEach(() => {
  supabaseMock = createSupabaseMock()
  mock.current = supabaseMock
})

describe('addMemberByEmail', () => {
  it('returns the added member identity', async () => {
    supabaseMock.setRpc('add_group_member_by_email', [
      { result: 'added', added_user_id: 'u9', added_full_name: ' Nia ', added_role: 'member' },
    ])

    await expect(addMemberByEmail('g1', 'nia@example.com')).resolves.toEqual({
      ok: true,
      result: 'added',
      member: { userId: 'u9', fullName: 'Nia' },
    })
    expect(supabaseMock.rpc).toHaveBeenCalledWith('add_group_member_by_email', {
      target_group_id: 'g1',
      target_email: 'nia@example.com',
    })
  })

  it.each(['already_member', 'member_not_added', 'rate_limited'])(
    'passes through the %s outcome without identity',
    async (result) => {
      supabaseMock.setRpc('add_group_member_by_email', [
        { result, added_user_id: null, added_full_name: null, added_role: null },
      ])

      await expect(addMemberByEmail('g1', 'x@example.com')).resolves.toEqual({ ok: true, result })
    },
  )

  it('maps RPC error codes and never returns raw messages', async () => {
    supabaseMock.setRpc('add_group_member_by_email', null, { message: 'not_found_or_forbidden' })
    const outcome = await addMemberByEmail('g1', 'x@example.com')
    expect(outcome.ok).toBe(false)
    expect(outcome).toMatchObject({ message: expect.stringMatching(/do not have permission/) })

    supabaseMock.setRpc('add_group_member_by_email', null, { message: 'internal detail' })
    await expect(addMemberByEmail('g1', 'x@example.com')).resolves.toEqual({
      ok: false,
      message: 'Unable to add this member.',
    })
  })

  it('treats an unexpected response shape as a failure', async () => {
    supabaseMock.setRpc('add_group_member_by_email', [{ result: 'surprise' }])
    await expect(addMemberByEmail('g1', 'x@example.com')).resolves.toEqual({
      ok: false,
      message: 'Unable to add this member.',
    })
  })
})

describe('membership RPC wrappers', () => {
  it('call the RPCs with the expected arguments', async () => {
    await expect(removeMember('g1', 'u2')).resolves.toEqual({ ok: true })
    await expect(leaveGroup('g1')).resolves.toEqual({ ok: true })
    await expect(transferOwnership('g1', 'u3')).resolves.toEqual({ ok: true })

    expect(supabaseMock.rpc).toHaveBeenCalledWith('remove_group_member', { p_group_id: 'g1', p_user_id: 'u2' })
    expect(supabaseMock.rpc).toHaveBeenCalledWith('leave_group', { p_group_id: 'g1' })
    expect(supabaseMock.rpc).toHaveBeenCalledWith('transfer_group_ownership', {
      p_group_id: 'g1',
      p_new_owner_id: 'u3',
    })
  })

  it('deleteGroup calls delete_group and maps the history refusals', async () => {
    await expect(deleteGroup('g1')).resolves.toEqual({ ok: true })
    expect(supabaseMock.rpc).toHaveBeenCalledWith('delete_group', { p_group_id: 'g1' })

    supabaseMock.setRpc('delete_group', null, { message: 'group_has_other_members' })
    await expect(deleteGroup('g1')).resolves.toEqual({
      ok: false,
      message: expect.stringMatching(/other people have been members/),
    })

    supabaseMock.setRpc('delete_group', null, { message: 'some internal error' })
    await expect(deleteGroup('g1')).resolves.toEqual({
      ok: false,
      message: 'Unable to delete this group.',
    })
  })

  it('map server rules to user-facing messages', async () => {
    supabaseMock.setRpc('leave_group', null, { message: 'owner_must_transfer' })
    await expect(leaveGroup('g1')).resolves.toEqual({
      ok: false,
      message: 'Make another member the owner before leaving this group.',
    })
  })
})
