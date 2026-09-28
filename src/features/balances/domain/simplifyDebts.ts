/**
 * Deterministic repayment plan from net balances (ADR-0010). Integer cents
 * only; the plan is advisory — every payment is re-checked by the server
 * when it is recorded.
 */

export type NetBalance = { userId: string; netCents: number }
export type Transfer = { from: string; to: string; amountCents: number }

type Side = { userId: string; cents: number }

// Larger amounts first; equal amounts by user id (plain string order on
// lowercase UUIDs, so every client orders them the same way).
const byAmountThenId = (a: Side, b: Side) =>
  b.cents - a.cents || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0)

/**
 * Greedy settlement: repeatedly moves min(debt, credit) from the largest
 * debtor to the largest creditor, advancing whichever reaches zero. At most
 * n − 1 transfers; identical input always gives the identical plan.
 * Throws for input that is not a valid ledger (non-integer cents, duplicate
 * people, or balances that do not sum to zero).
 */
export function simplifyDebts(balances: readonly NetBalance[]): Transfer[] {
  const seen = new Set<string>()
  let total = 0
  for (const b of balances) {
    if (!Number.isSafeInteger(b.netCents)) throw new RangeError('net balances must be safe integer cents')
    if (seen.has(b.userId)) throw new RangeError('each person may appear once')
    seen.add(b.userId)
    total += b.netCents
  }
  if (total !== 0) throw new RangeError('net balances must sum to zero')

  const debtors = balances
    .filter((b) => b.netCents < 0)
    .map((b) => ({ userId: b.userId, cents: -b.netCents }))
    .sort(byAmountThenId)
  const creditors = balances
    .filter((b) => b.netCents > 0)
    .map((b) => ({ userId: b.userId, cents: b.netCents }))
    .sort(byAmountThenId)

  const plan: Transfer[] = []
  let d = 0
  let c = 0
  while (d < debtors.length && c < creditors.length) {
    const amount = Math.min(debtors[d].cents, creditors[c].cents)
    plan.push({ from: debtors[d].userId, to: creditors[c].userId, amountCents: amount })
    debtors[d].cents -= amount
    creditors[c].cents -= amount
    if (debtors[d].cents === 0) d += 1
    if (creditors[c].cents === 0) c += 1
  }
  return plan
}
