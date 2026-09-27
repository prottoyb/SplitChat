import { supabase } from '../../../shared/api/supabase'
import { fail, failureFrom, guard, ok, type Result } from '../../../shared/api/result'
import { resolveDisplayNames, type NameMap } from '../../people'

/** Event kinds recorded by the database (ADR-0009 condition 3). */
export type EventKind =
  | 'group_created'
  | 'member_added'
  | 'member_rejoined'
  | 'member_left'
  | 'member_removed'
  | 'member_account_deleted'
  | 'ownership_transferred'
  | 'expense_created'
  | 'expense_updated'
  | 'expense_deleted'

export type ActivityEvent = {
  id: number
  groupId: string
  kind: EventKind
  actorId: string | null
  subjectId: string | null
  subjectUserId: string | null
  /** Every person the event refers to (ids only). */
  people: string[]
  /** Untrusted in shape: read through the typed accessors in describeEvent. */
  payload: Record<string, unknown>
  backfilled: boolean
  createdAt: string
}

/** Keyset position: the last event already shown (ADR-0009 condition 11). */
export type Cursor = { createdAt: string; id: number }

export type ActivityPage = {
  events: ActivityEvent[]
  /** Present when more events exist. */
  next: Cursor | null
  names: NameMap
  groupNames: ReadonlyMap<string, string>
  /** Current titles of expenses that still exist (deleted ones are absent). */
  expenseTitles: ReadonlyMap<string, string>
}

type EventRow = {
  id: number
  group_id: string
  kind: EventKind
  actor_id: string | null
  subject_id: string | null
  subject_user_id: string | null
  people: string[] | null
  payload: Record<string, unknown> | null
  backfilled: boolean
  created_at: string
}

export const MAX_PAGE_SIZE = 50

// A PostgREST timestamptz as returned for created_at (no quotes, commas or
// parentheses can occur in a value that passes this).
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/

/** True only for a cursor this client could have produced from a server row. */
export function isValidCursor(cursor: Cursor): boolean {
  return TIMESTAMP.test(cursor.createdAt) && Number.isSafeInteger(cursor.id) && cursor.id > 0
}

const EXPENSE_KINDS = new Set<EventKind>(['expense_created', 'expense_updated', 'expense_deleted'])

/**
 * Newest-first activity for the caller's active groups (RLS), optionally
 * for one group, keyset-paginated on (created_at, id). Names, group names
 * and current expense titles are resolved at read time, so account-deletion
 * tombstones apply and deleted expenses keep no description.
 */
export function listActivity({
  groupId,
  before,
  limit = 20,
}: { groupId?: string; before?: Cursor | null; limit?: number } = {}): Promise<Result<ActivityPage>> {
  return guard(async () => {
    if (before && !isValidCursor(before)) return fail('validation', 'Unable to load more activity.')
    const size = Math.max(1, Math.min(limit, MAX_PAGE_SIZE))
    let query = supabase
      .from('group_events')
      .select('id, group_id, kind, actor_id, subject_id, subject_user_id, people, payload, backfilled, created_at')
    if (groupId) query = query.eq('group_id', groupId)
    if (before) {
      // Keyset filter (ADR-0009 condition 11). The cursor was validated
      // strictly above, before any query is built, so no value can
      // break out of the quoted literal or add clauses (QA Phase 3 finding).
      query = query.or(`created_at.lt."${before.createdAt}",and(created_at.eq."${before.createdAt}",id.lt.${before.id})`)
    }
    const result = await query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(size + 1)
    if (result.error) return failureFrom(result.error, 'Unable to load recent activity.')

    const rows = ((result.data ?? []) as EventRow[]).slice(0, size + 1)
    const hasMore = rows.length > size
    const pageRows = rows.slice(0, size)
    const events: ActivityEvent[] = pageRows.map((r) => ({
      id: r.id,
      groupId: r.group_id,
      kind: r.kind,
      actorId: r.actor_id,
      subjectId: r.subject_id,
      subjectUserId: r.subject_user_id,
      people: Array.isArray(r.people) ? r.people : [],
      payload: r.payload && typeof r.payload === 'object' ? r.payload : {},
      backfilled: r.backfilled,
      createdAt: r.created_at,
    }))

    const groupIds = [...new Set(events.map((e) => e.groupId))]
    const expenseIds = [...new Set(events.filter((e) => EXPENSE_KINDS.has(e.kind) && e.subjectId).map((e) => e.subjectId as string))]

    const [groups, expenses, names] = await Promise.all([
      groupIds.length ? supabase.from('groups').select('id, name').in('id', groupIds) : Promise.resolve({ data: [], error: null }),
      expenseIds.length
        ? supabase.from('expenses').select('id, description').in('id', expenseIds)
        : Promise.resolve({ data: [], error: null }),
      resolveDisplayNames(
        groupIds.map((g) => ({ groupId: g, userIds: pageRows.filter((r) => r.group_id === g).flatMap((r) => r.people ?? []) })),
      ),
    ])
    if (groups.error) return failureFrom(groups.error, 'Unable to load recent activity.')
    if (expenses.error) return failureFrom(expenses.error, 'Unable to load recent activity.')
    if (!names.ok) return names

    const last = events.at(-1)
    return ok({
      events,
      next: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
      names: names.value,
      groupNames: new Map(((groups.data ?? []) as { id: string; name: string }[]).map((g) => [g.id, g.name])),
      expenseTitles: new Map(((expenses.data ?? []) as { id: string; description: string }[]).map((x) => [x.id, x.description])),
    })
  }, 'Unable to load recent activity.')
}

/** Merges a later page into the loaded one (de-duplicated by event id). */
export function appendPage(current: ActivityPage, more: ActivityPage): ActivityPage {
  const seen = new Set(current.events.map((e) => e.id))
  return {
    events: [...current.events, ...more.events.filter((e) => !seen.has(e.id))],
    next: more.next,
    names: new Map([...current.names, ...more.names]),
    groupNames: new Map([...current.groupNames, ...more.groupNames]),
    expenseTitles: new Map([...current.expenseTitles, ...more.expenseTitles]),
  }
}


