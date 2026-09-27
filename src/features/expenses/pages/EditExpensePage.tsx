import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { Failure } from '../../../shared/api/result'
import { useResource } from '../../../shared/hooks/useResource'
import { ErrorState, LoadingState, Notice } from '../../../shared/ui'
import { useAuth } from '../../auth'
import { updateEqualSplitExpense } from '../api/mutations'
import { loadEditExpenseContext } from '../api/queries'
import { ExpenseForm } from '../components/ExpenseForm'
import { centsToDecimalText } from '../../../shared/domain/money'
import type { ExpenseInput } from '../domain/expenseForm'
import styles from '../components/ExpenseForm.module.css'

/**
 * Edit an expense (M13). Allowed for its creator while a member, or the
 * group owner — the server decides; the UI only offers it. Saves send the
 * loaded `updated_at` string; a `stale` result offers a reload (never an
 * automatic retry), `forbidden` makes the form read-only.
 */
function EditExpensePage() {
  const navigate = useNavigate()
  const { expenseId = '' } = useParams<{ expenseId: string }>()
  const { session } = useAuth()
  const userId = session?.user.id ?? ''
  const context = useResource(expenseId && userId ? `${expenseId}:${userId}` : null, () =>
    loadEditExpenseContext(expenseId, userId),
  )
  const [failure, setFailure] = useState<Failure | null>(null)

  if (context.status === 'loading') {
    return <LoadingState title="Loading expense..." message="Getting the expense and the group's members." />
  }
  if (context.status === 'error') {
    return (
      <ErrorState
        title="Expense unavailable"
        message={context.error.message}
        actions={[{ label: '← Back to expenses', to: '/expenses' }]}
      />
    )
  }

  const { groupId, groupName, people, expense } = context.data
  if (!expense) return null
  const readOnly = !expense.canManage || failure?.code === 'forbidden'

  const submit = async (input: ExpenseInput) => {
    setFailure(null)
    const result = await updateEqualSplitExpense(expense.id, expense.updatedAt, input)
    if (!result.ok) {
      setFailure(result)
      return result
    }
    navigate(`/expenses/${expense.id}`, { replace: true, state: { notice: 'Expense updated.' } })
    return null
  }

  const reload = () => {
    setFailure(null)
    context.reload()
  }

  return (
    <>
      <header className="topbar">
        <div>
          <Link to={`/expenses/${expense.id}`} className={styles.breadcrumb}>
            ← {expense.description}
          </Link>
          <p className="eyebrow">EDIT EXPENSE</p>
          <h2>Edit expense</h2>
          <p className="subtitle">
            {groupName} · Changes are saved as a whole and the split is recalculated.
          </p>
        </div>
        <div className={styles.splitBadge}>Equal split</div>
      </header>

      {!expense.canManage && (
        <Notice tone="info">Only the person who added this expense or the group owner can change it.</Notice>
      )}

      <ExpenseForm
        key={expense.updatedAt}
        mode="edit"
        people={people}
        currentUserId={userId}
        readOnly={readOnly}
        initial={{
          description: expense.description,
          amount: centsToDecimalText(expense.amountCents),
          expenseDate: expense.expenseDate,
          paidBy: expense.paidBy,
          participantIds: expense.splits.map((s) => s.userId),
          notes: expense.notes ?? '',
        }}
        onSubmit={submit}
        status={
          failure &&
          (failure.code === 'stale' ? (
            <Notice
              tone="error"
              action={
                <button type="button" className="secondary-button" onClick={reload}>
                  Reload expense
                </button>
              }
            >
              {failure.message}
            </Notice>
          ) : (
            <Notice tone="error">{failure.message}</Notice>
          ))
        }
      />
      <p className={styles.submitHint}>
        <Link to={`/groups/${groupId}`}>Back to {groupName}</Link>
      </p>
    </>
  )
}

export default EditExpensePage
