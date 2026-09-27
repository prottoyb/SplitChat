import { SectionHeader } from '../../../shared/ui'
import { SmartChat } from '../../../features/smart-expense'
import type { GroupDetail } from '../../../features/groups'

/** The group's chat (ADR-0011) with Smart Expense proposals (ADR-0012). */
export function ChatSection({ group, userId }: { group: GroupDetail; userId: string }) {
  return (
    <>
      <SectionHeader
        title="Chat"
        description="Visible to everyone in this group. Mention an expense, or use /expense, to propose it for review."
      />
      <SmartChat key={group.id} group={group} userId={userId} />
    </>
  )
}
