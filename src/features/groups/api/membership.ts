import { supabase } from '../../../shared/api/supabase'
import { fail, failureFrom, guard, ok, type Result } from '../../../shared/api/result'
import { FALLBACK_MEMBER_NAME } from '../../people'

/** Membership RPCs (M9, M15); authorization is enforced by the server. */

export type AddMemberResult =
  | { result: 'added'; member: { userId: string; fullName: string } }
  | { result: 'already_member' | 'member_not_added' | 'rate_limited' }

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
 * disclose whether an email is registered (CA-1, DS-4).
 */
export function addMemberByEmail(groupId: string, email: string): Promise<Result<AddMemberResult>> {
  return guard<AddMemberResult>(async () => {
    const { data, error } = await supabase.rpc('add_group_member_by_email', {
      target_group_id: groupId,
      target_email: email,
    })
    if (error) return failureFrom(error, 'Unable to add this member.')

    const row = (Array.isArray(data) ? data[0] : data) as AddMemberRow | undefined
    if (row?.result === 'added' && row.added_user_id) {
      return ok({
        result: 'added',
        member: { userId: row.added_user_id, fullName: row.added_full_name?.trim() || FALLBACK_MEMBER_NAME },
      })
    }
    if (row && NON_ADDED.has(row.result)) {
      return ok({ result: row.result as 'already_member' | 'member_not_added' | 'rate_limited' })
    }
    return fail('unknown', 'Unable to add this member.')
  }, 'Unable to add this member.')
}

function callVoid(name: string, args: Record<string, unknown>, fallback: string): Promise<Result<void>> {
  return guard(async () => {
    const { error } = await supabase.rpc(name, args)
    return error ? failureFrom(error, fallback) : ok(undefined)
  }, fallback)
}

export const removeMember = (groupId: string, userId: string) =>
  callVoid('remove_group_member', { p_group_id: groupId, p_user_id: userId }, 'Unable to remove this member.')

export const leaveGroup = (groupId: string) =>
  callVoid('leave_group', { p_group_id: groupId }, 'Unable to leave this group.')

export const transferOwnership = (groupId: string, newOwnerId: string) =>
  callVoid(
    'transfer_group_ownership',
    { p_group_id: groupId, p_new_owner_id: newOwnerId },
    'Unable to transfer ownership.',
  )

/**
 * Permanently deletes a solo group (owner only). The server refuses if anyone
 * else has ever been a member or appears anywhere in the group's history.
 */
export const deleteGroup = (groupId: string) =>
  callVoid('delete_group', { p_group_id: groupId }, 'Unable to delete this group.')
