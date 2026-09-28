import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Notice, SectionHeader } from '../../../shared/ui'
import type { GroupDetail, Member } from '../api/groups'
import { addMemberByEmail, deleteGroup, leaveGroup, removeMember, transferOwnership } from '../api/membership'
import { MemberList } from '../components/MemberList'
import { MembershipPanel } from '../components/MembershipPanel'
import styles from './GroupMembers.module.css'

type Feedback = { tone: 'success' | 'error'; text: string } | null

const ADD_OUTCOME_TEXT = {
  already_member: 'That person is already a member of this group.',
  // Deliberately does not say whether the email has an account.
  member_not_added:
    'We could not add anyone with that email. Check the address — the person needs a SplitChat account with a confirmed email.',
  rate_limited: 'Too many add attempts. Please wait a while and try again.',
} as const

/**
 * The Members section of a group workspace: the active members, and the
 * membership actions the caller's role allows (the server decides in every
 * case). The group comes from the workspace, which owns loading it.
 */
export function GroupMembersSection({
  group,
  userId,
  updateGroup,
  reloadGroup,
}: {
  group: GroupDetail
  userId: string
  /** Applies an immediate local change while the reload confirms it. */
  updateGroup: (update: (current: GroupDetail) => GroupDetail) => void
  reloadGroup: () => void
}) {
  const navigate = useNavigate()
  const [feedback, setFeedback] = useState<Feedback>(null)
  const [busy, setBusy] = useState(false)

  const groupId = group.id
  const isOwner = group.myRole === 'owner'
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
      reloadGroup()
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
    updateGroup((d) => ({ ...d, members: d.members.filter((m) => m.userId !== member.userId) }))
    reloadGroup()
    report('success', `${member.fullName} was removed from the group. Their past expenses are kept.`)
  }

  const handleTransfer = async (member: Member) => {
    setFeedback(null)
    setBusy(true)
    const result = await transferOwnership(groupId, member.userId)
    setBusy(false)
    if (!result.ok) return report('error', result.message)
    // Swap roles at once so owner-only actions disappear (B2-SR-1).
    updateGroup((d) => ({
      ...d,
      myRole: 'member',
      members: d.members.map((m) => ({
        ...m,
        role: m.userId === member.userId ? 'owner' : m.role === 'owner' ? 'member' : m.role,
      })),
    }))
    reloadGroup()
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
      <SectionHeader
        title="Members"
        description={
          isOwner ? 'You own this group: you can add and remove members and hand over ownership.' : 'People currently sharing this group.'
        }
      />

      {feedback && <Notice tone={feedback.tone}>{feedback.text}</Notice>}

      <section className={styles.contentGrid}>
        <article className={styles.panel}>
          <div className={styles.panelHeader}>
            <div>
              <p className="eyebrow">MEMBERS</p>
              <h4 className={styles.panelTitle}>Group members</h4>
            </div>
            <span className={styles.memberCount} aria-label={`${group.members.length} members`}>
              {group.members.length}
            </span>
          </div>
          <MemberList
            members={group.members}
            currentUserId={userId}
            canManage={isOwner}
            busy={busy}
            onRemove={handleRemove}
            onTransfer={handleTransfer}
          />
        </article>

        <MembershipPanel
          isOwner={isOwner}
          isSoleMember={group.members.length === 1}
          onAdd={handleAdd}
          onLeave={handleLeave}
          onDelete={handleDelete}
        />
      </section>
    </>
  )
}
