import type { ReactNode } from 'react'
import { formatCents } from '../../../shared/domain/money'
import { Avatar } from '../../../shared/ui'
import { nameOf, type NameMap } from '../../people'
import type { PersonBalance } from '../api/balances'
import { balanceText } from '../domain/balanceText'
import type { Transfer } from '../domain/simplifyDebts'
import styles from './balances.module.css'

const tone = (netCents: number) => (netCents < 0 ? styles.owes : netCents > 0 ? styles.owed : styles.settled)

/**
 * Everyone with a balance in the group, largest amounts first. People who
 * are no longer members keep their balance and are labelled.
 */
export function BalanceList({
  people,
  names,
  currentUserId,
  activeMemberIds,
}: {
  people: readonly PersonBalance[]
  names: NameMap
  currentUserId: string
  activeMemberIds: ReadonlySet<string>
}) {
  const sorted = [...people].sort(
    (a, b) => Math.abs(b.netCents) - Math.abs(a.netCents) || nameOf(names, a.userId).localeCompare(nameOf(names, b.userId)),
  )
  return (
    <ul className={styles.list} aria-label="Balances">
      {sorted.map((p) => {
        const isYou = p.userId === currentUserId
        const name = isYou ? 'You' : nameOf(names, p.userId)
        return (
          <li key={p.userId} className={styles.row}>
            <Avatar name={nameOf(names, p.userId)} />
            <div className={styles.who}>
              <strong>{name}</strong>
              {!activeMemberIds.has(p.userId) && <span className={styles.tag}>Former member</span>}
            </div>
            <span className={`${styles.amount} ${tone(p.netCents)}`}>{balanceText(p.netCents, isYou)}</span>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * The suggested payments that settle the group (from `simplifyDebts`).
 * `action` renders an optional control per payment (e.g. "Record").
 */
export function RepaymentPlan({
  plan,
  names,
  currentUserId,
  action,
}: {
  plan: readonly Transfer[]
  names: NameMap
  currentUserId: string
  action?: (transfer: Transfer) => ReactNode
}) {
  const who = (id: string) => (id === currentUserId ? 'You' : nameOf(names, id))
  const whom = (id: string) => (id === currentUserId ? 'you' : nameOf(names, id))
  return (
    <ol className={styles.list} aria-label="Suggested payments">
      {plan.map((t) => (
        <li key={`${t.from}-${t.to}`} className={styles.row}>
          <p className={styles.sentence}>
            <strong>{who(t.from)}</strong> {t.from === currentUserId ? 'pay' : 'pays'} <strong>{whom(t.to)}</strong>{' '}
            <span className={styles.planAmount}>{formatCents(t.amountCents)}</span>
          </p>
          {action?.(t)}
        </li>
      ))}
    </ol>
  )
}
