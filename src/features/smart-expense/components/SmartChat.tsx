import { useMemo, useState } from 'react'
import { GroupChat, type ChatMessage } from '../../chat'
import type { GroupDetail } from '../../groups'
import type { Member } from '../domain/interpreter'
import { useSmartExpense } from '../useSmartExpense'
import { CandidateCard } from './CandidateCard'
import styles from './CandidateCard.module.css'

function RecordAsExpense({ onRecord }: { onRecord: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false)
  return (
    <button
      type="button"
      className={styles.secondary}
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        await onRecord()
        setBusy(false)
      }}
    >
      {busy ? 'Creating proposal…' : 'Record as expense'}
    </button>
  )
}

/**
 * Group chat with Smart Expense (ADR-0012): proposals appear under their
 * message; sending a message that describes an expense proposes one for the
 * sender to review. Mount one per group (key by group id).
 */
export function SmartChat({ group, userId }: { group: GroupDetail; userId: string }) {
  const members: Member[] = useMemo(() => group.members.map((m) => ({ id: m.userId, name: m.fullName })), [group.members])
  const smart = useSmartExpense(group.id, members)
  const isOwner = group.myRole === 'owner'

  const renderAfterMessage = (message: ChatMessage) => {
    const candidate = smart.byMessage.get(message.id)
    if (candidate) {
      return (
        <CandidateCard
          candidate={candidate}
          message={message}
          members={members}
          userId={userId}
          isOwner={isOwner}
          onApprove={smart.approve}
          onReject={smart.reject}
        />
      )
    }
    // My own message mentioning a number, checked and without a proposal.
    if (message.senderId === userId && /\d/.test(message.body) && smart.checked.has(message.id)) {
      return <RecordAsExpense onRecord={() => smart.proposeManually(message)} />
    }
    return null
  }

  return (
    <GroupChat
      groupId={group.id}
      userId={userId}
      extensions={{
        onOwnMessageConfirmed: (m) => void smart.onOwnMessageConfirmed(m),
        onMessagesShown: smart.onMessagesShown,
        renderAfterMessage,
      }}
    />
  )
}
