import type { ActivityPage } from '../../activity'
import type { GroupSummary } from '../../groups'

export type AttentionItem = {
  key: string
  kind: 'expense_changed' | 'added_to_group' | 'solo_group'
  /** The actor or group the item is about (display text). */
  subject: string
  groupName: string
  to: string
  createdAt: string | null
}

export const ATTENTION_WINDOW_DAYS = 14

/**
 * What deserves the user's attention, derived from data they can already see
 * (no balances until Phase 4 owns that calculation):
 * - someone else edited or deleted an expense the user is part of;
 * - someone added the user to a group;
 * - a group where the user is still the only member.
 * Recent first; events older than the window are ignored.
 */
export function attentionItems(
  activity: ActivityPage,
  groups: GroupSummary[],
  currentUserId: string,
  now: Date = new Date(),
): AttentionItem[] {
  const since = now.getTime() - ATTENTION_WINDOW_DAYS * 24 * 60 * 60 * 1000
  const groupName = (id: string) =>
    activity.groupNames.get(id) ?? groups.find((g) => g.id === id)?.name ?? 'a group'
  const name = (id: string | null) => (id ? activity.names.get(id) ?? 'Someone' : 'Someone')
  const items: AttentionItem[] = []

  for (const e of activity.events) {
    if (e.backfilled || new Date(e.createdAt).getTime() < since) continue
    if (
      (e.kind === 'expense_updated' || e.kind === 'expense_deleted') &&
      e.actorId !== currentUserId &&
      e.people.includes(currentUserId)
    ) {
      const exists = e.subjectId ? activity.expenseTitles.has(e.subjectId) : false
      items.push({
        key: `event-${e.id}`,
        kind: 'expense_changed',
        subject: name(e.actorId),
        groupName: groupName(e.groupId),
        to: exists ? `/expenses/${e.subjectId}` : `/groups/${e.groupId}/activity`,
        createdAt: e.createdAt,
      })
    }
    if ((e.kind === 'member_added' || e.kind === 'member_rejoined') && e.subjectUserId === currentUserId && e.actorId !== currentUserId) {
      items.push({
        key: `event-${e.id}`,
        kind: 'added_to_group',
        subject: name(e.actorId),
        groupName: groupName(e.groupId),
        to: `/groups/${e.groupId}`,
        createdAt: e.createdAt,
      })
    }
  }

  for (const g of groups) {
    if (g.memberCount === 1) {
      items.push({ key: `solo-${g.id}`, kind: 'solo_group', subject: g.name, groupName: g.name, to: `/groups/${g.id}`, createdAt: null })
    }
  }
  return items
}
