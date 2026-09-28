import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Failure } from '../../../shared/api/result'
import { formatDateLong } from '../../../shared/domain/dates'
import { formatCents } from '../../../shared/domain/money'
import { InlineConfirm, Notice } from '../../../shared/ui'
import { allocateEqualSplit } from '../../expenses'
import type { ChatMessage } from '../../chat'
import type { Candidate } from '../api/candidates'
import { interpretMessage, type Issue, type Member } from '../domain/interpreter'
import { contextFor } from '../useSmartExpense'
import styles from './CandidateCard.module.css'
import { canActOnProposal, missingFields, proposalElementId } from '../domain/proposalState'

type Props = {
  candidate: Candidate
  message: ChatMessage
  members: readonly Member[]
  userId: string
  isOwner: boolean
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
export function CandidateCard({ candidate: c, message, members, userId, isOwner, onApprove, onReject }: Props) {
  const [mode, setMode] = useState<'view' | 'confirm'>('view')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Failure | null>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const reviewRef = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef(false)
  const [openedAt] = useState(() => Date.now())
  // Like every confirmation: Cancel is focused on open, Escape cancels, and
  // focus returns to "Review and add".
  useEffect(() => {
    if (mode === 'confirm') cancelRef.current?.focus()
    else if (returnFocus.current) {
      returnFocus.current = false
      reviewRef.current?.focus()
    }
  }, [mode])
  const cancelConfirm = () => {
    returnFocus.current = true
    setMode('view')
  }

  const nameOf = (id: string) => members.find((m) => m.id === id)?.name ?? 'Former member'
  const who = (id: string) => (id === userId ? 'You' : nameOf(id))
  const canManage = canActOnProposal(c, userId, isOwner)
  // Display-only hints: the message re-read against today's members.
  const interpretation = useMemo(
    () => (c.source === 'manual' ? null : interpretMessage(message.body, contextFor(message, members))),
    [c.source, message, members],
  )
  const issues = interpretation?.kind === 'candidate' ? interpretation.issues : []
  const issueFor = (field: Issue['field']) => issues.find((i) => i.field === field)

  const missing = missingFields(c)
  const complete = missing.length === 0
  const split =
    complete && c.amountCents !== null && c.participantIds ? allocateEqualSplit(c.amountCents, c.participantIds) : null
  const old = c.status === 'proposed' && openedAt - new Date(c.createdAt).getTime() > OLD_DAYS * 86_400_000

  const ASK: Record<Issue['field'], string> = {
    amount: 'add the amount',
    description: 'add what it was for',
    date: 'add the date',
    payer: 'add who paid',
    participants: 'add who shares it',
  }
  const field = (label: string, value: string | null, issueField: Issue['field']) => (
    <div className={styles.field}>
      <dt>{label}</dt>
      <dd>
        {value ?? (
          <span className={styles.missing}>
            <span aria-hidden="true">⚠ </span>Not set
            <span className={styles.hint}> — {hint(issueFor(issueField), nameOf) ?? ASK[issueField]}</span>
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

  const editPath = `/groups/${c.groupId}/proposals/${c.id}/edit`
  // A link cannot be disabled: while a decision is in flight the edit action
  // is a disabled button instead, so nobody leaves mid-request.
  const editAction = (label: string, className: string) =>
    busy ? (
      <button type="button" className={className} disabled>
        {label}
      </button>
    ) : (
      <Link to={editPath} className={className}>
        {label}
      </Link>
    )

  return (
    <article
      id={proposalElementId(c.id)}
      tabIndex={-1}
      className={`${styles.card} ${styles[c.status]} ${c.status === 'proposed' && !complete ? styles.incomplete : ''}`}
      aria-label={`Expense proposal: ${status}`}
    >
      <header className={styles.header}>
        <span className={styles.icon} aria-hidden="true">
          $
        </span>
        <p className={styles.title}>Expense proposal</p>
        {/* Announced when it changes (e.g. approved or rejected by someone else). */}
        <span className={styles.status} aria-live="polite">
          {status}
        </span>
      </header>
      {old && (
        <p className={styles.note}>
          Proposed more than {OLD_DAYS} days ago.{' '}
          {canManage ? 'Check the details are still right before adding it, or reject it if it was already sorted out.' : 'The proposer or the group owner can add or reject it.'}
        </p>
      )}

      <dl className={styles.fields}>
        {field('Amount', c.amountCents === null ? null : formatCents(c.amountCents), 'amount')}
        {field('For', c.description, 'description')}
        {field('Date', c.expenseDate && formatDateLong(c.expenseDate), 'date')}
        {field('Paid by', c.paidBy && who(c.paidBy), 'payer')}
        {field('Split between', c.participantIds && c.participantIds.map(who).join(', '), 'participants')}
      </dl>

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
          {complete ? (
            <>
              <button type="button" ref={reviewRef} className="primary-button" disabled={busy} onClick={() => setMode('confirm')}>
                Review and add
              </button>
              {editAction('Edit', styles.secondary)}
            </>
          ) : (
            editAction('Add details', 'primary-button')
          )}
          <span className={styles.rejectSlot}>
            <InlineConfirm
              triggerLabel="Reject"
              title="Reject this proposal?"
              description="Nothing will be added to the group’s expenses. The message stays in the chat."
              confirmLabel="Reject proposal"
              busyLabel="Rejecting…"
              onConfirm={() => run(() => onReject(c))}
            />
          </span>
          {!complete && <p className={styles.note}>To add it, fill in: {missing.join(', ')}.</p>}
        </div>
      )}

      {canManage && mode === 'confirm' && split?.ok && c.amountCents !== null && (
        <div
          className={styles.confirm}
          role="group"
          aria-label="Confirm the expense"
          onKeyDown={(e) => {
            if (e.key === 'Escape' && !busy) cancelConfirm()
          }}
        >
          <p className={styles.confirmTitle}>Add this {formatCents(c.amountCents)} expense?</p>
          <p className={styles.note}>
            “{c.description}” on {formatDateLong(c.expenseDate ?? '')}, paid by {who(c.paidBy ?? '')}. Each person’s share:
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
              {busy ? 'Adding…' : 'Add expense'}
            </button>
            <button type="button" ref={cancelRef} className={styles.secondary} disabled={busy} onClick={cancelConfirm}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </article>
  )
}
