import { addDays, checkExpenseDate, isIsoDate } from '../../../shared/domain/dates'
import { MAX_AMOUNT_CENTS } from '../../../shared/domain/money'
import type { Draft, InterpretContext, Interpretation, Issue } from './interpreter'

const MAX_DESCRIPTION = 120
const MAX_PARTICIPANTS = 200

/**
 * The one gate every interpreter's output passes before it is proposed
 * (ADR-0012 condition 10): whatever produced the draft — this deterministic
 * interpreter or a future LLM — a value that is not valid for this group
 * right now becomes null with an issue. It never adds or guesses a value.
 */
export function validateDraft(result: Interpretation, ctx: InterpretContext): Interpretation {
  if (result.kind !== 'candidate') return result
  const members = new Set(ctx.members.map((m) => m.id))
  const issues: Issue[] = [...result.issues]
  const d: Draft = { ...result.draft }
  const drop = (field: Issue['field'], code: Issue['code']) => {
    if (!issues.some((i) => i.field === field)) issues.push({ field, code })
  }

  if (d.description !== null) {
    const text = typeof d.description === 'string' ? d.description.trim() : ''
    if (!text || [...text].length > MAX_DESCRIPTION) {
      d.description = null
      drop('description', text ? 'too_long' : 'missing')
    } else d.description = text
  }
  if (d.amountCents !== null && !(Number.isSafeInteger(d.amountCents) && d.amountCents >= 1 && d.amountCents <= MAX_AMOUNT_CENTS)) {
    d.amountCents = null
    drop('amount', 'invalid_amount')
  }
  if (
    d.expenseDate !== null &&
    !(isIsoDate(d.expenseDate) && checkExpenseDate(d.expenseDate, ctx.messageDate) === null && d.expenseDate <= addDays(ctx.messageDate, 365))
  ) {
    d.expenseDate = null
    drop('date', 'invalid_date')
  }
  if (d.paidBy !== null && !members.has(d.paidBy)) {
    d.paidBy = null
    drop('payer', 'unknown_name')
  }
  if (d.participantIds !== null) {
    const ids = d.participantIds
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_PARTICIPANTS || new Set(ids).size !== ids.length || ids.some((id) => !members.has(id))) {
      d.participantIds = null
      drop('participants', 'unknown_name')
    }
  }
  return { ...result, draft: d, issues }
}
