import { rpcErrorMessage } from './rpcErrors'
import { supabase } from './supabase'

/** Result of an RPC call: either success or a user-facing error message. */
export type RpcOutcome = { ok: true } | { ok: false; message: string }

export type AddMemberOutcome =
  | {
      ok: true
      result: 'added'
      member: { userId: string; fullName: string }
    }
  | {
      ok: true
      result: 'already_member' | 'member_not_added' | 'rate_limited'
    }
  | { ok: false; message: string }

type AddMemberRow = {
  result: string
  added_user_id: string | null
  added_full_name: string | null
  added_role: string | null
}

const NON_ADDED = new Set(['already_member', 'member_not_added', 'rate_limited'])

/**
 * Adds an existing, confirmed SplitChat account to a group (owner only).
 * The server returns a result instead of raising for outcomes that must not
 * disclose whether an email is registered.
 */
export async function addMemberByEmail(
  groupId: string,
  email: string,
): Promise<AddMemberOutcome> {
  const { data, error } = await supabase.rpc('add_group_member_by_email', {
    target_group_id: groupId,
    target_email: email,
  })

  if (error) {
    return { ok: false, message: rpcErrorMessage(error, 'Unable to add this member.') }
  }

  const row = (Array.isArray(data) ? data[0] : data) as AddMemberRow | undefined

  if (row?.result === 'added' && row.added_user_id) {
    return {
      ok: true,
      result: 'added',
      member: {
        userId: row.added_user_id,
        fullName: row.added_full_name?.trim() || 'SplitChat member',
      },
    }
  }

  if (row && NON_ADDED.has(row.result)) {
    return {
      ok: true,
      result: row.result as 'already_member' | 'member_not_added' | 'rate_limited',
    }
  }

  return { ok: false, message: 'Unable to add this member.' }
}

async function callVoid(
  name: string,
  args: Record<string, unknown>,
  fallback: string,
): Promise<RpcOutcome> {
  const { error } = await supabase.rpc(name, args)
  return error ? { ok: false, message: rpcErrorMessage(error, fallback) } : { ok: true }
}

export function removeMember(groupId: string, userId: string): Promise<RpcOutcome> {
  return callVoid(
    'remove_group_member',
    { p_group_id: groupId, p_user_id: userId },
    'Unable to remove this member.',
  )
}

export function leaveGroup(groupId: string): Promise<RpcOutcome> {
  return callVoid('leave_group', { p_group_id: groupId }, 'Unable to leave this group.')
}

export function transferOwnership(groupId: string, newOwnerId: string): Promise<RpcOutcome> {
  return callVoid(
    'transfer_group_ownership',
    { p_group_id: groupId, p_new_owner_id: newOwnerId },
    'Unable to transfer ownership.',
  )
}
