import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Failure } from '../../../shared/api/result'
import { formatDateLong } from '../../../shared/domain/dates'
import { centsToDecimalText, formatCents } from '../../../shared/domain/money'
import { InlineConfirm, Notice } from '../../../shared/ui'
import { allocateEqualSplit, ExpenseForm, type ExpenseInput, type FormPerson } from '../../expenses'
import type { ChatMessage } from '../../chat'
import type { Candidate } from '../api/candidates'
import { interpretMessage, type Issue, type Member } from '../domain/interpreter'
import { contextFor } from '../useSmartExpense'
import styles from './CandidateCard.module.css'

type Props = {
  candidate: Candidate
  message: ChatMessage
  members: readonly Member[]
  userId: string
  isOwner: boolean
  onSave: (candidate: Candidate, input: ExpenseInput) => Promise<Failure | null>
  onApprove: (candidate: Candidate) => Promise<Failure | null>
  onReject: (candidate: Candidate) => Promise<Failure | null>
}

const OLD_DAYS = 30

/** Why a field is empty, from re-reading the message with today's members (display only). */
function hint(issue: Issue | undefined, nameOf: (id: string) => string): string | null {
  if (!issue) return null
  switch (issue.code) {
    case 'ambiguous':
      return issue.matches?.length ? `Choose: ${issue.matches.map(nameOf).join(' or ')}` : 'Unclear in the message'
    case 'unknown_name':
      return issue.token ? `“${issue.token}” is not a current member` : 'Not a current member'
    case 'multiple_amounts':
      return 'Several amounts mentioned'
    case 'unsupported_currency':
      return 'Only AUD is supported'
    case 'invalid_amount':
      return 'The amount could not be read'
    case 'invalid_date':
      return 'The date could not be read'
    case 'too_long':
      return 'Too long (120 characters at most)'
    default:
      return null
  }
}

/**
 * A proposed expense shown under its chat message (ADR-0012): clearly not a
 * message and not yet a record. Reviewing, editing, approving and rejecting
 * are offered only to its proposer or the group owner (the server decides).
 */
export function CandidateCard({ candidate: c, message, members, userId, isOwner, onSave, onApprove, onReject }: Props) {
  const [mode, setMode] = useState<'view' | 'edit' | 'confirm'>('view')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Failure | null>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [openedAt] = useState(() => Date.now())
  useEffect(() => {
    if (mode === 'confirm') cancelRef.current?.focus()
  }, [mode])

  const nameOf = (id: string) => members.find((m) => m.id === id)?.name ?? 'Former member'
  const who = (id: string) => (id === userId ? 'You' : nameOf(id))
  const canManage = c.status === 'proposed' && (c.proposedBy === userId || isOwner)
  const interpretation = c.source === 'manual' ? null : interpretMessage(message.body, contextFor(message, members))
  const issues = interpretation?.kind === 'candidate' ? interpretation.issues : []
  const issueFor = (field: Issue['field']) => issues.find((i) => i.field === field)

  const missing = [
    c.amountCents === null && 'amount',
    c.description === null && 'what it was for',
    c.expenseDate === null && 'date',
    c.paidBy === null && 'who paid',
    c.participantIds === null && 'who shares it',
  ].filter(Boolean) as string[]
  const complete = missing.length === 0
  const split =
    complete && c.amountCents !== null && c.participantIds ? allocateEqualSplit(c.amountCents, c.participantIds) : null
  const old = c.status === 'proposed' && openedAt - new Date(c.createdAt).getTime() > OLD_DAYS * 86_400_000

  const field = (label: string, value: string | null, issueField: Issue['field']) => (
    <div className={styles.field}>
      <dt>{label}</dt>
      <dd>
        {value ?? (
          <span className={styles.missing}>
            <span aria-hidden="true">⚠ </span>Not set
            {hint(issueFor(issueField), nameOf) && <span className={styles.hint}> — {hint(issueFor(issueField), nameOf)}</span>}
          </span>
        )}
      </dd>
    </div>
  )

  const run = async (action: () => Promise<Failure | null>) => {
    setBusy(true)
    setError(null)
    const failure = await action()
    setBusy(false)
    setError(failure)
    if (!failure) setMode('view')
    return failure
  }

  const status =
    c.status === 'approved' ? 'Expense added' : c.status === 'rejected' ? 'Rejected' : complete ? 'Ready to review' : 'Needs details'

  const people: FormPerson[] = members.map((m) => ({ userId: m.id, name: m.name, current: true }))

  return (
    <article className={`${styles.card} ${styles[c.status]}`} aria-label={`Expense proposal: ${status}`}>
      <header className={styles.header}>
        <span className={styles.icon} aria-hidden="true">
          $
        </span>
        <p className={styles.title}>Expense proposal</p>
        <span className={styles.status}>{status}</span>
      </header>
      {old && <p className={styles.note}>Proposed more than {OLD_DAYS} days ago.</p>}

      {mode === 'edit' ? (
        <div className={styles.form}>
          <ExpenseForm
            mode="create"
            people={people}
            currentUserId={userId}
            labels={{ form: 'Edit expense proposal', submit: 'Save proposal', busy: 'Saving…' }}
            initial={{
              description: c.description ?? '',
              amount: c.amountCents === null ? '' : centsToDecimalText(c.amountCents),
              expenseDate: c.expenseDate ?? '',
              paidBy: c.paidBy ?? '',
              participantIds: c.participantIds ?? [],
              notes: c.notes ?? '',
            }}
            onSubmit={(input) => run(() => onSave(c, input))}
          />
          <button type="button" className={styles.secondary} onClick={() => setMode('view')}>
            Cancel editing
          </button>
        </div>
      ) : (
        <dl className={styles.fields}>
          {field('Amount', c.amountCents === null ? null : formatCents(c.amountCents), 'amount')}
          {field('For', c.description, 'description')}
          {field('Date', c.expenseDate && formatDateLong(c.expenseDate), 'date')}
          {field('Paid by', c.paidBy && who(c.paidBy), 'payer')}
          {field('Split between', c.participantIds && c.participantIds.map(who).join(', '), 'participants')}
        </dl>
      )}

      {error && (
        <Notice tone="error">
          {error.message}
        </Notice>
      )}

      {c.status === 'approved' && c.expenseId && (
        <p className={styles.done}>
          <span aria-hidden="true">✓ </span>Added to the group’s expenses by {who(c.decidedBy ?? '')}.{' '}
          <Link to={`/expenses/${c.expenseId}`}>View expense</Link>
        </p>
      )}
      {c.status === 'rejected' && <p className={styles.note}>Rejected by {who(c.decidedBy ?? '')}. Nothing was added.</p>}

      {c.status === 'proposed' && !canManage && (
        <p className={styles.note}>Waiting for {who(c.proposedBy)} or the group owner to review it.</p>
      )}

      {canManage && mode === 'view' && (
        <div className={styles.actions}>
          <button type="button" className="primary-button" disabled={!complete || busy} onClick={() => setMode('confirm')}>
            Review and add
          </button>
          <button type="button" className={styles.secondary} disabled={busy} onClick={() => setMode('edit')}>
            {complete ? 'Edit' : 'Add details'}
          </button>
          <InlineConfirm
            triggerLabel="Reject"
            title="Reject this proposal?"
            description="Nothing will be added to the group’s expenses. The message stays in the chat."
            confirmLabel="Reject proposal"
            busyLabel="Rejecting…"
            onConfirm={() => run(() => onReject(c))}
          />
          {!complete && <p className={styles.note}>To add it, fill in: {missing.join(', ')}.</p>}
        </div>
      )}

      {canManage && mode === 'confirm' && split?.ok && c.amountCents !== null && (
        <div className={styles.confirm} role="group" aria-label="Confirm the expense">
          <p className={styles.confirmTitle}>
            Add {formatCents(c.amountCents)} for “{c.description}” on {formatDateLong(c.expenseDate ?? '')}, paid by{' '}
            {who(c.paidBy ?? '')}?
          </p>
          <ul className={styles.shares} aria-label="Each person’s share">
            {split.shares.map((s) => (
              <li key={s.userId}>
                <span>{who(s.userId)}</span>
                <strong>{formatCents(s.shareCents)}</strong>
              </li>
            ))}
          </ul>
          <div className={styles.actions}>
            <button type="button" className="primary-button" disabled={busy} onClick={() => void run(() => onApprove(c))}>
              {busy ? 'Adding…' : `Add ${formatCents(c.amountCents)} expense`}
            </button>
            <button type="button" ref={cancelRef} className={styles.secondary} disabled={busy} onClick={() => setMode('view')}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </article>
  )
}
