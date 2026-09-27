import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSupabaseMock } from '../../../test/supabaseMock'
import {
  createEqualSplitExpense,
  deleteExpense,
  updateEqualSplitExpense,
} from './mutations'
import type { ExpenseInput } from '../domain/expenseForm'

const mock = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('../../../shared/api/supabase', () => ({
  get supabase() {
    return (mock.current as ReturnType<typeof createSupabaseMock>).client
  },
}))

let supabaseMock: ReturnType<typeof createSupabaseMock>

const input: ExpenseInput = {
  description: 'Dinner',
  amountCents: 1050,
  expenseDate: '2026-09-25',
  paidBy: 'u1',
  participantIds: ['u2', 'u1'],
  notes: null,
}

beforeEach(() => {
  supabaseMock = createSupabaseMock()
  mock.current = supabaseMock
})

describe('createEqualSplitExpense', () => {
  it('calls v2 with integer cents and returns the new id', async () => {
    supabaseMock.setRpc('create_equal_split_expense_v2', 'x9')

    await expect(createEqualSplitExpense('g1', input)).resolves.toEqual({ ok: true, value: 'x9' })
    expect(supabaseMock.rpc).toHaveBeenCalledWith('create_equal_split_expense_v2', {
      p_group_id: 'g1',
      p_description: 'Dinner',
      p_amount_cents: 1050,
      p_expense_date: '2026-09-25',
      p_paid_by: 'u1',
      p_participant_ids: ['u2', 'u1'],
      p_notes: null,
    })
  })

  it('maps error codes and hides raw messages', async () => {
    supabaseMock.setRpc('create_equal_split_expense_v2', null, { message: 'invalid_payer' })
    await expect(createEqualSplitExpense('g1', input)).resolves.toEqual({
      ok: false,
      code: 'validation',
      message: 'The payer must be a current member of this group.',
    })

    supabaseMock.setRpc('create_equal_split_expense_v2', null, { message: 'relation "x" does not exist' })
    await expect(createEqualSplitExpense('g1', input)).resolves.toEqual({
      ok: false,
      code: 'unknown',
      message: 'Unable to create this expense. Please try again.',
    })
  })
})

describe('updateEqualSplitExpense', () => {
  it('sends the expected updated_at and returns the new one', async () => {
    supabaseMock.setRpc('update_equal_split_expense', '2026-09-26T01:00:00.123456+00:00')

    await expect(
      updateEqualSplitExpense('x1', '2026-09-25T10:00:00.654321+00:00', input),
    ).resolves.toEqual({ ok: true, value: '2026-09-26T01:00:00.123456+00:00' })
    expect(supabaseMock.rpc).toHaveBeenCalledWith('update_equal_split_expense', {
      p_expense_id: 'x1',
      p_expected_updated_at: '2026-09-25T10:00:00.654321+00:00',
      p_description: 'Dinner',
      p_amount_cents: 1050,
      p_expense_date: '2026-09-25',
      p_paid_by: 'u1',
      p_participant_ids: ['u2', 'u1'],
      p_notes: null,
    })
  })

  it.each([
    ['stale_expense', 'stale', /changed by someone else/],
    ['forbidden', 'forbidden', /added this expense or the group owner/],
    ['not_found_or_forbidden', 'not_found', /unavailable, or you do not have permission/],
  ])('maps %s to the %s code', async (rpcCode, code, text) => {
    supabaseMock.setRpc('update_equal_split_expense', null, { message: rpcCode })
    const outcome = await updateEqualSplitExpense('x1', 't', input)

    expect(outcome).toMatchObject({ ok: false, code })
    expect(!outcome.ok && outcome.message).toMatch(text)
  })

  it('sends the loaded updated_at string unchanged (microsecond precision)', async () => {
    supabaseMock.setRpc('update_equal_split_expense', '2026-09-27T01:00:00.000001+00:00')
    const loaded = '2026-09-26T12:46:35.510649+00:00'

    await updateEqualSplitExpense('x1', loaded, input)

    const args = supabaseMock.rpc.mock.calls.at(-1)?.[1]
    expect(args?.p_expected_updated_at).toBe(loaded)
    expect(new Date(loaded).toISOString()).not.toBe(loaded) // a Date round trip would lose it
  })
})

describe('deleteExpense', () => {
  it('sends the expected updated_at', async () => {
    await expect(deleteExpense('x1', 't1')).resolves.toEqual({ ok: true, value: undefined })
    expect(supabaseMock.rpc).toHaveBeenCalledWith('delete_expense', {
      p_expense_id: 'x1',
      p_expected_updated_at: 't1',
    })
  })

  it('maps errors with a delete-specific fallback', async () => {
    supabaseMock.setRpc('delete_expense', null, { message: 'stale_expense' })
    await expect(deleteExpense('x1', 't1')).resolves.toEqual({
      ok: false,
      code: 'stale',
      message: 'This expense was changed by someone else. Reload it and try again.',
    })

    supabaseMock.setRpc('delete_expense', null, { message: 'boom' })
    await expect(deleteExpense('x1', 't1')).resolves.toEqual({
      ok: false,
      code: 'unknown',
      message: 'Unable to delete this expense. Please try again.',
    })
  })
})
