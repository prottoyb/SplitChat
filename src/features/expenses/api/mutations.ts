import { supabase } from '../../../shared/api/supabase'
import { failureFrom, guard, ok, type Result } from '../../../shared/api/result'
import type { ExpenseInput } from '../domain/expenseForm'

/**
 * The client side of the canonical expense service (ADR-0002, ADR-0006,
 * ADR-0008 rule 9): every ledger write is a server RPC that authorizes the
 * caller, validates the input and applies the canonical equal split. Amounts
 * are integer cents. Failures carry a code (`stale`, `forbidden`, ...).
 */

export function createEqualSplitExpense(groupId: string, expense: ExpenseInput): Promise<Result<string>> {
  return guard(async () => {
    const { data, error } = await supabase.rpc('create_equal_split_expense_v2', {
      p_group_id: groupId,
      p_description: expense.description,
      p_amount_cents: expense.amountCents,
      p_expense_date: expense.expenseDate,
      p_paid_by: expense.paidBy,
      p_participant_ids: expense.participantIds,
      p_notes: expense.notes,
    })
    if (error) return failureFrom(error, 'Unable to create this expense. Please try again.')
    return ok(data as string)
  }, 'Unable to create this expense.')
}

/**
 * `expectedUpdatedAt` must be the expense's `updated_at` exactly as loaded
 * (a string with microseconds — never round-tripped through `Date`); the
 * server refuses the change (`stale`) if anyone changed it since. Returns
 * the new `updated_at`.
 */
export function updateEqualSplitExpense(
  expenseId: string,
  expectedUpdatedAt: string,
  expense: ExpenseInput,
): Promise<Result<string>> {
  return guard(async () => {
    const { data, error } = await supabase.rpc('update_equal_split_expense', {
      p_expense_id: expenseId,
      p_expected_updated_at: expectedUpdatedAt,
      p_description: expense.description,
      p_amount_cents: expense.amountCents,
      p_expense_date: expense.expenseDate,
      p_paid_by: expense.paidBy,
      p_participant_ids: expense.participantIds,
      p_notes: expense.notes,
    })
    if (error) return failureFrom(error, 'Unable to update this expense. Please try again.')
    return ok(data as string)
  }, 'Unable to update this expense.')
}

export function deleteExpense(expenseId: string, expectedUpdatedAt: string): Promise<Result<void>> {
  return guard(async () => {
    const { error } = await supabase.rpc('delete_expense', {
      p_expense_id: expenseId,
      p_expected_updated_at: expectedUpdatedAt,
    })
    if (error) return failureFrom(error, 'Unable to delete this expense. Please try again.')
    return ok(undefined)
  }, 'Unable to delete this expense.')
}
