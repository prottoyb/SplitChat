import { useId, useState, type FormEvent } from 'react'
import type { Failure } from '../../../shared/api/result'
import { formatCents } from '../../../shared/domain/money'
import { balanceText } from '../../balances'
import {
  MAX_NOTE_LENGTH,
  maxPayableCents,
  validateSettlementForm,
  type SettlementErrors,
  type SettlementField,
  type SettlementFormValues,
  type SettlementInput,
} from '../domain/settlementForm'
import styles from './settlements.module.css'

export type Party = { userId: string; name: string; netCents: number }

type Props = {
  people: readonly Party[]
  currentUserId: string
  /** The owner may record a payment between any two people. */
  isOwner: boolean
  initial: SettlementFormValues
  /** Resolves with a failure to show, or null on success. */
  onSubmit: (input: SettlementInput) => Promise<Failure | null>
}

/**
 * Records a (possibly partial) payment. Only a debtor can pay and only a
 * creditor can receive, so a payment can never reverse a debt; a member who
 * is not the owner records only payments they are part of (the server
 * enforces both).
 */
export function SettlementForm({ people, currentUserId, isOwner, initial, onSubmit }: Props) {
  const ids = useId()
  const [values, setValues] = useState<SettlementFormValues>(initial)
  const [errors, setErrors] = useState<SettlementErrors>({})
  const [submitting, setSubmitting] = useState(false)

  const netByUser = new Map(people.map((p) => [p.userId, p.netCents]))
  const me = netByUser.get(currentUserId) ?? 0
  const debtors = people.filter((p) => p.netCents < 0 && (isOwner || me >= 0 || p.userId === currentUserId))
  const creditors = people.filter((p) => p.netCents > 0 && (isOwner || me <= 0 || p.userId === currentUserId))
  const canRecord = isOwner ? debtors.length > 0 && creditors.length > 0 : me !== 0
  const max = maxPayableCents(netByUser, values.fromUserId, values.toUserId)

  if (!canRecord) {
    return (
      <p className={styles.muted}>
        {isOwner ? 'Everyone is settled up.' : 'You are settled up, so there is no payment of yours to record.'}
      </p>
    )
  }

  const set = <K extends keyof SettlementFormValues>(key: K, value: SettlementFormValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }))
    const field: SettlementField = key === 'fromUserId' || key === 'toUserId' ? 'parties' : (key as SettlementField)
    if (errors[field]) setErrors((e) => ({ ...e, [field]: undefined }))
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const result = validateSettlementForm(values, netByUser)
    if (!result.ok) {
      setErrors(result.errors)
      return
    }
    setErrors({})
    setSubmitting(true)
    const failure = await onSubmit(result.value)
    setSubmitting(false)
    if (!failure) setValues((v) => ({ ...v, amount: '', note: '' }))
  }

  const fieldId = (name: string) => `${ids}-${name}`
  const describe = (field: SettlementField, hintId?: string) => {
    const describedBy = [hintId, errors[field] ? fieldId(`${field}-error`) : null].filter(Boolean).join(' ')
    return {
      ...(errors[field] ? { 'aria-invalid': true as const } : {}),
      ...(describedBy ? { 'aria-describedby': describedBy } : {}),
    }
  }
  const fieldError = (field: SettlementField) =>
    errors[field] ? (
      <p id={fieldId(`${field}-error`)} className={styles.fieldError}>
        {errors[field]}
      </p>
    ) : null
  // Short enough to read in a half-width select; "You" needs no name.
  const label = (p: Party) => `${p.userId === currentUserId ? 'You' : p.name} — ${balanceText(p.netCents, p.userId === currentUserId)}`

  return (
    <form className={styles.form} onSubmit={submit} noValidate aria-label="Record a payment">
      <div className={styles.pair}>
        <div className={styles.field}>
          <label htmlFor={fieldId('from')}>Paid by</label>
          <select
            id={fieldId('from')}
            value={values.fromUserId}
            onChange={(e) => set('fromUserId', e.target.value)}
            disabled={submitting}
            {...describe('parties')}
          >
            <option value="">Choose…</option>
            {debtors.map((p) => (
              <option key={p.userId} value={p.userId}>
                {label(p)}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label htmlFor={fieldId('to')}>Paid to</label>
          <select
            id={fieldId('to')}
            value={values.toUserId}
            onChange={(e) => set('toUserId', e.target.value)}
            disabled={submitting}
            {...describe('parties')}
          >
            <option value="">Choose…</option>
            {creditors.map((p) => (
              <option key={p.userId} value={p.userId}>
                {label(p)}
              </option>
            ))}
          </select>
        </div>
      </div>
      {fieldError('parties')}

      <div className={styles.pair}>
        <div className={styles.field}>
          <label htmlFor={fieldId('amount')}>Amount</label>
          <div className={styles.amountInput}>
            <span aria-hidden="true">$</span>
            <input
              id={fieldId('amount')}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              value={values.amount}
              onChange={(e) => set('amount', e.target.value)}
              disabled={submitting}
              {...describe('amount', max > 0 ? fieldId('amount-hint') : undefined)}
            />
          </div>
          {max > 0 && (
            <p id={fieldId('amount-hint')} className={styles.hint}>
              Up to {formatCents(max)}. Part payments are fine.
            </p>
          )}
          {fieldError('amount')}
        </div>
        <div className={styles.field}>
          <label htmlFor={fieldId('date')}>Date paid</label>
          <input
            id={fieldId('date')}
            type="date"
            value={values.settledOn}
            onChange={(e) => set('settledOn', e.target.value)}
            disabled={submitting}
            {...describe('settledOn')}
          />
          {fieldError('settledOn')}
        </div>
      </div>

      <div className={styles.field}>
        <label htmlFor={fieldId('note')}>Note (optional)</label>
        <input
          id={fieldId('note')}
          type="text"
          value={values.note}
          maxLength={MAX_NOTE_LENGTH}
          placeholder="e.g. Bank transfer"
          onChange={(e) => set('note', e.target.value)}
          disabled={submitting}
          {...describe('note', fieldId('note-hint'))}
        />
        <p id={fieldId('note-hint')} className={styles.hint}>
          {values.note.length}/{MAX_NOTE_LENGTH}
        </p>
        {fieldError('note')}
      </div>

      <button type="submit" className="primary-button" disabled={submitting}>
        {submitting ? 'Recording…' : 'Record payment'}
      </button>
    </form>
  )
}
