import { ErrorState, LoadingState, Notice, SectionHeader } from '../../../shared/ui'
import { ActivityFeed, useActivityFeed } from '../../../features/activity'
import type { GroupDetail } from '../../../features/groups'

/** Everything that happened in this group (the event log, ADR-0009), newest first. */
export function ActivitySection({ group, userId }: { group: GroupDetail; userId: string }) {
  const { feed, loadMore, loadingMore, moreError } = useActivityFeed(userId, group.id)

  return (
    <>
      <SectionHeader title="Activity" description="Expenses, payments and membership changes in this group, newest first." />
      {moreError && <Notice tone="error">{moreError}</Notice>}
      {feed.status === 'loading' ? (
        <LoadingState title="Loading activity..." />
      ) : feed.status === 'error' ? (
        <ErrorState title="Activity unavailable" message={feed.error.message} actions={[{ label: 'Try again', onClick: feed.reload }]} />
      ) : (
        <section className="panel">
          <ActivityFeed
            page={feed.data}
            currentUserId={userId}
            onLoadMore={loadMore}
            loadingMore={loadingMore}
            emptyText="Nothing has happened in this group yet."
          />
        </section>
      )}
    </>
  )
}
