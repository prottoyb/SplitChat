import { Link } from 'react-router-dom'
import { formatTimestamp, localIsoDate } from '../../shared/domain/dates'
import { formatCents } from '../../shared/domain/money'
import { useResource } from '../../shared/hooks/useResource'
import { ErrorState, LoadingState } from '../../shared/ui'
import { ActivityFeed, listActivity, type ActivityPage } from '../activity'
import { useAuth } from '../auth'
import { balanceTone, loadMyBalance, positionText } from '../balances'
import { listMyExpenses, type ExpenseListItem } from '../expenses'
import { listMyGroups, type GroupSummary } from '../groups'
import { ok, type Result } from '../../shared/api/result'
import { attentionItems, type AttentionItem } from './domain/attention'
import { lastActivityByGroup, monthSummary, recentChangeCount } from './domain/summary'
import styles from './DashboardPage.module.css'

const RECENT_LIMIT = 8
const GROUPS_SHOWN = 6

type DashboardData = {
  groups: GroupSummary[]
  activity: ActivityPage
  expenses: ExpenseListItem[]
}

async function loadDashboard(userId: string): Promise<Result<DashboardData>> {
  const [groups, activity, expenses] = await Promise.all([
    listMyGroups(userId),
    listActivity({ limit: 30 }),
    listMyExpenses(userId),
  ])
  if (!groups.ok) return groups
  if (!activity.ok) return activity
  if (!expenses.ok) return expenses
  return ok({ groups: groups.value, activity: activity.value, expenses: expenses.value })
}

/** Groups with the most recent activity first (the ones the dashboard lists). */
function visibleGroups(groups: GroupSummary[], lastActivity: ReadonlyMap<string, string>): GroupSummary[] {
  return [...groups]
    .sort((a, b) => (lastActivity.get(b.id) ?? b.createdAt).localeCompare(lastActivity.get(a.id) ?? a.createdAt))
    .slice(0, GROUPS_SHOWN)
}

/** The caller's position in each listed group; one failed group never fails the others. */
async function loadPositions(groupIds: string[], userId: string): Promise<Result<Map<string, Result<number>>>> {
  const results = await Promise.all(groupIds.map((id) => loadMyBalance(id, userId)))
  return ok(new Map(groupIds.map((id, i) => [id, results[i]])))
}

function GroupPosition({ position }: { position: Result<number> | undefined }) {
  if (!position) return <span className={styles.positionMuted}>Checking balance…</span>
  if (!position.ok) return <span className={styles.positionMuted}>Balance unavailable</span>
  return <span className={styles[balanceTone(position.value)]}>{positionText(position.value)}</span>
}

function attentionText(item: AttentionItem) {
  switch (item.kind) {
    case 'expense_changed':
      return (
        <>
          <strong>{item.subject}</strong> changed an expense you're part of in <strong>{item.groupName}</strong>
        </>
      )
    case 'added_to_group':
      return (
        <>
          <strong>{item.subject}</strong> added you to <strong>{item.groupName}</strong>
        </>
      )
    case 'solo_group':
      return (
        <>
          <strong>{item.groupName}</strong> has no other members yet — add someone to start splitting
        </>
      )
  }
}

function DashboardPage() {
  const { session, profile } = useAuth()
  const userId = session?.user.id ?? ''
  const data = useResource(userId ? `dashboard:${userId}` : null, () => loadDashboard(userId))
  const shownIds =
    data.status === 'ready' ? visibleGroups(data.data.groups, lastActivityByGroup(data.data.activity.events)).map((g) => g.id) : []
  const positions = useResource(shownIds.length ? `positions:${userId}:${shownIds.join(',')}` : null, () =>
    loadPositions(shownIds, userId),
  )
  const firstName = profile?.full_name?.trim().split(/\s+/)[0]

  const header = (
    <header className="topbar">
      <div>
        <p className="eyebrow">OVERVIEW</p>
        <h2>{firstName ? `Welcome back, ${firstName}` : 'Welcome to SplitChat'}</h2>
        <p className="subtitle">Your groups, recent expenses and anything that needs a look.</p>
      </div>
      <Link to="/groups?create=1" className="primary-button">
        + Create group
      </Link>
    </header>
  )

  if (data.status === 'loading') {
    return (
      <>
        {header}
        <LoadingState title="Loading your overview..." />
      </>
    )
  }
  if (data.status === 'error') {
    return (
      <>
        {header}
        <ErrorState title="Overview unavailable" message={data.error.message} actions={[{ label: 'Try again', onClick: data.reload }]} />
      </>
    )
  }

  const { groups, activity, expenses } = data.data
  const month = monthSummary(expenses, localIsoDate())
  const changes = recentChangeCount(activity.events, 7)
  const attention = attentionItems(activity, groups, userId).slice(0, 5)
  const lastActivity = lastActivityByGroup(activity.events)
  const recent: ActivityPage = { ...activity, events: activity.events.slice(0, RECENT_LIMIT), next: null }
  const sortedGroups = visibleGroups(groups, lastActivity)

  return (
    <>
      {header}

      <section className="summary-grid" aria-label="Summary">
        <article className="summary-card">
          <div className="summary-icon" aria-hidden="true">◎</div>
          <div>
            <p>Active groups</p>
            <h3>{groups.length}</h3>
            <span>{groups.length === 0 ? 'Create your first group' : `${groups.filter((g) => g.myRole === 'owner').length} you own`}</span>
          </div>
        </article>
        <article className="summary-card">
          <div className="summary-icon" aria-hidden="true">$</div>
          <div>
            <p>Your share this month</p>
            <h3>{formatCents(month.myShareCents)}</h3>
            <span>
              {month.count} {month.count === 1 ? 'expense' : 'expenses'} totalling {formatCents(month.totalCents)}
            </span>
          </div>
        </article>
        <article className="summary-card">
          <div className="summary-icon" aria-hidden="true">↻</div>
          <div>
            <p>Changes this week</p>
            <h3>{changes}</h3>
            <span>Across all your groups</span>
          </div>
        </article>
      </section>

      <section className={styles.grid}>
        <article className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">RECENT ACTIVITY</p>
              <h3>What happened</h3>
            </div>
          </div>
          <ActivityFeed
            page={recent}
            currentUserId={userId}
            showGroup
            emptyText="Nothing has happened yet. Create a group and add your first expense."
          />
          {activity.events.length > 0 && (
            <div className={styles.panelFooter}>
              <Link to="/activity">View all activity →</Link>
            </div>
          )}
        </article>

        <div className={styles.side}>
          <article className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">NEEDS YOUR ATTENTION</p>
                <h3>For you</h3>
              </div>
            </div>
            {attention.length === 0 ? (
              <p className={styles.allClear}>You're all caught up.</p>
            ) : (
              <ul className={styles.attentionList}>
                {attention.map((item) => (
                  <li key={item.key}>
                    <Link to={item.to} className={styles.attentionItem}>
                      <p className={styles.attentionText}>{attentionText(item)}</p>
                      {item.createdAt && <span>{formatTimestamp(item.createdAt)}</span>}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </article>

          <article className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">GROUPS</p>
                <h3>Your groups</h3>
              </div>
            </div>
            {groups.length === 0 ? (
              <p className={styles.allClear}>
                You're not in any groups yet. <Link to="/groups?create=1">Create one</Link> to start sharing costs.
              </p>
            ) : (
              <ul className={styles.groupList}>
                {sortedGroups.map((g) => (
                  <li key={g.id}>
                    <Link to={`/groups/${g.id}`} className={styles.groupItem}>
                      <div className={styles.groupMain}>
                        <strong>{g.name}</strong>
                        <small>
                          {g.memberCount} {g.memberCount === 1 ? 'member' : 'members'} · {g.myRole === 'owner' ? 'Owner' : 'Member'}
                          {lastActivity.get(g.id) && <> · Active {formatTimestamp(lastActivity.get(g.id) as string)}</>}
                        </small>
                      </div>
                      <GroupPosition position={positions.status === 'ready' ? positions.data.get(g.id) : undefined} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {groups.length > sortedGroups.length && (
              <div className={styles.panelFooter}>
                <Link to="/groups">All groups →</Link>
              </div>
            )}
          </article>
        </div>
      </section>
    </>
  )
}

export default DashboardPage
