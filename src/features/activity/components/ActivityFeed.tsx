import { Link } from 'react-router-dom'
import { formatDateLong, localIsoDate, addDays } from '../../../shared/domain/dates'
import type { ActivityPage } from '../api/events'
import { describeEvent } from '../domain/describeEvent'
import styles from './activity.module.css'

const ICON = { expense: '$', member: '◉', group: '◎', settlement: '⇄' } as const

const TIME = new Intl.DateTimeFormat('en-AU', { hour: 'numeric', minute: '2-digit' })

function dayLabel(localDay: string, today: string): string {
  if (localDay === today) return 'Today'
  if (localDay === addDays(today, -1)) return 'Yesterday'
  return formatDateLong(localDay)
}

/**
 * The activity feed, newest first, grouped by local day. `showGroup` names
 * the group on each entry (cross-group views). Backfilled entries were
 * reconstructed when tracking started, so the feed says history before that
 * may be incomplete (ADR-0009 condition 10).
 */
export function ActivityFeed({
  page,
  currentUserId,
  showGroup = false,
  onLoadMore,
  loadingMore = false,
  emptyText = 'No activity yet.',
}: {
  page: ActivityPage
  currentUserId: string
  showGroup?: boolean
  onLoadMore?: () => void
  loadingMore?: boolean
  emptyText?: string
}) {
  if (page.events.length === 0) return <p className={styles.empty}>{emptyText}</p>

  const today = localIsoDate()
  const days = new Map<string, typeof page.events>()
  for (const event of page.events) {
    const key = localIsoDate(new Date(event.createdAt))
    days.set(key, [...(days.get(key) ?? []), event])
  }
  const hasBackfilled = page.events.some((e) => e.backfilled)
  const ctx = { currentUserId, names: page.names, expenseTitles: page.expenseTitles }

  return (
    <div className={styles.feed}>
      {[...days].map(([key, events]) => (
        <section key={key} className={styles.day} aria-label={dayLabel(key, today)}>
          <h4>{dayLabel(key, today)}</h4>
          <ul className={styles.list}>
            {events.map((event) => {
              const d = describeEvent(event, ctx)
              return (
                <li key={event.id} className={styles.item}>
                  <span className={`${styles.icon} ${styles[d.category]}`} aria-hidden="true">
                    {ICON[d.category]}
                  </span>
                  <div>
                    <p className={styles.sentence}>
                      <strong>{d.actor}</strong> {d.action}{' '}
                      {d.target &&
                        (d.target.to ? <Link to={d.target.to}>{d.target.label}</Link> : <strong>{d.target.label}</strong>)}
                      {d.detail && <span className={styles.detail}> {d.detail}</span>}
                    </p>
                    {showGroup && (
                      <p className={styles.meta}>
                        <Link to={`/groups/${event.groupId}`}>{page.groupNames.get(event.groupId) ?? 'Group'}</Link>
                        {event.backfilled && ' · recorded before activity tracking'}
                      </p>
                    )}
                  </div>
                  <time className={styles.time} dateTime={event.createdAt}>
                    {TIME.format(new Date(event.createdAt))}
                  </time>
                </li>
              )
            })}
          </ul>
        </section>
      ))}

      <div className={styles.footer}>
        {page.next && onLoadMore && (
          <button type="button" className="secondary-button" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading...' : 'Load more'}
          </button>
        )}
        {hasBackfilled && (
          <p className={styles.note}>
            Some earlier entries were reconstructed when activity tracking started; older edits and deletions are not shown.
          </p>
        )}
      </div>
    </div>
  )
}
