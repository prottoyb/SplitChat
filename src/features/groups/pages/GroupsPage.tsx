import { useState } from 'react'
import { Link } from 'react-router-dom'
import { formatDateShort } from '../../../shared/domain/dates'
import { useResource } from '../../../shared/hooks/useResource'
import { ErrorState, LoadingState, Notice } from '../../../shared/ui'
import { useAuth } from '../../auth'
import { createGroup, listMyGroups, type GroupSummary } from '../api/groups'
import { CreateGroupForm } from '../components/CreateGroupForm'
import type { GroupInput } from '../domain/groupForm'
import styles from './GroupsPage.module.css'

function GroupCard({ group }: { group: GroupSummary }) {
  return (
    <Link to={`/groups/${group.id}`} className={styles.groupCardLink}>
      <article className={styles.groupCard}>
        <div className={styles.groupCardTop}>
          <div className={styles.groupIcon} aria-hidden="true">
            ◎
          </div>
          <span className={styles.ownerBadge}>{group.myRole === 'owner' ? 'Owner' : 'Member'}</span>
        </div>
        <h3>{group.name}</h3>
        <p>{group.description || 'No description has been added yet.'}</p>
        <div className={styles.groupMeta}>
          {group.memberCount} {group.memberCount === 1 ? 'member' : 'members'} · Created{' '}
          {formatDateShort(group.createdAt.slice(0, 10))}
        </div>
      </article>
    </Link>
  )
}

function GroupsPage() {
  const { session } = useAuth()
  const userId = session?.user.id ?? ''
  const groups = useResource(userId ? `groups:${userId}` : null, () => listMyGroups(userId))
  const [showCreate, setShowCreate] = useState(false)
  const [success, setSuccess] = useState('')

  const handleCreate = async (input: GroupInput) => {
    const result = await createGroup(input, userId)
    if (!result.ok) return result.message
    setShowCreate(false)
    setSuccess('Group created successfully.')
    groups.reload()
    return null
  }

  const openCreate = () => {
    setSuccess('')
    setShowCreate(true)
  }

  return (
    <>
      <header className="topbar">
        <div>
          <p className="eyebrow">GROUPS</p>
          <h2>Your groups</h2>
          <p className="subtitle">Create groups for trips, households and anything you share.</p>
        </div>
        <button type="button" className="primary-button" onClick={openCreate} disabled={showCreate}>
          + Create group
        </button>
      </header>

      {success && <Notice tone="success">{success}</Notice>}

      {showCreate && <CreateGroupForm onCreate={handleCreate} onClose={() => setShowCreate(false)} />}

      <section className={styles.groupsSection} aria-busy={groups.refreshing || undefined}>
        {groups.status === 'loading' ? (
          <LoadingState title="Loading groups..." message="Getting your SplitChat groups." />
        ) : groups.status === 'error' ? (
          <ErrorState
            title="Groups unavailable"
            message={groups.error.message}
            actions={[{ label: 'Try again', onClick: groups.reload }]}
          />
        ) : groups.data.length === 0 ? (
          <div className={styles.stateCard}>
            <div className={styles.stateIcon} aria-hidden="true">
              ◎
            </div>
            <h3>No groups yet</h3>
            <p>Create your first group to start organising shared expenses.</p>
            {!showCreate && (
              <button type="button" className="secondary-button" onClick={openCreate}>
                Create your first group
              </button>
            )}
          </div>
        ) : (
          <div className={styles.groupGrid}>
            {groups.data.map((group) => (
              <GroupCard key={group.id} group={group} />
            ))}
          </div>
        )}
      </section>
    </>
  )
}

export default GroupsPage
