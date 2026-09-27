import { rpcErrorMessage } from '../../shared/api/rpcErrors'
import { supabase } from '../../shared/api/supabase'

/**
 * The client side of the canonical expense service (ADR-0002, ADR-0006).
 * Every ledger write goes through a server RPC that authorizes the caller,
 * validates the input and applies the canonical equal split; amounts are
 * always integer cents. Errors come back as user-facing text only.
 */

export type ExpenseInput = {
  description: string
  amountCents: number
  expenseDate: string
  paidBy: string
  participantIds: string[]
  notes: string | null
}

export type ExpenseOutcome<T = undefined> =
  | { ok: true; value: T }
  | { ok: false; message: string }

export async function createEqualSplitExpense(
  groupId: string,
  expense: ExpenseInput,
): Promise<ExpenseOutcome<string>> {
  const { data, error } = await supabase.rpc('create_equal_split_expense_v2', {
    p_group_id: groupId,
    p_description: expense.description,
    p_amount_cents: expense.amountCents,
    p_expense_date: expense.expenseDate,
    p_paid_by: expense.paidBy,
    p_participant_ids: expense.participantIds,
    p_notes: expense.notes,
  })

  if (error) {
    return {
      ok: false,
      message: rpcErrorMessage(error, 'Unable to create this expense. Please try again.'),
    }
  }

  return { ok: true, value: data as string }
}

/**
 * `expectedUpdatedAt` is the expense's updated_at exactly as loaded; the
 * server refuses the change (stale_expense) if anyone changed it since.
 * Returns the new updated_at.
 */
export async function updateEqualSplitExpense(
  expenseId: string,
  expectedUpdatedAt: string,
  expense: ExpenseInput,
): Promise<ExpenseOutcome<string>> {
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

  if (error) {
    return {
      ok: false,
      message: rpcErrorMessage(error, 'Unable to update this expense. Please try again.'),
    }
  }

  return { ok: true, value: data as string }
}

export async function deleteExpense(
  expenseId: string,
  expectedUpdatedAt: string,
): Promise<ExpenseOutcome> {
  const { error } = await supabase.rpc('delete_expense', {
    p_expense_id: expenseId,
    p_expected_updated_at: expectedUpdatedAt,
  })

  if (error) {
    return {
      ok: false,
      message: rpcErrorMessage(error, 'Unable to delete this expense. Please try again.'),
    }
  }

  return { ok: true, value: undefined }
}
