import { useId, useState } from 'react'
import { formatDateShort } from '../../../shared/domain/dates'
import { formatCents } from '../../../shared/domain/money'
import { nameOf, type NameMap } from '../../people'
import type { Settlement } from '../api/settlements'
import { MAX_REASON_LENGTH, validateVoidReason } from '../domain/settlementForm'
import styles from './settlements.module.css'

/**
 * Recorded payments, newest first. Voided payments stay listed (struck
 * through, with who voided them and why); either person involved or the
 * owner can void a payment once.
 */
export function SettlementHistory({
  settlements,
  names,
  currentUserId,
  isOwner,
  onVoid,
}: {
  settlements: readonly Settlement[]
  names: NameMap
  currentUserId: string
  isOwner: boolean
  /** Resolves with an error message, or null on success. */
  onVoid: (settlement: Settlement, reason: string) => Promise<string | null>
}) {
  if (settlements.length === 0) return <p className={styles.muted}>No payments have been recorded yet.</p>
  const who = (id: string) => (id === currentUserId ? 'You' : nameOf(names, id))
  const whom = (id: string) => (id === currentUserId ? 'you' : nameOf(names, id))

  return (
    <ul className={styles.history} aria-label="Payment history">
      {settlements.map((s) => {
        const canVoid = !s.voided && (isOwner || s.fromUserId === currentUserId || s.toUserId === currentUserId)
        return (
          <li key={s.id} className={`${styles.entry} ${s.voided ? styles.voided : ''}`}>
            <div className={styles.entryMain}>
              <p className={styles.entryText}>
                <strong>{who(s.fromUserId)}</strong> paid <strong>{whom(s.toUserId)}</strong>{' '}
                <span className={styles.entryAmount}>{formatCents(s.amountCents)}</span>
                {s.voided && <span className={styles.voidTag}>Voided</span>}
              </p>
              <p className={styles.entryMeta}>
                {formatDateShort(s.settledOn)}
                {s.createdBy !== s.fromUserId && ` · recorded by ${who(s.createdBy)}`}
                {s.note && ` · ${s.note}`}
              </p>
              {s.voided && (
                <p className={styles.entryMeta}>
                  Voided by {who(s.voided.by)}: {s.voided.reason}
                </p>
              )}
            </div>
            {canVoid && <VoidControl onVoid={(reason) => onVoid(s, reason)} />}
          </li>
        )
      })}
    </ul>
  )
}

function VoidControl({ onVoid }: { onVoid: (reason: string) => Promise<string | null> }) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (!open) {
    return (
      <button type="button" className={styles.linkButton} onClick={() => setOpen(true)}>
        Void
      </button>
    )
  }

  const confirm = async () => {
    const problem = validateVoidReason(reason)
    if (problem) {
      setError(problem)
      return
    }
    setBusy(true)
    const failure = await onVoid(reason.trim())
    setBusy(false)
    if (failure) setError(failure)
    else setOpen(false)
  }

  return (
    <div className={styles.voidBox} role="group" aria-label="Void this payment">
      <label htmlFor={`${id}-reason`}>Why is this payment being voided?</label>
      <input
        id={`${id}-reason`}
        type="text"
        value={reason}
        maxLength={MAX_REASON_LENGTH}
        placeholder="e.g. Recorded twice"
        onChange={(e) => {
          setReason(e.target.value)
          setError(null)
        }}
        disabled={busy}
        {...(error ? { 'aria-invalid': true as const, 'aria-describedby': `${id}-error` } : {})}
      />
      {error && (
        <p id={`${id}-error`} className={styles.fieldError}>
          {error}
        </p>
      )}
      <p className={styles.hint}>The payment stays in the history and the balance it settled comes back.</p>
      <div className={styles.voidActions}>
        <button type="button" className={styles.dangerButton} onClick={() => void confirm()} disabled={busy}>
          {busy ? 'Voiding…' : 'Void payment'}
        </button>
        <button type="button" className={styles.linkButton} onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  )
}
