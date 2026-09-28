import { Link } from 'react-router-dom'
import { formatDateShort } from '../../../shared/domain/dates'
import { formatCents } from '../../../shared/domain/money'
import type { ExpenseListItem } from '../api/queries'
import styles from './ExpenseList.module.css'

function ExpenseRow({ expense, userId, showGroup }: { expense: ExpenseListItem; userId: string; showGroup: boolean }) {
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
              {showGroup && (
                <>
                  <Link to={`/groups/${expense.groupId}`} className={styles.groupLink}>
                    {expense.groupName}
                  </Link>
                  <span aria-hidden="true">•</span>
                </>
              )}
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
            Your share <strong>{expense.myShareCents === null ? 'Not included' : formatCents(expense.myShareCents)}</strong>
          </span>
        </div>
        {expense.notes && <p className={styles.expenseNotes}>{expense.notes}</p>}
      </div>
    </li>
  )
}

/** Expenses newest first; the group link is left out inside a group's own view. */
export function ExpenseList({
  expenses,
  userId,
  showGroup = true,
}: {
  expenses: readonly ExpenseListItem[]
  userId: string
  showGroup?: boolean
}) {
  return (
    <ul className={styles.expenseList} aria-label="Expenses">
      {expenses.map((expense) => (
        <ExpenseRow key={expense.id} expense={expense} userId={userId} showGroup={showGroup} />
      ))}
    </ul>
  )
}
