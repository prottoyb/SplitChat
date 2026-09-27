import { addDays, checkExpenseDate, isIsoDate } from '../../../shared/domain/dates'
import type { Draft, DraftField, InterpretContext, Issue } from './types'

const MAX_DESCRIPTION = 120
const MAX_DAYS_AHEAD = 365


export function checkedDate(iso: string, ctx: InterpretContext): string | null {
  return isIsoDate(iso) && checkExpenseDate(iso, ctx.messageDate) === null && iso <= addDays(ctx.messageDate, MAX_DAYS_AHEAD)
    ? iso
    : null
}

export function relativeDate(word: string, ctx: InterpretContext): string | null {
  if (word === 'today') return ctx.messageDate
  if (word === 'yesterday') return addDays(ctx.messageDate, -1)
  return null
}

export function description(text: string, issues: Issue[]): string | null {
  const d = text.trim().replace(/[\s,;:]+$/, '')
  if (!d) return null
  if ([...d].length > MAX_DESCRIPTION) {
    issues.push({ field: 'description', code: 'too_long' })
    return null
  }
  return d
}


/** Records that a field is missing unless an issue already explains it. */
export function markMissing(draft: Draft, issues: Issue[], field: DraftField, key: keyof Draft) {
  if (draft[key] === null && !issues.some((i) => i.field === field)) issues.push({ field, code: 'missing' })
}
