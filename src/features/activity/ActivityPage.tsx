import { useSearchParams } from 'react-router-dom'
import { useResource } from '../../shared/hooks/useResource'
import { ErrorState, LoadingState, Notice } from '../../shared/ui'
import { useAuth } from '../auth'
import { listMyGroups } from '../groups'
import { ActivityFeed } from './components/ActivityFeed'
import { useActivityFeed } from './useActivityFeed'
import styles from './components/activity.module.css'

function ActivityPage() {
  const { session } = useAuth()
  const userId = session?.user.id ?? ''
  const [params, setParams] = useSearchParams()
  const groupId = params.get('group') ?? ''

  const groups = useResource(userId ? `groups:${userId}` : null, () => listMyGroups(userId))
  const { feed, loadMore, loadingMore, moreError } = useActivityFeed(userId, groupId)

  return (
    <>
      <header className="topbar">
        <div>
          <p className="eyebrow">ACTIVITY</p>
          <h2>What happened</h2>
          <p className="subtitle">Expenses and membership changes across your groups, newest first.</p>
        </div>
      </header>

      <div className={styles.filters}>
        <label htmlFor="activity-group">Group</label>
        <select
          id="activity-group"
          value={groupId}
          onChange={(e) => setParams(e.target.value ? { group: e.target.value } : {}, { replace: true })}
        >
          <option value="">All groups</option>
          {groups.status === 'ready' &&
            groups.data.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
        </select>
      </div>

      {moreError && <Notice tone="error">{moreError}</Notice>}

      <section className="panel">
        {feed.status === 'loading' ? (
          <LoadingState title="Loading activity..." />
        ) : feed.status === 'error' ? (
          <ErrorState title="Activity unavailable" message={feed.error.message} actions={[{ label: 'Try again', onClick: feed.reload }]} />
        ) : (
          <ActivityFeed
            page={feed.data}
            currentUserId={userId}
            showGroup={!groupId}
            onLoadMore={loadMore}
            loadingMore={loadingMore}
            emptyText="Nothing has happened in your groups yet. Add an expense to get started."
          />
        )}
      </section>
    </>
  )
}

export default ActivityPage
