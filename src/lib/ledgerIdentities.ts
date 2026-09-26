import { supabase } from './supabase'

type IdentityRow = { user_id: string; display_name: string }

/**
 * Display names for people referenced by a group's expenses who are no longer
 * active members (former or deleted users). Active members' names come from
 * `profiles`; this covers only historical identities, so records stay
 * intelligible without exposing a former-member directory. Failures are
 * logged and yield an empty map (callers fall back to a generic name).
 */
export async function fetchLedgerIdentityNames(
  groupIds: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>()

  const results = await Promise.all(
    Array.from(new Set(groupIds)).map((groupId) =>
      supabase.rpc('get_ledger_identities', { p_group_id: groupId }),
    ),
  )

  for (const { data, error } of results) {
    if (error) {
      console.error('Unable to load historical member names:', error)
      continue
    }

    for (const row of (data ?? []) as IdentityRow[]) {
      if (row.user_id && row.display_name?.trim()) {
        names.set(row.user_id, row.display_name.trim())
      }
    }
  }

  return names
}
