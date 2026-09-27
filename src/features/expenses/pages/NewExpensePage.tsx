import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { localIsoDate } from '../../../shared/domain/dates'
import { useResource } from '../../../shared/hooks/useResource'
import { ErrorState, LoadingState, Notice } from '../../../shared/ui'
import { useAuth } from '../../auth'
import { createEqualSplitExpense } from '../api/mutations'
import { loadNewExpenseContext } from '../api/queries'
import { ExpenseForm } from '../components/ExpenseForm'
import type { ExpenseInput } from '../domain/expenseForm'
import styles from '../components/ExpenseForm.module.css'

function NewExpensePage() {
  const { groupId = '' } = useParams<{ groupId: string }>()
  const { session } = useAuth()
  const userId = session?.user.id ?? ''
  const context = useResource(groupId && userId ? `${groupId}:${userId}` : null, () =>
    loadNewExpenseContext(groupId, userId),
  )
  const [created, setCreated] = useState<{ id: string; people: number } | null>(null)
  const [error, setError] = useState('')

  if (context.status === 'loading') {
    return <LoadingState title="Loading expense form" message="Getting the group and member information." />
  }
  if (context.status === 'error') {
    return (
      <ErrorState
        title="Group unavailable"
        message={context.error.message}
        actions={[{ label: '← Back to groups', to: '/groups' }]}
      />
    )
  }

  const { groupName, people } = context.data

  const submit = async (input: ExpenseInput) => {
    setError('')
    setCreated(null)
    const result = await createEqualSplitExpense(groupId, input)
    if (!result.ok) {
      setError(result.message)
      return result
    }
    setCreated({ id: result.value, people: input.participantIds.length })
    return null
  }

  return (
    <>
      <header className="topbar">
        <div>
          <Link to={`/groups/${groupId}`} className={styles.breadcrumb}>
            ← {groupName}
          </Link>
          <p className="eyebrow">NEW EXPENSE</p>
          <h2>Add an expense</h2>
          <p className="subtitle">Record a shared cost and choose exactly who should be included in the split.</p>
        </div>
        <div className={styles.splitBadge}>Equal split</div>
      </header>

      {created && (
        <Notice tone="success" action={<Link to={`/expenses/${created.id}`}>View expense</Link>}>
          Expense created successfully and split between {created.people} {created.people === 1 ? 'person' : 'people'}.
        </Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}

      <ExpenseForm
        mode="create"
        people={people}
        currentUserId={userId}
        initial={{
          description: '',
          amount: '',
          expenseDate: localIsoDate(),
          paidBy: people.some((p) => p.userId === userId) ? userId : (people[0]?.userId ?? ''),
          participantIds: people.map((p) => p.userId),
          notes: '',
        }}
        onSubmit={submit}
      />
    </>
  )
}

export default NewExpensePage
