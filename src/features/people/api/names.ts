import { supabase } from '../../../shared/api/supabase'
import { failureFrom, guard, ok, type Result } from '../../../shared/api/result'

/** Shown when no name can be resolved (never an id). */
export const FALLBACK_MEMBER_NAME = 'SplitChat member'

export type NameMap = ReadonlyMap<string, string>

/** The display name for `userId`, or the generic fallback. */
export const nameOf = (names: NameMap, userId: string): string => names.get(userId) ?? FALLBACK_MEMBER_NAME

type ProfileRow = { id: string; full_name: string | null }
type IdentityRow = { user_id: string; display_name: string | null }

/**
 * Resolves display names for people referenced in one or more groups
 * (ADR-0008 rule 5):
 * 1. names from `profiles` — visible under RLS for the caller and their
 *    active peers; a profile name always wins;
 * 2. for ids still unresolved, `get_ledger_identities(group)` — former or
 *    deleted members referenced by that group's ledger ("Deleted user" for
 *    tombstones), one call per group that has unresolved ids.
 * A failed profiles query fails the whole call; a failed ledger-identity
 * call is logged and those people fall back to the generic name.
 */
export function resolveDisplayNames(
  refs: { groupId: string; userIds: readonly string[] }[],
): Promise<Result<NameMap>> {
  return guard(async () => {
    const allIds = [...new Set(refs.flatMap((r) => r.userIds))]
    const names = new Map<string, string>()
    if (allIds.length === 0) return ok(names)

    const { data, error } = await supabase.from('profiles').select('id, full_name').in('id', allIds)
    if (error) {
      console.error('Unable to load member names:', error)
      return failureFrom(error, 'Unable to load member names.')
    }
    for (const row of (data ?? []) as ProfileRow[]) {
      const name = row.full_name?.trim()
      if (name) names.set(row.id, name)
    }

    const known = new Set(((data ?? []) as ProfileRow[]).map((row) => row.id))
    const groupsWithGaps = [
      ...new Set(refs.filter((r) => r.userIds.some((id) => !known.has(id))).map((r) => r.groupId)),
    ]
    const identities = await Promise.all(
      groupsWithGaps.map((groupId) => supabase.rpc('get_ledger_identities', { p_group_id: groupId })),
    )
    for (const result of identities) {
      if (result.error) {
        console.error('Unable to load historical member names:', result.error)
        continue
      }
      for (const row of (result.data ?? []) as IdentityRow[]) {
        const name = row.display_name?.trim()
        if (row.user_id && name && !names.has(row.user_id)) names.set(row.user_id, name)
      }
    }
    return ok(names)
  }, 'Unable to load member names.')
}
