import { formatCents } from '../../../shared/domain/money'

/** "owes $5.00" / "is owed $5.00" / "is settled up" (words, not only colour). */
export function balanceText(netCents: number, isYou: boolean): string {
  if (netCents < 0) return `${isYou ? 'owe' : 'owes'} ${formatCents(-netCents)}`
  if (netCents > 0) return `${isYou ? 'are' : 'is'} owed ${formatCents(netCents)}`
  return `${isYou ? 'are' : 'is'} settled up`
}

export type BalanceTone = 'owes' | 'owed' | 'settled'

/** The caller's position as a sentence: "You owe $5.00", "You are owed $5.00", "You are settled up". */
export function positionText(netCents: number): string {
  return `You ${balanceText(netCents, true)}`
}

export function balanceTone(netCents: number): BalanceTone {
  return netCents < 0 ? 'owes' : netCents > 0 ? 'owed' : 'settled'
}
