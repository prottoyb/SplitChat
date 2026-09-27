import { formatCents } from '../../../shared/domain/money'

/** "owes $5.00" / "is owed $5.00" / "is settled up" (words, not only colour). */
export function balanceText(netCents: number, isYou: boolean): string {
  if (netCents < 0) return `${isYou ? 'owe' : 'owes'} ${formatCents(-netCents)}`
  if (netCents > 0) return `${isYou ? 'are' : 'is'} owed ${formatCents(netCents)}`
  return `${isYou ? 'are' : 'is'} settled up`
}
