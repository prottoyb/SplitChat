import { formatTimestamp } from '../../../shared/domain/dates'
import { SectionHeader } from '../../../shared/ui'
import type { GroupDetail } from '../../../features/groups'
import styles from '../GroupWorkspace.module.css'

/**
 * The group's details, reached from the group menu. Read-only for everyone
 * until owners can rename a group (operator decision D4, Phase 9).
 */
export function SettingsSection({ group }: { group: GroupDetail }) {
  const owner = group.members.find((m) => m.role === 'owner')
  return (
    <>
      <SectionHeader title="Group settings" description="The group’s name and description, as everyone in it sees them." />
      <section className="panel">
        <dl className={styles.details}>
          <div>
            <dt>Name</dt>
            <dd>{group.name}</dd>
          </div>
          <div>
            <dt>Description</dt>
            <dd>{group.description?.trim() || <span className={styles.muted}>No description</span>}</dd>
          </div>
          <div>
            <dt>Owner</dt>
            <dd>{owner ? owner.fullName : <span className={styles.muted}>No active owner</span>}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{formatTimestamp(group.createdAt)}</dd>
          </div>
        </dl>
      </section>
    </>
  )
}
