import { useState, type ComponentType } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { formatDateShort } from '../../../shared/domain/dates'
import { useResource } from '../../../shared/hooks/useResource'
import { ErrorState, LoadingState, Notice } from '../../../shared/ui'
import { useAuth } from '../../auth'
import { createGroup, listMyGroups, type GroupSummary } from '../api/groups'
import { CreateGroupForm } from '../components/CreateGroupForm'
import type { GroupInput } from '../domain/groupForm'
import styles from './GroupsPage.module.css'

/** Renders the caller's position in a group; supplied by the app, which may use balances. */
export type GroupPositionComponent = ComponentType<{ groupId: string; userId: string }>

function GroupCard({ group, userId, Position }: { group: GroupSummary; userId: string; Position?: GroupPositionComponent }) {
  return (
    <Link to={`/groups/${group.id}`} className={styles.groupCardLink}>
      {/* A div, not an article: a landmark inside a link hides the card's
          text from the link's accessible name. */}
      <div className={styles.groupCard}>
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
        {Position && <Position groupId={group.id} userId={userId} />}
      </div>
    </Link>
  )
}

function GroupsPage({ Position }: { Position?: GroupPositionComponent }) {
  const { session } = useAuth()
  const userId = session?.user.id ?? ''
  const groups = useResource(userId ? `groups:${userId}` : null, () => listMyGroups(userId))
  const [params, setParams] = useSearchParams()
  // `/groups?create=1` (e.g. from the dashboard) opens the form directly.
  const [showCreate, setShowCreate] = useState(params.get('create') === '1')
  const [success, setSuccess] = useState('')

  const handleCreate = async (input: GroupInput) => {
    const result = await createGroup(input, userId)
    if (!result.ok) return result.message
    setShowCreate(false)
    if (params.has('create')) setParams({}, { replace: true })
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
              <GroupCard key={group.id} group={group} userId={userId} Position={Position} />
            ))}
          </div>
        )}
      </section>
    </>
  )
}

export default GroupsPage
