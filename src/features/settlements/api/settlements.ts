import { supabase } from '../../../shared/api/supabase'
import { fail, failureFrom, guard, ok, type Result } from '../../../shared/api/result'
import { readCents } from '../../../shared/domain/money'
import type { SettlementInput } from '../domain/settlementForm'

export type Settlement = {
  id: string
  fromUserId: string
  toUserId: string
  amountCents: number
  settledOn: string
  note: string | null
  createdBy: string
  createdAt: string
  voided: { at: string; by: string; reason: string } | null
}

type SettlementRow = {
  id: string
  from_user: string
  to_user: string
  amount_cents: unknown
  settled_on: string
  note: string | null
  created_by: string
  created_at: string
  voided_at: string | null
  voided_by: string | null
  void_reason: string | null
}

/** How many settlements the history shows (newest first). */
export const HISTORY_LIMIT = 100

// Wording for codes whose default text is about expenses.
const PAYMENT_MESSAGES = {
  forbidden: 'Only the two people involved or the group owner can do that.',
  invalid_date: 'Please choose a date between 1 January 2000 and a year from today.',
} as const

/** A group's settlements, newest first (RLS: active members only). */
export function listSettlements(groupId: string): Promise<Result<Settlement[]>> {
  return guard(async () => {
    const { data, error } = await supabase
      .from('settlements')
      .select('id, from_user, to_user, amount_cents, settled_on, note, created_by, created_at, voided_at, voided_by, void_reason')
      .eq('group_id', groupId)
      .order('settled_on', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(HISTORY_LIMIT)
    if (error) return failureFrom(error, 'Unable to load payment history.')

    const settlements: Settlement[] = []
    for (const row of (data ?? []) as SettlementRow[]) {
      const amountCents = readCents(row.amount_cents)
      if (amountCents === null) return fail('unknown', 'Payment history could not be read. Please try again.')
      settlements.push({
        id: row.id,
        fromUserId: row.from_user,
        toUserId: row.to_user,
        amountCents,
        settledOn: row.settled_on,
        note: row.note,
        createdBy: row.created_by,
        createdAt: row.created_at,
        voided:
          row.voided_at && row.voided_by && row.void_reason
            ? { at: row.voided_at, by: row.voided_by, reason: row.void_reason }
            : null,
      })
    }
    return ok(settlements)
  }, 'Unable to load payment history.')
}

/**
 * Records a payment through the server (ADR-0010), which re-checks it
 * against live balances. `requestId` makes a retry of the same submission
 * return the original payment instead of recording it twice.
 */
export function recordSettlement(groupId: string, input: SettlementInput, requestId: string): Promise<Result<string>> {
  return guard(async () => {
    const { data, error } = await supabase.rpc('record_settlement', {
      p_group_id: groupId,
      p_from_user: input.fromUserId,
      p_to_user: input.toUserId,
      p_amount_cents: input.amountCents,
      p_settled_on: input.settledOn,
      p_note: input.note,
      p_client_request_id: requestId,
    })
    if (error) return failureFrom(error, 'Unable to record this payment. Please try again.', PAYMENT_MESSAGES)
    return ok(data as string)
  }, 'Unable to record this payment.')
}

export function voidSettlement(settlementId: string, reason: string): Promise<Result<void>> {
  return guard(async () => {
    const { error } = await supabase.rpc('void_settlement', { p_settlement_id: settlementId, p_reason: reason })
    if (error) return failureFrom(error, 'Unable to void this payment. Please try again.', PAYMENT_MESSAGES)
    return ok(undefined)
  }, 'Unable to void this payment.')
}
