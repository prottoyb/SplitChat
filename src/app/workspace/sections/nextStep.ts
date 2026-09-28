import { formatCents } from '../../../shared/domain/money'
import type { Transfer } from '../../../features/balances'
import type { GroupDetail } from '../../../features/groups'
import { nameOf, type NameMap } from '../../../features/people'

export type NextStep = { text: string; to: string; label: string }

export type Plan = { transfers: Transfer[]; names: NameMap }

const more = (n: number) => (n > 1 ? ` and ${n - 1} more` : '')

/**
 * The one thing most worth doing next, if anything. The header already
 * states the position, so this names the payment to make or expect (the
 * same fewest-payments plan as Balances) and links to it pre-filled.
 */
export function nextStep(group: GroupDetail, userId: string, plan: Plan | null, expenseCount: number | null): NextStep | null {
  const base = `/groups/${group.id}`
  const settleLink = (t: Transfer) => `${base}/balances?settle=${t.from}~${t.to}`
  const pay = plan?.transfers.filter((t) => t.from === userId) ?? []
  if (pay.length > 0 && plan) {
    const t = pay[0]
    return { text: `Pay ${nameOf(plan.names, t.to)} ${formatCents(t.amountCents)}${more(pay.length)}.`, to: settleLink(t), label: 'Record your payment' }
  }
  const receive = plan?.transfers.filter((t) => t.to === userId) ?? []
  if (receive.length > 0 && plan) {
    const t = receive[0]
    return {
      text: `${nameOf(plan.names, t.from)} owes you ${formatCents(t.amountCents)}${more(receive.length)}.`,
      to: settleLink(t),
      label: 'Record a payment',
    }
  }
  if (group.members.length === 1) {
    return {
      text: 'You are the only member. Add people to start splitting costs.',
      to: `${base}/members`,
      label: group.myRole === 'owner' ? 'Add members' : 'View members',
    }
  }
  if (expenseCount === 0) {
    return { text: 'No expenses yet. Record the first shared cost.', to: `${base}/expenses/new`, label: 'Add an expense' }
  }
  return null
}

