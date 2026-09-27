import { supabase } from '../../../shared/api/supabase'
import { fail, failureFrom, guard, ok, type Result } from '../../../shared/api/result'
import { nameOf, resolveDisplayNames } from '../../people'
import type { GroupInput } from '../domain/groupForm'

export type Role = 'owner' | 'member'

export type GroupSummary = {
  id: string
  name: string
  description: string | null
  createdAt: string
  myRole: Role
  memberCount: number
}

export type Member = {
  userId: string
  fullName: string
  role: Role
  joinedAt: string
}

export type GroupDetail = {
  id: string
  name: string
  description: string | null
  createdAt: string
  members: Member[]
  myRole: Role | null
}

type GroupRow = { id: string; name: string; description: string | null; created_at: string }
type MembershipRow = { group_id: string; user_id: string; role: Role; joined_at: string }

/**
 * The caller's groups (RLS: active membership only), newest first, with the
 * caller's role and the active member count. Ownership comes from the
 * membership role (M7), never from `groups.created_by`.
 */
export function listMyGroups(userId: string): Promise<Result<GroupSummary[]>> {
  return guard(async () => {
    const groups = await supabase
      .from('groups')
      .select('id, name, description, created_at')
      .order('created_at', { ascending: false })
    if (groups.error) return failureFrom(groups.error, 'Unable to load your groups.')
    const rows = (groups.data ?? []) as GroupRow[]
    if (rows.length === 0) return ok([])

    const memberships = await supabase
      .from('group_members')
      .select('group_id, user_id, role, joined_at')
      .in('group_id', rows.map((g) => g.id))
    if (memberships.error) return failureFrom(memberships.error, 'Unable to load your groups.')
    const members = (memberships.data ?? []) as MembershipRow[]

    return ok(
      rows.map((g) => {
        const inGroup = members.filter((m) => m.group_id === g.id)
        return {
          id: g.id,
          name: g.name,
          description: g.description,
          createdAt: g.created_at,
          myRole: inGroup.find((m) => m.user_id === userId)?.role ?? 'member',
          memberCount: inGroup.length,
        }
      }),
    )
  }, 'Unable to load your groups.')
}

/** One group with its active members (by join date) and the caller's role. */
export function loadGroupDetail(groupId: string, userId: string): Promise<Result<GroupDetail>> {
  return guard(async () => {
    const group = await supabase
      .from('groups')
      .select('id, name, description, created_at')
      .eq('id', groupId)
      .limit(1)
    if (group.error) return failureFrom(group.error, 'Unable to load this group.')
    const row = ((group.data ?? []) as GroupRow[])[0]
    if (!row) return fail('not_found', 'This group does not exist or you do not have access to it.')

    const memberships = await supabase
      .from('group_members')
      .select('group_id, user_id, role, joined_at')
      .eq('group_id', groupId)
      .order('joined_at', { ascending: true })
    if (memberships.error) return failureFrom(memberships.error, 'Unable to load the group members.')
    const rows = (memberships.data ?? []) as MembershipRow[]

    const names = await resolveDisplayNames([{ groupId, userIds: rows.map((m) => m.user_id) }])
    if (!names.ok) return names

    return ok({
      id: row.id,
      name: row.name,
      description: row.description,
      createdAt: row.created_at,
      members: rows.map((m) => ({
        userId: m.user_id,
        fullName: nameOf(names.value, m.user_id),
        role: m.role,
        joinedAt: m.joined_at,
      })),
      myRole: rows.find((m) => m.user_id === userId)?.role ?? null,
    })
  }, 'Unable to load this group.')
}

/** Creates a group (column-granted INSERT; the owner row is added by trigger). */
export function createGroup(input: GroupInput, userId: string): Promise<Result<void>> {
  return guard(async () => {
    const { error } = await supabase
      .from('groups')
      .insert({ name: input.name, description: input.description, created_by: userId })
    if (error) return failureFrom(error, 'Unable to create the group. Please try again.')
    return ok(undefined)
  }, 'Unable to create the group.')
}
