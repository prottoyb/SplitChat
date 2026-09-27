import { SectionHeader } from '../../../shared/ui'
import { GroupChat } from '../../../features/chat'
import type { GroupDetail } from '../../../features/groups'

/** The group's chat (ADR-0011): conversation between current members. */
export function ChatSection({ group, userId }: { group: GroupDetail; userId: string }) {
  return (
    <>
      <SectionHeader title="Chat" description="Messages are visible to everyone currently in this group." />
      <GroupChat key={group.id} groupId={group.id} userId={userId} />
    </>
  )
}
