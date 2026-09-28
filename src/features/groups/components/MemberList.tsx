import { useEffect, useRef, useState } from 'react'
import { formatDateShort } from '../../../shared/domain/dates'
import { Avatar } from '../../../shared/ui'
import type { Member } from '../api/groups'
import styles from '../pages/GroupMembers.module.css'

type Pending = { userId: string; action: 'remove' | 'transfer' } | null

/**
 * Active members, by join date. The owner sees "Make owner" and "Remove" on
 * other members, each behind an inline confirmation. These are UI hints
 * only: the membership RPCs enforce the same rules.
 */
export function MemberList({
  members,
  currentUserId,
  canManage,
  busy,
  onRemove,
  onTransfer,
}: {
  members: Member[]
  currentUserId: string
  canManage: boolean
  busy: boolean
  onRemove: (member: Member) => Promise<void>
  onTransfer: (member: Member) => Promise<void>
}) {
  const [pending, setPending] = useState<Pending>(null)
  // Keyboard users keep their place: the confirmation focuses its safe
  // choice (Cancel); cancelling returns focus to the button that opened it.
  const cancelRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const reopen = useRef<string | null>(null)
  useEffect(() => {
    if (pending) cancelRef.current?.focus()
    else if (reopen.current) {
      listRef.current?.querySelector<HTMLButtonElement>(`[data-action="${reopen.current}"]`)?.focus()
      reopen.current = null
    }
  }, [pending])
  const cancel = () => {
    if (pending) reopen.current = `${pending.action}-${pending.userId}`
    setPending(null)
  }

  const run = async (member: Member, action: 'remove' | 'transfer') => {
    await (action === 'remove' ? onRemove(member) : onTransfer(member))
    setPending(null)
  }

  return (
    <ul className={styles.memberList} aria-label="Group members" ref={listRef}>
      {members.map((member) => {
        const isSelf = member.userId === currentUserId
        const confirming = pending?.userId === member.userId ? pending.action : null
        return (
          <li key={member.userId} className={styles.memberRow}>
            <div className={styles.memberInfo}>
              <Avatar name={member.fullName} />
              <div>
                <strong id={`member-${member.userId}`}>
                  {member.fullName}
                  {isSelf && ' (you)'}
                </strong>
                <span>Joined {formatDateShort(member.joinedAt.slice(0, 10))}</span>
              </div>
            </div>

            <div className={styles.memberControls}>
              <span className={member.role === 'owner' ? styles.ownerBadge : styles.memberBadge}>
                {member.role === 'owner' ? 'Owner' : 'Member'}
              </span>

              {canManage && member.role !== 'owner' && confirming === null && (
                <>
                  <button
                    type="button"
                    className={styles.removeButton}
                    onClick={() => setPending({ userId: member.userId, action: 'transfer' })}
                    data-action={`transfer-${member.userId}`}
                    disabled={busy}
                    aria-describedby={`member-${member.userId}`}
                  >
                    Make owner
                  </button>
                  <button
                    type="button"
                    className={styles.removeButton}
                    onClick={() => setPending({ userId: member.userId, action: 'remove' })}
                    data-action={`remove-${member.userId}`}
                    disabled={busy}
                    aria-describedby={`member-${member.userId}`}
                  >
                    Remove
                  </button>
                </>
              )}

              {confirming && (
                <div
                  className={styles.confirmActions}
                  role="group"
                  aria-label={confirming === 'transfer' ? `Make ${member.fullName} the owner?` : `Remove ${member.fullName} from the group?`}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape' && !busy) cancel()
                  }}
                >
                  <button
                    type="button"
                    className={styles.confirmRemoveButton}
                    onClick={() => void run(member, confirming)}
                    disabled={busy}
                    aria-describedby={`member-${member.userId}`}
                  >
                    {confirming === 'transfer'
                      ? busy ? 'Transferring...' : 'Confirm owner'
                      : busy ? 'Removing...' : 'Confirm'}
                  </button>
                  <button
                    type="button"
                    ref={cancelRef}
                    className={styles.cancelActionButton}
                    onClick={cancel}
                    disabled={busy}
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
