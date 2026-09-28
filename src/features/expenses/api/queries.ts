import { supabase } from '../../../shared/api/supabase'
import { fail, failureFrom, guard, ok, type Result } from '../../../shared/api/result'
import { readCents } from '../../../shared/domain/money'
import { loadGroupDetail, type Member, type Role } from '../../groups'
import { nameOf, resolveDisplayNames, type NameMap } from '../../people'

/** Explicit columns only (ADR-0008 rule 4); money arrives as integer cents. */
const EXPENSE_COLUMNS =
  'id, group_id, description, amount_cents, expense_date, paid_by, created_by, updated_by, notes, created_at, updated_at'

type ExpenseRow = {
  id: string
  group_id: string
  description: string
  amount_cents: unknown
  expense_date: string
  paid_by: string
  created_by: string
  updated_by: string | null
  notes: string | null
  created_at: string
  updated_at: string
}
type SplitRow = { expense_id: string; user_id: string; share_cents: unknown }


export type ExpenseListItem = {
  id: string
  groupId: string
  groupName: string
  description: string
  amountCents: number
  expenseDate: string
  paidBy: string
  paidByName: string
  myShareCents: number | null
  notes: string | null
}

/**
 * Expenses in the caller's active groups (RLS), newest first, with group
 * names, payer names and the caller's own share. Optionally one group only,
 * dated on or after `since` (YYYY-MM-DD), and at most `limit` of them — so a
 * summary or preview never loads a group's whole history.
 */
export function listMyExpenses(
  userId: string,
  { groupId, since, limit }: { groupId?: string; since?: string; limit?: number } = {},
): Promise<Result<ExpenseListItem[]>> {
  return guard(async () => {
    let query = supabase.from('expenses').select(EXPENSE_COLUMNS)
    if (groupId) query = query.eq('group_id', groupId)
    if (since) query = query.gte('expense_date', since)
    let ordered = query
      .order('expense_date', { ascending: false })
      .order('created_at', { ascending: false })
    if (limit) ordered = ordered.limit(limit)
    const expenses = await ordered
    if (expenses.error) return failureFrom(expenses.error, 'Unable to load your expenses.')
    const rows = (expenses.data ?? []) as ExpenseRow[]
    if (rows.length === 0) return ok([])

    const groupIds = [...new Set(rows.map((e) => e.group_id))]
    const [groups, splits] = await Promise.all([
      supabase.from('groups').select('id, name').in('id', groupIds),
      supabase
        .from('expense_splits')
        .select('expense_id, user_id, share_cents')
        .in('expense_id', rows.map((e) => e.id))
        .eq('user_id', userId),
    ])
    if (groups.error) return failureFrom(groups.error, 'Unable to load expense group information.')
    if (splits.error) return failureFrom(splits.error, 'Unable to load your expense shares.')

    const names = await resolveDisplayNames(
      groupIds.map((groupId) => ({
        groupId,
        userIds: rows.filter((e) => e.group_id === groupId).map((e) => e.paid_by),
      })),
    )
    if (!names.ok) return names

    const groupNames = new Map(((groups.data ?? []) as { id: string; name: string }[]).map((g) => [g.id, g.name]))
    const myShares = new Map(((splits.data ?? []) as SplitRow[]).map((s) => [s.expense_id, readCents(s.share_cents)]))

    const items: ExpenseListItem[] = []
    for (const e of rows) {
      const amountCents = readCents(e.amount_cents)
      const share = myShares.has(e.id) ? myShares.get(e.id) : undefined
      // Money must be integer cents; anything else is an unexpected response.
      if (amountCents === null || share === null) return fail('unknown', 'Unable to load your expenses.')
      items.push({
        id: e.id,
        groupId: e.group_id,
        groupName: groupNames.get(e.group_id) ?? 'SplitChat group',
        description: e.description,
        amountCents,
        expenseDate: e.expense_date,
        paidBy: e.paid_by,
        paidByName: nameOf(names.value, e.paid_by),
        myShareCents: share ?? null,
        notes: e.notes,
      })
    }
    return ok(items)
  }, 'Unable to load your expenses.')
}

export type ExpenseSplitLine = { userId: string; name: string; shareCents: number }

export type ExpenseDetail = {
  id: string
  groupId: string
  groupName: string
  description: string
  amountCents: number
  expenseDate: string
  paidBy: string
  createdBy: string
  updatedBy: string | null
  notes: string | null
  createdAt: string
  /** Exactly as loaded (microseconds) — sent back for concurrency checks. */
  updatedAt: string
  splits: ExpenseSplitLine[]
  names: NameMap
  myRole: Role | null
  /** UI hint only (creator while a member, or the owner); the server decides. */
  canManage: boolean
}

export function loadExpenseDetail(expenseId: string, userId: string): Promise<Result<ExpenseDetail>> {
  return guard(async () => {
    const expense = await supabase.from('expenses').select(EXPENSE_COLUMNS).eq('id', expenseId).limit(1)
    if (expense.error) return failureFrom(expense.error, 'Unable to load this expense.')
    const row = ((expense.data ?? []) as ExpenseRow[])[0]
    if (!row) return fail('not_found', 'This expense does not exist or you do not have access to it.')

    const [group, splits, membership] = await Promise.all([
      supabase.from('groups').select('id, name').eq('id', row.group_id).limit(1),
      supabase
        .from('expense_splits')
        .select('expense_id, user_id, share_cents')
        .eq('expense_id', row.id)
        .order('user_id', { ascending: true }),
      supabase
        .from('group_members')
        .select('role')
        .eq('group_id', row.group_id)
        .eq('user_id', userId)
        .is('left_at', null)
        .limit(1),
    ])
    if (group.error) return failureFrom(group.error, 'Unable to load the expense group.')
    const groupRow = ((group.data ?? []) as { id: string; name: string }[])[0]
    if (!groupRow) return fail('not_found', 'The group for this expense is unavailable.')
    if (splits.error) return failureFrom(splits.error, 'Unable to load the expense split information.')

    const splitRows = (splits.data ?? []) as SplitRow[]
    const people = [row.paid_by, row.created_by, ...(row.updated_by ? [row.updated_by] : []), ...splitRows.map((s) => s.user_id)]
    const names = await resolveDisplayNames([{ groupId: row.group_id, userIds: people }])
    if (!names.ok) return names

    const amountCents = readCents(row.amount_cents)
    const splitLines: ExpenseSplitLine[] = []
    for (const s of splitRows) {
      const shareCents = readCents(s.share_cents)
      if (shareCents === null) return fail('unknown', 'Unable to load this expense.')
      splitLines.push({ userId: s.user_id, name: nameOf(names.value, s.user_id), shareCents })
    }
    if (amountCents === null) return fail('unknown', 'Unable to load this expense.')

    // The role query only decides which actions to offer.
    const myRole = membership.error ? null : ((membership.data ?? [])[0] as { role?: Role } | undefined)?.role ?? null
    return ok({
      id: row.id,
      groupId: row.group_id,
      groupName: groupRow.name,
      description: row.description,
      amountCents,
      expenseDate: row.expense_date,
      paidBy: row.paid_by,
      createdBy: row.created_by,
      updatedBy: row.updated_by,
      notes: row.notes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      splits: splitLines,
      names: names.value,
      myRole,
      canManage: myRole !== null && (row.created_by === userId || myRole === 'owner'),
    })
  }, 'Unable to load this expense.')
}

/** A person selectable in the expense form. */
export type FormPerson = { userId: string; name: string; current: boolean }

export type ExpenseFormContext = {
  groupId: string
  groupName: string
  /** Current members first (join order), then former people on the expense. */
  people: FormPerson[]
  /** Present when editing. */
  expense: ExpenseDetail | null
}

const toPerson = (m: Member): FormPerson => ({ userId: m.userId, name: m.fullName, current: true })

/** Everything the "add expense" form needs. */
export function loadNewExpenseContext(groupId: string, userId: string): Promise<Result<ExpenseFormContext>> {
  return guard(async () => {
    const group = await loadGroupDetail(groupId, userId)
    if (!group.ok) return group
    if (group.value.myRole === null) return fail('not_found', 'This group does not exist or you do not have access to it.')
    return ok({ groupId, groupName: group.value.name, people: group.value.members.map(toPerson), expense: null })
  }, 'Unable to load this group.')
}

/**
 * Everything the "edit expense" form needs: the expense plus its current
 * group members, with the expense's former payer/participants added (the
 * server lets an edit keep them, never add new former members).
 */
export function loadEditExpenseContext(expenseId: string, userId: string): Promise<Result<ExpenseFormContext>> {
  return guard(async () => {
    const expense = await loadExpenseDetail(expenseId, userId)
    if (!expense.ok) return expense
    const group = await loadGroupDetail(expense.value.groupId, userId)
    if (!group.ok) return group

    const people = group.value.members.map(toPerson)
    const known = new Set(people.map((p) => p.userId))
    for (const id of [expense.value.paidBy, ...expense.value.splits.map((s) => s.userId)]) {
      if (!known.has(id)) {
        known.add(id)
        people.push({ userId: id, name: nameOf(expense.value.names, id), current: false })
      }
    }
    return ok({ groupId: expense.value.groupId, groupName: expense.value.groupName, people, expense: expense.value })
  }, 'Unable to load this expense.')
}
