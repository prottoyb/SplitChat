import { formatCents, parseAmountToCents } from '../../../shared/domain/money'
import type { FormPerson } from '../api/queries'
import { allocateEqualSplit } from '../domain/expenseSplit'
import styles from './ExpenseForm.module.css'

/**
 * The canonical equal split (ADR-0006) for the current form values —
 * presentation only; the server computes the stored split with the same
 * rule. Shares are looked up by user id, so selection order never matters.
 */
export function SplitPreview({
  amount,
  participants,
  currentUserId,
}: {
  amount: string
  participants: FormPerson[]
  currentUserId: string
}) {
  const parsed = parseAmountToCents(amount)
  const allocation = parsed.ok ? allocateEqualSplit(parsed.cents, participants.map((p) => p.userId)) : null
  const shareOf = new Map(allocation?.ok ? allocation.shares.map((s) => [s.userId, s.shareCents]) : [])

  return (
    <article className={`${styles.panel} ${styles.previewPanel}`} aria-live="polite">
      <div className={styles.panelHeader}>
        <div>
          <p className="eyebrow">SPLIT PREVIEW</p>
          <h3>Equal split</h3>
        </div>
      </div>

      {parsed.ok && allocation?.ok ? (
        <>
          <div className={styles.totalSummary}>
            <span>Total expense</span>
            <strong>{formatCents(parsed.cents)}</strong>
            <p>
              Shared between {participants.length} {participants.length === 1 ? 'person' : 'people'}
            </p>
          </div>
          <div className={styles.splitList}>
            {participants.map((person) => (
              <div key={person.userId} className={styles.splitRow}>
                <div>
                  <strong>{person.name}</strong>
                  {person.userId === currentUserId && <span>You</span>}
                </div>
                <strong>{formatCents(shareOf.get(person.userId.toLowerCase()) ?? 0)}</strong>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className={styles.emptyPreview}>
          <div aria-hidden="true">÷</div>
          <h4>Your split will appear here</h4>
          <p>Enter an amount and select at least one participant.</p>
        </div>
      )}
    </article>
  )
}
