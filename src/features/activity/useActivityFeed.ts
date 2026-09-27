import { useState } from 'react'
import { useResource } from '../../shared/hooks/useResource'
import { appendPage, listActivity } from './api/events'

const PAGE_SIZE = 25

/**
 * The activity feed for the caller's groups, or one group, with "load more"
 * keyset paging. Later pages are merged de-duplicated by event id.
 */
export function useActivityFeed(userId: string, groupId?: string) {
  const feed = useResource(userId ? `activity:${userId}:${groupId ?? ''}` : null, () =>
    listActivity({ groupId: groupId || undefined, limit: PAGE_SIZE }),
  )
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState('')

  const loadMore = async () => {
    if (feed.status !== 'ready' || !feed.data.next) return
    setLoadingMore(true)
    setMoreError('')
    const result = await listActivity({ groupId: groupId || undefined, before: feed.data.next, limit: PAGE_SIZE })
    setLoadingMore(false)
    if (!result.ok) return setMoreError(result.message)
    feed.setData((current) => appendPage(current, result.value))
  }

  return { feed, loadMore, loadingMore, moreError }
}
