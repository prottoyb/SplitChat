import { Link, useLocation } from 'react-router-dom'
import { formatDateShort } from '../../../shared/domain/dates'
import { formatCents } from '../../../shared/domain/money'
import { useResource } from '../../../shared/hooks/useResource'
import { ErrorState, LoadingState, Notice } from '../../../shared/ui'
import { useAuth } from '../../auth'
import { listMyExpenses, type ExpenseListItem } from '../api/queries'
import styles from './ExpensesPage.module.css'

function ExpenseRow({ expense, userId }: { expense: ExpenseListItem; userId: string }) {
  return (
    <li className={styles.expenseRow}>
      <div className={styles.expenseIcon} aria-hidden="true">
        $
      </div>
      <div className={styles.expenseMain}>
        <div className={styles.expenseTitleRow}>
          <div>
            <h4>
              <Link to={`/expenses/${expense.id}`} className={styles.detailsLink}>
                {expense.description}
              </Link>
            </h4>
            <div className={styles.expenseMeta}>
              <Link to={`/groups/${expense.groupId}`} className={styles.groupLink}>
                {expense.groupName}
              </Link>
              <span aria-hidden="true">•</span>
              <span>{formatDateShort(expense.expenseDate)}</span>
            </div>
          </div>
          <strong className={styles.expenseAmount}>{formatCents(expense.amountCents)}</strong>
        </div>
        <div className={styles.expenseDetails}>
          <span>
            Paid by <strong>{expense.paidBy === userId ? 'You' : expense.paidByName}</strong>
          </span>
          <span>
            Split <strong>equally</strong>
          </span>
          <span>
            Your share <strong>{expense.myShareCents === null ? 'Not included' : formatCents(expense.myShareCents)}</strong>
          </span>
        </div>
        {expense.notes && <p className={styles.expenseNotes}>{expense.notes}</p>}
      </div>
    </li>
  )
}

function ExpensesPage() {
  const location = useLocation()
  const { session } = useAuth()
  const userId = session?.user.id ?? ''
  const expenses = useResource(userId ? `expenses:${userId}` : null, () => listMyExpenses(userId))
  const notice = (location.state as { notice?: string } | null)?.notice

  const header = (
    <header className="topbar">
      <div>
        <p className="eyebrow">EXPENSES</p>
        <h2>Shared expenses</h2>
        <p className="subtitle">Review costs recorded across all of your SplitChat groups.</p>
      </div>
      <Link to="/groups" className="primary-button">
        + Add expense
      </Link>
    </header>
  )

  if (expenses.status === 'loading') {
    return (
      <>
        {header}
        <LoadingState title="Loading expenses..." message="Getting your shared expense history." />
      </>
    )
  }
  if (expenses.status === 'error') {
    return (
      <>
        {header}
        <ErrorState
          title="Expenses unavailable"
          message={expenses.error.message}
          actions={[{ label: 'Try again', onClick: expenses.reload }]}
        />
      </>
    )
  }

  const items = expenses.data
  const totalSpend = items.reduce((sum, e) => sum + e.amountCents, 0)
  const myTotal = items.reduce((sum, e) => sum + (e.myShareCents ?? 0), 0)

  return (
    <>
      {header}
      {notice && <Notice tone="success">{notice}</Notice>}

      {items.length === 0 ? (
        <section className={styles.emptyState}>
          <div className={styles.emptyIcon} aria-hidden="true">
            $
          </div>
          <p className="eyebrow">NO EXPENSES YET</p>
          <h3>Your shared expenses will appear here</h3>
          <p>Open one of your groups to record your first shared expense.</p>
          <Link to="/groups" className="secondary-button">
            View groups
          </Link>
        </section>
      ) : (
        <>
          <section className={styles.overviewGrid}>
            <article className={styles.statCard}>
              <span>Total shared spend</span>
              <strong>{formatCents(totalSpend)}</strong>
              <p>Across expenses you can access</p>
            </article>
            <article className={styles.statCard}>
              <span>Your total share</span>
              <strong>{formatCents(myTotal)}</strong>
              <p>Your recorded portion of these costs</p>
            </article>
            <article className={styles.statCard}>
              <span>Expenses</span>
              <strong>{items.length}</strong>
              <p>Recorded in your active groups</p>
            </article>
          </section>

          <section className={styles.expensePanel}>
            <div className={styles.panelHeader}>
              <div>
                <p className="eyebrow">HISTORY</p>
                <h3>All expenses</h3>
              </div>
              <span className={styles.expenseCount}>{items.length}</span>
            </div>
            <ul className={styles.expenseList} aria-label="Expenses">
              {items.map((expense) => (
                <ExpenseRow key={expense.id} expense={expense} userId={userId} />
              ))}
            </ul>
          </section>
        </>
      )}
    </>
  )
}

export default ExpensesPage
