import { supabase } from '../../../shared/api/supabase'
import { fail, failureFrom, guard, ok, type Result } from '../../../shared/api/result'
import { readCents } from '../../../shared/domain/money'
import { resolveDisplayNames, type NameMap } from '../../people'

export type PersonBalance = {
  userId: string
  paidCents: number
  owedCents: number
  settledOutCents: number
  settledInCents: number
  /** Positive: is owed; negative: owes. */
  netCents: number
}

export type GroupBalances = {
  people: PersonBalance[]
  /** Names for everyone in `people`, including former and deleted members. */
  names: NameMap
}

type BalanceRow = {
  user_id: unknown
  paid_cents: unknown
  owed_cents: unknown
  settled_out_cents: unknown
  settled_in_cents: unknown
  net_cents: unknown
}

const UNEXPECTED = 'Balances could not be read. Please try again.'

/**
 * Server-computed balances for one group (ADR-0010; active members only,
 * enforced by the RPC). Every amount is checked to be safe integer cents and
 * the group must net to zero; anything else is reported as a failure rather
 * than shown as a wrong number.
 */
export function loadGroupBalances(groupId: string): Promise<Result<GroupBalances>> {
  return guard(async () => {
    const { data, error } = await supabase.rpc('get_group_balances', { p_group_id: groupId })
    if (error) return failureFrom(error, 'Unable to load balances.')

    const people: PersonBalance[] = []
    for (const row of (Array.isArray(data) ? data : []) as BalanceRow[]) {
      const values = [row.paid_cents, row.owed_cents, row.settled_out_cents, row.settled_in_cents, row.net_cents].map(readCents)
      if (typeof row.user_id !== 'string' || values.some((v) => v === null)) return fail('unknown', UNEXPECTED)
      const [paidCents, owedCents, settledOutCents, settledInCents, netCents] = values as number[]
      if (paidCents - owedCents + settledOutCents - settledInCents !== netCents) return fail('unknown', UNEXPECTED)
      people.push({ userId: row.user_id, paidCents, owedCents, settledOutCents, settledInCents, netCents })
    }
    if (people.reduce((sum, p) => sum + p.netCents, 0) !== 0) return fail('unknown', UNEXPECTED)

    const names = await resolveDisplayNames([{ groupId, userIds: people.map((p) => p.userId) }])
    if (!names.ok) return names
    return ok({ people, names: names.value })
  }, 'Unable to load balances.')
}
