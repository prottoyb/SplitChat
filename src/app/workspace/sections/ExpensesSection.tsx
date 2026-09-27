import { Link } from 'react-router-dom'
import { formatCents } from '../../../shared/domain/money'
import { useResource } from '../../../shared/hooks/useResource'
import { ErrorState, LoadingState, SectionHeader } from '../../../shared/ui'
import { ExpenseList, listMyExpenses } from '../../../features/expenses'
import type { GroupDetail } from '../../../features/groups'
import styles from '../GroupWorkspace.module.css'

/** The group's expenses, newest first (the same list as the global Expenses page). */
export function ExpensesSection({ group, userId }: { group: GroupDetail; userId: string }) {
  const expenses = useResource(`expenses:${group.id}:${userId}`, () => listMyExpenses(userId, { groupId: group.id }))

  const summary =
    expenses.status === 'ready' && expenses.data.length > 0
      ? `${expenses.data.length} ${expenses.data.length === 1 ? 'expense' : 'expenses'} · ${formatCents(
          expenses.data.reduce((sum, e) => sum + e.amountCents, 0),
        )} in total`
      : 'Everything this group has spent together.'

  return (
    <>
      <SectionHeader title="Expenses" description={summary} />
      {expenses.status === 'loading' ? (
        <LoadingState title="Loading expenses..." />
      ) : expenses.status === 'error' ? (
        <ErrorState
          title="Expenses unavailable"
          message={expenses.error.message}
          actions={[{ label: 'Try again', onClick: expenses.reload }]}
        />
      ) : expenses.data.length === 0 ? (
        <section className={styles.emptyPanel}>
          <p className={styles.emptyTitle}>No expenses yet</p>
          <p>Record the first shared cost and SplitChat works out everyone&apos;s share.</p>
          <Link to={`/groups/${group.id}/expenses/new`} className="secondary-button">
            Add the first expense
          </Link>
        </section>
      ) : (
        <section className="panel">
          <ExpenseList expenses={expenses.data} userId={userId} showGroup={false} />
        </section>
      )}
    </>
  )
}
