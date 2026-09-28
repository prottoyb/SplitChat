import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { fail, ok, type Failure, type Result } from '../../../shared/api/result'
import { centsToDecimalText } from '../../../shared/domain/money'
import { useResource } from '../../../shared/hooks/useResource'
import { ErrorState, LoadingState, Notice } from '../../../shared/ui'
import { useAuth } from '../../auth'
import { ExpenseForm, type ExpenseInput, type FormPerson } from '../../expenses'
import { loadGroupDetail, type GroupDetail } from '../../groups'
import { loadCandidate, updateCandidate, type Candidate } from '../api/candidates'
import styles from './EditProposalPage.module.css'

type Context = { candidate: Candidate; group: GroupDetail }

const NOT_FOUND = 'This proposal does not exist or you do not have access to it.'

async function loadContext(groupId: string, candidateId: string, userId: string): Promise<Result<Context>> {
  const candidate = await loadCandidate(candidateId)
  if (!candidate.ok) return candidate
  // The URL's group must be the proposal's own, so the way back leads to it.
  if (candidate.value.groupId !== groupId) return fail('not_found', NOT_FOUND)
  const group = await loadGroupDetail(candidate.value.groupId, userId)
  if (!group.ok) return group
  if (group.value.myRole === null) return fail('not_found', NOT_FOUND)
  return ok({ candidate: candidate.value, group: group.value })
}

/**
 * Completing or correcting a Smart Expense proposal (ADR-0012) on its own
 * page, with the same form and validation as an expense. Saving changes the
 * proposal only; nothing is added until it is approved in the chat. Offered
 * to the proposer or the group owner while the proposal is open; the server
 * decides.
 */
function EditProposalPage() {
  const navigate = useNavigate()
  const { groupId = '', candidateId = '' } = useParams<{ groupId: string; candidateId: string }>()
  const { session } = useAuth()
  const userId = session?.user.id ?? ''
  const context = useResource(
    groupId && candidateId && userId ? `${groupId}:${candidateId}:${userId}` : null,
    () => loadContext(groupId, candidateId, userId),
  )
  const [failure, setFailure] = useState<Failure | null>(null)
  const chatPath = `/groups/${groupId}/chat`

  if (context.status === 'loading') return <LoadingState title="Loading proposal..." />
  if (context.status === 'error') {
    return <ErrorState title="Proposal unavailable" message={context.error.message} actions={[{ label: '← Back to chat', to: chatPath }]} />
  }

  const { candidate: c, group } = context.data
  const canManage = c.status === 'proposed' && (c.proposedBy === userId || group.myRole === 'owner')
  const people: FormPerson[] = group.members.map((m) => ({ userId: m.userId, name: m.fullName, current: true }))

  const submit = async (input: ExpenseInput) => {
    setFailure(null)
    const result = await updateCandidate(c, input)
    if (!result.ok) {
      setFailure(result)
      return result
    }
    navigate(chatPath)
    return null
  }

  return (
    <>
      <header className="topbar">
        <div>
          <Link to={chatPath} className={styles.breadcrumb}>
            ← {group.name} chat
          </Link>
          <p className="eyebrow">EXPENSE PROPOSAL</p>
          <h2>Edit proposal</h2>
          <p className="subtitle">
            Saving updates the proposal only. Nothing is added to the group’s expenses until it is approved in the chat.
          </p>
        </div>
      </header>

      {!canManage && (
        <Notice tone="info">
          {c.status === 'proposed'
            ? 'Only the person who proposed this or the group owner can change it.'
            : 'This proposal has already been decided, so it cannot be changed.'}
        </Notice>
      )}

      <ExpenseForm
        mode="create"
        people={people}
        currentUserId={userId}
        readOnly={!canManage}
        labels={{ form: 'Edit expense proposal', submit: 'Save proposal', busy: 'Saving…' }}
        initial={{
          description: c.description ?? '',
          amount: c.amountCents === null ? '' : centsToDecimalText(c.amountCents),
          expenseDate: c.expenseDate ?? '',
          paidBy: c.paidBy ?? '',
          participantIds: c.participantIds ?? [],
          notes: c.notes ?? '',
        }}
        onSubmit={submit}
        status={
          failure &&
          (failure.code === 'stale' ? (
            <Notice
              tone="error"
              action={
                <button type="button" className="secondary-button" onClick={context.reload}>
                  Reload proposal
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
    </>
  )
}

export default EditProposalPage
