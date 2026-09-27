import { formatDateShort, isIsoDate } from '../../../shared/domain/dates'
import { formatCents } from '../../../shared/domain/money'
import { nameOf, type NameMap } from '../../people'
import type { ActivityEvent } from '../api/events'

export type DescribedEvent = {
  /** Sentence start, e.g. "Bob" or "You". */
  actor: string
  /** e.g. "added", "edited", "deleted an expense". */
  action: string
  /** The thing acted on, with a link when it still exists. */
  target: { label: string; to: string | null } | null
  /** Extra detail, e.g. "$12.50" or "amount $10.01 → $15.00". */
  detail: string | null
  category: 'expense' | 'member' | 'group'
}

export type DescribeContext = {
  currentUserId: string
  names: NameMap
  expenseTitles: ReadonlyMap<string, string>
}

// Payloads are untrusted in shape (ADR-0008 rule 8): read them defensively.
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const bool = (v: unknown): boolean => v === true
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const money = (v: unknown) => {
  const cents = num(v)
  return cents === null ? null : formatCents(cents)
}
const day = (v: unknown) => {
  const d = str(v)
  return d && isIsoDate(d) ? formatDateShort(d) : null
}

function changeSummary(payload: Record<string, unknown>, who: (id: string | null) => string): string | null {
  const changes = obj(payload.changes) ?? {}
  const parts: string[] = []
  const amount = obj(changes.amount_cents)
  if (amount) parts.push(`amount ${money(amount.from) ?? '?'} → ${money(amount.to) ?? '?'}`)
  const date = obj(changes.expense_date)
  if (date) parts.push(`date ${day(date.from) ?? '?'} → ${day(date.to) ?? '?'}`)
  const payer = obj(changes.paid_by)
  if (payer) parts.push(`paid by ${who(str(payer.from))} → ${who(str(payer.to))}`)
  if (obj(changes.participants)) parts.push('participants changed')
  if (bool(payload.description_changed)) parts.push('description changed')
  if (bool(payload.notes_changed)) parts.push('notes changed')
  return parts.length ? parts.join(' · ') : 'no changes'
}

/** Turns an event into display parts; never shows an id, only names. */
export function describeEvent(event: ActivityEvent, ctx: DescribeContext): DescribedEvent {
  const who = (id: string | null) => (id === null ? 'Someone' : id === ctx.currentUserId ? 'You' : nameOf(ctx.names, id))
  const whom = (id: string | null) => (id === ctx.currentUserId ? 'you' : who(id))
  const p = event.payload
  const expenseTarget = () => {
    const title = event.subjectId ? ctx.expenseTitles.get(event.subjectId) : undefined
    return title && event.subjectId
      ? { label: `“${title}”`, to: `/expenses/${event.subjectId}` }
      : { label: 'an expense that was later deleted', to: null }
  }

  switch (event.kind) {
    case 'group_created':
      return { actor: who(event.actorId), action: 'created the group', target: null, detail: null, category: 'group' }
    case 'member_added':
      return { actor: event.actorId ? who(event.actorId) : 'Someone', action: 'added', target: { label: whom(event.subjectUserId), to: null }, detail: null, category: 'member' }
    case 'member_rejoined':
      return { actor: who(event.actorId), action: 're-added', target: { label: whom(event.subjectUserId), to: null }, detail: null, category: 'member' }
    case 'member_left':
      return { actor: who(event.subjectUserId), action: 'left the group', target: null, detail: null, category: 'member' }
    case 'member_removed':
      return { actor: who(event.actorId), action: 'removed', target: { label: whom(event.subjectUserId), to: null }, detail: null, category: 'member' }
    case 'member_account_deleted':
      return { actor: who(event.subjectUserId), action: 'left the group (account deleted)', target: null, detail: null, category: 'member' }
    case 'ownership_transferred':
      return bool(p.operator_release)
        ? { actor: 'SplitChat support', action: 'made', target: { label: whom(str(p.to) ?? event.subjectUserId), to: null }, detail: 'the owner', category: 'group' }
        : { actor: who(event.actorId), action: 'made', target: { label: whom(str(p.to) ?? event.subjectUserId), to: null }, detail: 'the owner', category: 'group' }
    case 'expense_created':
      return { actor: who(event.actorId), action: 'added', target: expenseTarget(), detail: money(p.amount_cents), category: 'expense' }
    case 'expense_updated':
      return { actor: who(event.actorId), action: 'edited', target: expenseTarget(), detail: changeSummary(p, who), category: 'expense' }
    case 'expense_deleted': {
      const amount = money(p.amount_cents)
      const date = day(p.expense_date)
      return {
        actor: who(event.actorId),
        action: 'deleted an expense',
        target: null,
        detail: [amount, date && `from ${date}`].filter(Boolean).join(' ') || null,
        category: 'expense',
      }
    }
  }
}

/** Plain-text form (for accessible labels and tests). */
export function eventSentence(d: DescribedEvent): string {
  return [d.actor, d.action, d.target?.label, d.detail].filter(Boolean).join(' ')
}
