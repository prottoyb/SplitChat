import { InlineConfirm } from '../../../shared/ui'
import styles from '../pages/GroupMembers.module.css'
import { AddMemberForm } from './AddMemberForm'

/**
 * The owner manages membership (add by email; delete the group while it is
 * the sole member); a member can leave. The server decides in every case —
 * e.g. a group that ever had other members is never deletable (M15).
 */
export function MembershipPanel({
  isOwner,
  isSoleMember,
  onAdd,
  onLeave,
  onDelete,
}: {
  isOwner: boolean
  isSoleMember: boolean
  onAdd: (email: string) => Promise<boolean>
  onLeave: () => Promise<void>
  onDelete: () => Promise<void>
}) {
  if (isOwner) {
    return (
      <article className={styles.panel}>
        <div className={styles.panelHeader}>
          <div>
            <p className="eyebrow">ADD MEMBER</p>
            <h4 className={styles.panelTitle}>Add someone</h4>
          </div>
        </div>
        <p className={styles.panelDescription}>
          Add an existing SplitChat user using the email address connected to their account.
        </p>
        <AddMemberForm onAdd={onAdd} />
        <div className={styles.infoBox}>
          <strong>Existing accounts only</strong>
          <p>The person must already have a SplitChat account with a confirmed email address.</p>
        </div>
        <div className={styles.infoBox}>
          <strong>Leaving this group</strong>
          <p>As the owner, make another member the owner first. You can then leave like any other member.</p>
        </div>
        {isSoleMember && (
          <div className={styles.leaveSection}>
            <InlineConfirm
              triggerLabel="Delete group"
              title="Delete this group permanently?"
              description="The group and all of its expenses will be deleted. This cannot be undone. A group that anyone else has ever been part of is kept instead."
              confirmLabel="Yes, delete"
              busyLabel="Deleting..."
              onConfirm={onDelete}
            />
          </div>
        )}
      </article>
    )
  }

  return (
    <article className={styles.panel}>
      <div className={styles.panelHeader}>
        <div>
          <p className="eyebrow">MEMBERSHIP</p>
          <h4 className={styles.panelTitle}>Group access</h4>
        </div>
      </div>
      <div className={styles.memberNotice}>
        <p className={styles.noticeTitle}>You are a member of this group</p>
        <p>You can view this group and participate in its shared activity.</p>
      </div>
      <div className={styles.leaveSection}>
        <InlineConfirm
          triggerLabel="Leave group"
          title="Leave this group?"
          description="You will lose access to this group and its shared information. Your past expenses stay in the group's history."
          confirmLabel="Yes, leave"
          busyLabel="Leaving..."
          onConfirm={onLeave}
        />
      </div>
    </article>
  )
}
