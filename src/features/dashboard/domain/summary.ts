import type { ActivityEvent } from '../../activity'
import type { ExpenseListItem } from '../../expenses'

export type MonthSummary = { count: number; totalCents: number; myShareCents: number }

/** Expenses dated in the calendar month of `today` (YYYY-MM-DD), integer cents. */
export function monthSummary(expenses: ExpenseListItem[], today: string): MonthSummary {
  const month = today.slice(0, 7)
  const inMonth = expenses.filter((e) => e.expenseDate.slice(0, 7) === month)
  return {
    count: inMonth.length,
    totalCents: inMonth.reduce((sum, e) => sum + e.amountCents, 0),
    myShareCents: inMonth.reduce((sum, e) => sum + (e.myShareCents ?? 0), 0),
  }
}

/** Number of live (not backfilled) events in the last `days` days. */
export function recentChangeCount(events: ActivityEvent[], days: number, now: Date = new Date()): number {
  const since = now.getTime() - days * 24 * 60 * 60 * 1000
  return events.filter((e) => !e.backfilled && new Date(e.createdAt).getTime() >= since).length
}

/** Latest event time per group (events arrive newest first). */
export function lastActivityByGroup(events: ActivityEvent[]): Map<string, string> {
  const latest = new Map<string, string>()
  for (const e of events) if (!latest.has(e.groupId)) latest.set(e.groupId, e.createdAt)
  return latest
}
