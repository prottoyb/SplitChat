/**
 * Calendar dates (`YYYY-MM-DD`, no time zone) as used for expense dates, and
 * display formatting. Dates are compared as strings, which is exact for the
 * zero-padded ISO form, so no time-zone conversion can shift a day.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

export const EARLIEST_EXPENSE_DATE = '2000-01-01'
export const MAX_DAYS_AHEAD = 365

/** True for a real calendar date in strict `YYYY-MM-DD` form. */
export function isIsoDate(value: string): boolean {
  const m = ISO_DATE.exec(value)
  if (!m) return false
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (month < 1 || month > 12 || day < 1) return false
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return day <= daysInMonth
}

/** The local calendar date of `now` in `YYYY-MM-DD` form. */
export function localIsoDate(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** `iso` shifted by `days` calendar days (via UTC, so DST cannot interfere). */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d + days))
  return date.toISOString().slice(0, 10)
}

export type ExpenseDateError = 'missing' | 'invalid' | 'too_early' | 'too_far_ahead'

/**
 * Validates an expense date: required, a real calendar date, not before
 * 2000-01-01 and not more than a year after `today` (local).
 */
export function checkExpenseDate(value: string, today: string = localIsoDate()): ExpenseDateError | null {
  const text = value.trim()
  if (!text) return 'missing'
  if (!isIsoDate(text)) return 'invalid'
  if (text < EARLIEST_EXPENSE_DATE) return 'too_early'
  if (text > addDays(today, MAX_DAYS_AHEAD)) return 'too_far_ahead'
  return null
}

export const EXPENSE_DATE_MESSAGES: Record<ExpenseDateError, string> = {
  missing: 'Please select the expense date.',
  invalid: 'Please enter a valid date.',
  too_early: 'The expense date cannot be before 1 January 2000.',
  too_far_ahead: 'The expense date cannot be more than a year from today.',
}

const LONG = new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
const SHORT = new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
const DATE_TIME = new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })

// Calendar dates are formatted in UTC from their own components, so the
// displayed day is always the stored day, whatever the viewer's time zone.
const fromIso = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

/** "25 September 2026" for a `YYYY-MM-DD` calendar date. */
export const formatDateLong = (iso: string) => (isIsoDate(iso) ? LONG.format(fromIso(iso)) : iso)

/** "25 Sept 2026" for a `YYYY-MM-DD` calendar date. */
export const formatDateShort = (iso: string) => (isIsoDate(iso) ? SHORT.format(fromIso(iso)) : iso)

/** Local date and time of a timestamp (e.g. `created_at`). */
export function formatTimestamp(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : DATE_TIME.format(date)
}
