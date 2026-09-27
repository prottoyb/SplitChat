import { useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { formatDateLong, formatTimestamp } from '../../../shared/domain/dates'
import { formatCents } from '../../../shared/domain/money'
import { useResource } from '../../../shared/hooks/useResource'
import { Avatar, ErrorState, InlineConfirm, LoadingState, Notice } from '../../../shared/ui'
import { nameOf } from '../../people'
import { useAuth } from '../../auth'
import { deleteExpense } from '../api/mutations'
import { loadExpenseDetail, type ExpenseDetail } from '../api/queries'
import styles from './ExpenseDetailsPage.module.css'

function SplitBreakdown({ expense, userId }: { expense: ExpenseDetail; userId: string }) {
  const total = expense.splits.reduce((sum, s) => sum + s.shareCents, 0)
  return (
    <article className={styles.panel}>
      <div className={styles.panelHeader}>
        <div>
          <p className="eyebrow">SPLIT BREAKDOWN</p>
          <h3>Who owes what?</h3>
        </div>
        <span className={styles.memberCount}>{expense.splits.length}</span>
      </div>

      {expense.splits.length === 0 ? (
        <div className={styles.emptySplits}>
          <p>No participant splits were found for this expense.</p>
        </div>
      ) : (
        <ul className={styles.splitList} aria-label="Participant shares">
          {expense.splits.map((split) => (
            <li key={split.userId} className={styles.splitRow}>
              <div className={styles.memberInfo}>
                <Avatar name={split.name} />
                <div>
                  <div className={styles.memberNameRow}>
                    <strong>{split.name}</strong>
                    {split.userId === userId && <span className={styles.youBadge}>You</span>}
                    {split.userId === expense.paidBy && <span className={styles.payerBadge}>Paid</span>}
                  </div>
                  <span>Equal share</span>
                </div>
              </div>
              <strong className={styles.shareAmount}>{formatCents(split.shareCents)}</strong>
            </li>
          ))}
        </ul>
      )}

      <div className={styles.splitTotal}>
        <span>Split total</span>
        <strong>{formatCents(total)}</strong>
      </div>
    </article>
  )
}

function ExpenseDetailsPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { expenseId = '' } = useParams<{ expenseId: string }>()
  const { session } = useAuth()
  const userId = session?.user.id ?? ''
  const detail = useResource(expenseId && userId ? `${expenseId}:${userId}` : null, () =>
    loadExpenseDetail(expenseId, userId),
  )
  const [deleteError, setDeleteError] = useState('')
  const notice = (location.state as { notice?: string } | null)?.notice

  if (detail.status === 'loading') {
    return <LoadingState title="Loading expense..." message="Getting the expense and split information." />
  }
  if (detail.status === 'error') {
    return (
      <ErrorState
        title="Expense unavailable"
        message={detail.error.message}
        actions={[
          ...(detail.error.code === 'network' ? [{ label: 'Try again', onClick: detail.reload }] : []),
          { label: '← Back to expenses', to: '/expenses' },
        ]}
      />
    )
  }

  const expense = detail.data
  const myShare = expense.splits.find((s) => s.userId === userId)?.shareCents ?? null
  const who = (id: string) => (id === userId ? 'You' : nameOf(expense.names, id))

  const handleDelete = async () => {
    setDeleteError('')
    const result = await deleteExpense(expense.id, expense.updatedAt)
    if (!result.ok) {
      setDeleteError(result.message)
      return
    }
    navigate('/expenses', { replace: true, state: { notice: 'Expense deleted.' } })
  }

  return (
    <>
      <header className="topbar">
        <div>
          <Link to="/expenses" className={styles.breadcrumb}>
            ← Expenses
          </Link>
          <p className="eyebrow">EXPENSE DETAILS</p>
          <h2>{expense.description}</h2>
          <p className="subtitle">{expense.groupName}</p>
        </div>
        <div className={styles.amountBadge}>{formatCents(expense.amountCents)}</div>
      </header>

      {notice && <Notice tone="success">{notice}</Notice>}

      <section className={styles.overviewGrid}>
        <article className={styles.statCard}>
          <span>Total expense</span>
          <strong>{formatCents(expense.amountCents)}</strong>
          <p>Full amount recorded</p>
        </article>
        <article className={styles.statCard}>
          <span>Your share</span>
          <strong>{myShare === null ? 'Not included' : formatCents(myShare)}</strong>
          <p>Your portion of this expense</p>
        </article>
        <article className={styles.statCard}>
          <span>Paid by</span>
          <strong>{who(expense.paidBy)}</strong>
          <p>Member who covered the payment</p>
        </article>
        <article className={styles.statCard}>
          <span>Expense date</span>
          <strong>{formatDateLong(expense.expenseDate)}</strong>
          <p>Date this cost occurred</p>
        </article>
      </section>

      <section className={styles.contentGrid}>
        <SplitBreakdown expense={expense} userId={userId} />

        <aside className={styles.sideColumn}>
          <article className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <p className="eyebrow">INFORMATION</p>
                <h3>Expense information</h3>
              </div>
            </div>
            <dl className={styles.infoList}>
              <div>
                <dt>Group</dt>
                <dd>
                  <Link to={`/groups/${expense.groupId}`} className={styles.groupLink}>
                    {expense.groupName}
                  </Link>
                </dd>
              </div>
              <div>
                <dt>Split method</dt>
                <dd>Equal split</dd>
              </div>
              <div>
                <dt>Added by</dt>
                <dd>{who(expense.createdBy)}</dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{formatTimestamp(expense.createdAt)}</dd>
              </div>
              {expense.updatedBy && (
                <div>
                  <dt>Last edited</dt>
                  <dd>
                    {formatTimestamp(expense.updatedAt)} by {who(expense.updatedBy)}
                  </dd>
                </div>
              )}
            </dl>
          </article>

          <article className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <p className="eyebrow">NOTES</p>
                <h3>Additional details</h3>
              </div>
            </div>
            {expense.notes ? (
              <p className={styles.notes}>{expense.notes}</p>
            ) : (
              <p className={styles.noNotes}>No notes were added to this expense.</p>
            )}
          </article>

          {expense.canManage && (
            <article className={styles.panel}>
              <div className={styles.panelHeader}>
                <div>
                  <p className="eyebrow">MANAGE</p>
                  <h3>Manage expense</h3>
                </div>
              </div>
              {deleteError && <Notice tone="error">{deleteError}</Notice>}
              <Link to={`/expenses/${expense.id}/edit`} className={`secondary-button ${styles.editLink}`}>
                Edit expense
              </Link>
              <InlineConfirm
                triggerLabel="Delete expense"
                title="Delete this expense?"
                description={`It will be removed for everyone in ${expense.groupName}, together with every person's share. This cannot be undone.`}
                confirmLabel="Yes, delete"
                busyLabel="Deleting..."
                onConfirm={handleDelete}
              />
            </article>
          )}
        </aside>
      </section>
    </>
  )
}

export default ExpenseDetailsPage
