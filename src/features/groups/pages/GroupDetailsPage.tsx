import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { formatDateShort } from '../../../shared/domain/dates'
import { useResource } from '../../../shared/hooks/useResource'
import { ErrorState, LoadingState, Notice } from '../../../shared/ui'
import { useAuth } from '../../auth'
import { loadGroupDetail, type Member } from '../api/groups'
import { addMemberByEmail, deleteGroup, leaveGroup, removeMember, transferOwnership } from '../api/membership'
import { MemberList } from '../components/MemberList'
import { MembershipPanel } from '../components/MembershipPanel'
import styles from './GroupDetailsPage.module.css'

type Feedback = { tone: 'success' | 'error'; text: string } | null

const ADD_OUTCOME_TEXT = {
  already_member: 'That person is already a member of this group.',
  // Deliberately does not say whether the email has an account.
  member_not_added:
    'We could not add anyone with that email. Check the address — the person needs a SplitChat account with a confirmed email.',
  rate_limited: 'Too many add attempts. Please wait a while and try again.',
} as const

function GroupDetailsPage() {
  const navigate = useNavigate()
  const { groupId = '' } = useParams<{ groupId: string }>()
  const { session } = useAuth()
  const userId = session?.user.id ?? ''

  const group = useResource(groupId && userId ? `${groupId}:${userId}` : null, () => loadGroupDetail(groupId, userId))
  const [feedback, setFeedback] = useState<Feedback>(null)
  const [busy, setBusy] = useState(false)

  if (group.status === 'loading') {
    return <LoadingState title="Loading group..." message="Getting the group and its members." />
  }
  if (group.status === 'error') {
    return (
      <ErrorState
        title="Group unavailable"
        message={group.error.message}
        actions={[
          ...(group.error.code === 'network' || group.error.code === 'unknown'
            ? [{ label: 'Try again', onClick: group.reload }]
            : []),
          { label: '← Back to groups', to: '/groups' },
        ]}
      />
    )
  }

  const detail = group.data
  const isOwner = detail.myRole === 'owner'
  const report = (tone: 'success' | 'error', text: string) => setFeedback({ tone, text })

  const handleAdd = async (email: string) => {
    setFeedback(null)
    const result = await addMemberByEmail(groupId, email)
    if (!result.ok) {
      report('error', result.message)
      return false
    }
    if (result.value.result === 'added') {
      report('success', `${result.value.member.fullName} was added. They can now access this group.`)
      group.reload()
      return true
    }
    report('error', ADD_OUTCOME_TEXT[result.value.result])
    return false
  }

  const handleRemove = async (member: Member) => {
    setFeedback(null)
    setBusy(true)
    const result = await removeMember(groupId, member.userId)
    setBusy(false)
    if (!result.ok) return report('error', result.message)
    // Drop the row at once so its actions cannot be reused (B2-SR-1); the
    // reload confirms the server state.
    group.setData((d) => ({ ...d, members: d.members.filter((m) => m.userId !== member.userId) }))
    group.reload()
    report('success', `${member.fullName} was removed from the group. Their past expenses are kept.`)
  }

  const handleTransfer = async (member: Member) => {
    setFeedback(null)
    setBusy(true)
    const result = await transferOwnership(groupId, member.userId)
    setBusy(false)
    if (!result.ok) return report('error', result.message)
    // Swap roles at once so owner-only actions disappear (B2-SR-1).
    group.setData((d) => ({
      ...d,
      myRole: 'member',
      members: d.members.map((m) => ({
        ...m,
        role: m.userId === member.userId ? 'owner' : m.role === 'owner' ? 'member' : m.role,
      })),
    }))
    group.reload()
    report('success', `${member.fullName} is now the owner of this group.`)
  }

  const handleLeave = async () => {
    setFeedback(null)
    const result = await leaveGroup(groupId)
    if (!result.ok) return report('error', result.message)
    navigate('/groups', { replace: true })
  }

  const handleDelete = async () => {
    setFeedback(null)
    const result = await deleteGroup(groupId)
    if (!result.ok) return report('error', result.message)
    navigate('/groups', { replace: true })
  }

  return (
    <>
      <header className="topbar">
        <div>
          <Link to="/groups" className={styles.breadcrumb}>
            ← Groups
          </Link>
          <p className="eyebrow">GROUP DETAILS</p>
          <h2>{detail.name}</h2>
          <p className="subtitle">{detail.description || 'No description has been added to this group.'}</p>
        </div>
        <div className={styles.headerActions}>
          <div className={styles.groupRole}>{isOwner ? 'Owner' : 'Member'}</div>
          <Link to={`/groups/${groupId}/expenses/new`} className="primary-button">
            + Add expense
          </Link>
        </div>
      </header>

      {feedback && <Notice tone={feedback.tone}>{feedback.text}</Notice>}

      <section className={styles.overviewGrid}>
        <article className={styles.statCard}>
          <span>Members</span>
          <strong>{detail.members.length}</strong>
          <p>People currently sharing this group</p>
        </article>
        <article className={styles.statCard}>
          <span>Your role</span>
          <strong>{isOwner ? 'Owner' : 'Member'}</strong>
          <p>{isOwner ? 'You manage this group' : 'You are part of this group'}</p>
        </article>
        <article className={styles.statCard}>
          <span>Created</span>
          <strong>{formatDateShort(detail.createdAt.slice(0, 10))}</strong>
          <p>Group creation date</p>
        </article>
      </section>

      <section className={styles.contentGrid}>
        <article className={styles.panel}>
          <div className={styles.panelHeader}>
            <div>
              <p className="eyebrow">MEMBERS</p>
              <h3>Group members</h3>
            </div>
            <span className={styles.memberCount}>{detail.members.length}</span>
          </div>
          <MemberList
            members={detail.members}
            currentUserId={userId}
            canManage={isOwner}
            busy={busy}
            onRemove={handleRemove}
            onTransfer={handleTransfer}
          />
        </article>

        <MembershipPanel
          isOwner={isOwner}
          isSoleMember={detail.members.length === 1}
          onAdd={handleAdd}
          onLeave={handleLeave}
          onDelete={handleDelete}
        />
      </section>
    </>
  )
}

export default GroupDetailsPage
