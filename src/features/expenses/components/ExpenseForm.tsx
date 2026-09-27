import { useId, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import type { Failure } from '../../../shared/api/result'
import { Avatar } from '../../../shared/ui'
import type { FormPerson } from '../api/queries'
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_NOTES_LENGTH,
  validateExpenseForm,
  type ExpenseField,
  type ExpenseFormValues,
  type ExpenseInput,
  type FieldErrors,
} from '../domain/expenseForm'
import styles from './ExpenseForm.module.css'
import { SplitPreview } from './SplitPreview'

type Props = {
  mode: 'create' | 'edit'
  people: FormPerson[]
  currentUserId: string
  initial: ExpenseFormValues
  /** Resolves with a failure to show in the form, or null on success. */
  onSubmit: (input: ExpenseInput) => Promise<Failure | null>
  /** Shown above the submit button (e.g. a stale-data notice with a reload action). */
  status?: ReactNode
  readOnly?: boolean
  /** Overrides the form's accessible name and submit text (e.g. editing a proposed expense). */
  labels?: { form: string; submit: string; busy: string }
}

/**
 * One form for creating and editing an equal-split expense (ADR-0008 rule 7).
 * Create: current members only. Edit: current members plus the expense's
 * existing payer and participants, labelled "Former member" when they have
 * left (the server allows keeping them, never adding new ones).
 */
export function ExpenseForm({ mode, people, currentUserId, initial, onSubmit, status, readOnly = false, labels }: Props) {
  const ids = useId()
  const [values, setValues] = useState<ExpenseFormValues>(initial)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [submitting, setSubmitting] = useState(false)
  const disabled = submitting || readOnly

  const rules = useMemo(() => {
    const current = people.filter((p) => p.current).map((p) => p.userId)
    const keep = mode === 'edit' ? [initial.paidBy, ...initial.participantIds] : []
    return {
      allowedPayerIds: new Set([...current, ...(mode === 'edit' ? [initial.paidBy] : [])]),
      allowedParticipantIds: new Set([...current, ...keep]),
    }
  }, [people, mode, initial])

  const payerOptions = people.filter((p) => rules.allowedPayerIds.has(p.userId))
  const participantOptions = people.filter((p) => rules.allowedParticipantIds.has(p.userId))
  const selected = participantOptions.filter((p) => values.participantIds.includes(p.userId))

  const set = <K extends keyof ExpenseFormValues>(key: K, value: ExpenseFormValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }))
    const field: ExpenseField = key === 'participantIds' ? 'participants' : (key as ExpenseField)
    if (errors[field]) setErrors((e) => ({ ...e, [field]: undefined }))
  }

  const toggle = (userId: string) =>
    set(
      'participantIds',
      values.participantIds.includes(userId)
        ? values.participantIds.filter((id) => id !== userId)
        : [...values.participantIds, userId],
    )

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const result = validateExpenseForm(values, rules)
    if (!result.ok) {
      setErrors(result.errors)
      return
    }
    setErrors({})
    setSubmitting(true)
    const failure = await onSubmit(result.value)
    setSubmitting(false)
    if (!failure && mode === 'create') {
      setValues((v) => ({ ...v, description: '', amount: '', notes: '' }))
    }
  }

  const fieldId = (name: string) => `${ids}-${name}`
  // aria-describedby lists the field's own hint (if any) and, when present,
  // its error, so neither replaces the other for screen-reader users.
  const errorProps = (field: ExpenseField, hintId?: string) => {
    const describedBy = [hintId, errors[field] ? fieldId(`${field}-error`) : null].filter(Boolean).join(' ')
    return {
      ...(errors[field] ? { 'aria-invalid': true as const } : {}),
      ...(describedBy ? { 'aria-describedby': describedBy } : {}),
    }
  }
  const fieldError = (field: ExpenseField) =>
    errors[field] ? (
      <p id={fieldId(`${field}-error`)} className={styles.fieldError}>
        {errors[field]}
      </p>
    ) : null

  const nameOf = (userId: string) => people.find((p) => p.userId === userId)?.name ?? 'Not selected'

  return (
    <form className={styles.formGrid} onSubmit={submit} noValidate aria-label={labels?.form ?? (mode === 'create' ? 'New expense' : 'Edit expense')}>
      <section className={styles.mainColumn}>
        <article className={styles.panel}>
          <div className={styles.panelHeader}>
            <div>
              <p className="eyebrow">EXPENSE DETAILS</p>
              <h3>What was paid for?</h3>
            </div>
          </div>

          <div className={styles.fieldsGrid}>
            <div className={`${styles.field} ${styles.fullWidth}`}>
              <label className={styles.fieldLabel} htmlFor={fieldId('description')}>
                Description
              </label>
              <input
                id={fieldId('description')}
                type="text"
                value={values.description}
                onChange={(e) => set('description', e.target.value)}
                placeholder="e.g. Dinner, groceries, fuel"
                maxLength={MAX_DESCRIPTION_LENGTH}
                disabled={disabled}
                {...errorProps('description')}
              />
              {fieldError('description')}
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor={fieldId('amount')}>
                Amount
              </label>
              <div className={styles.amountInput}>
                <span aria-hidden="true">$</span>
                <input
                  id={fieldId('amount')}
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={values.amount}
                  onChange={(e) => set('amount', e.target.value)}
                  placeholder="0.00"
                  disabled={disabled}
                  {...errorProps('amount')}
                />
              </div>
              {fieldError('amount')}
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor={fieldId('date')}>
                Date
              </label>
              <input
                id={fieldId('date')}
                type="date"
                value={values.expenseDate}
                onChange={(e) => set('expenseDate', e.target.value)}
                disabled={disabled}
                {...errorProps('expenseDate')}
              />
              {fieldError('expenseDate')}
            </div>

            <div className={`${styles.field} ${styles.fullWidth}`}>
              <label className={styles.fieldLabel} htmlFor={fieldId('payer')}>
                Paid by
              </label>
              <select
                id={fieldId('payer')}
                value={values.paidBy}
                onChange={(e) => set('paidBy', e.target.value)}
                disabled={disabled}
                {...errorProps('paidBy')}
              >
                {!values.paidBy && <option value="">Select who paid</option>}
                {payerOptions.map((p) => (
                  <option key={p.userId} value={p.userId}>
                    {p.name}
                    {p.userId === currentUserId ? ' (You)' : ''}
                    {!p.current ? ' (former member)' : ''}
                  </option>
                ))}
              </select>
              {fieldError('paidBy')}
            </div>

            <div className={`${styles.field} ${styles.fullWidth}`}>
              <label className={styles.fieldLabel} htmlFor={fieldId('notes')}>
                Notes <small>Optional</small>
              </label>
              <textarea
                id={fieldId('notes')}
                value={values.notes}
                onChange={(e) => set('notes', e.target.value)}
                placeholder="Add any extra details about this expense..."
                maxLength={MAX_NOTES_LENGTH}
                rows={4}
                disabled={disabled}
                {...errorProps('notes', fieldId('notes-count'))}
              />
              <small id={fieldId('notes-count')} className={styles.characterCount}>
                {values.notes.length}/{MAX_NOTES_LENGTH}
              </small>
              {fieldError('notes')}
            </div>
          </div>
        </article>

        <article className={styles.panel}>
          <fieldset
            className={styles.participantFieldset}
            disabled={disabled}
            aria-describedby={errors.participants ? fieldId('participants-error') : undefined}
          >
            <legend className={styles.panelHeader}>
              <span>
                <span className="eyebrow">PARTICIPANTS</span>
                <span className={styles.legendTitle}>Who is this for?</span>
              </span>
            </legend>
            <div className={styles.participantActions}>
              <span className={styles.memberCount}>
                {selected.length}/{participantOptions.length}
              </span>
              <button
                type="button"
                onClick={() => set('participantIds', people.filter((p) => p.current).map((p) => p.userId))}
              >
                Select everyone
              </button>
              <button type="button" onClick={() => set('participantIds', [])}>
                Clear
              </button>
            </div>
            {fieldError('participants')}
            <div className={`${styles.participantList} ${errors.participants ? styles.hasError : ''}`}>
              {participantOptions.map((person) => {
                const isSelected = values.participantIds.includes(person.userId)
                return (
                  <label
                    key={person.userId}
                    className={`${styles.participantRow} ${isSelected ? styles.participantSelected : ''}`}
                  >
                    <input type="checkbox" checked={isSelected} onChange={() => toggle(person.userId)} />
                    <Avatar name={person.name} />
                    <span className={styles.memberInfo}>
                      <strong>
                        {person.name}
                        {!person.current && <span className={styles.formerTag}>Former member</span>}
                      </strong>
                      <span>{person.userId === currentUserId ? 'You' : person.current ? 'Group member' : 'Kept from this expense'}</span>
                    </span>
                    <span className={isSelected ? styles.selectedIndicator : styles.unselectedIndicator} aria-hidden="true">
                      {isSelected ? '✓' : ''}
                    </span>
                  </label>
                )
              })}
            </div>
          </fieldset>
        </article>
      </section>

      <aside className={styles.sideColumn}>
        <SplitPreview amount={values.amount} participants={selected} currentUserId={currentUserId} />

        <article className={styles.summaryCard}>
          <div>
            <span>Paid by</span>
            <strong>{values.paidBy ? nameOf(values.paidBy) : 'Not selected'}</strong>
          </div>
          <div>
            <span>Split method</span>
            <strong>Equally</strong>
          </div>
          <div>
            <span>Participants</span>
            <strong>{selected.length}</strong>
          </div>
        </article>

        {status}

        <button type="submit" className="primary-button" disabled={disabled || people.length === 0}>
          {labels
            ? submitting ? labels.busy : labels.submit
            : mode === 'create'
              ? submitting ? 'Creating expense...' : 'Create expense'
              : submitting ? 'Saving...' : 'Save changes'}
        </button>
        <p className={styles.submitHint}>The expense and every participant split are saved together.</p>
      </aside>
    </form>
  )
}
