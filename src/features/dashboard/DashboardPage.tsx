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
import { listActionableProposals, type Candidate } from '../smart-expense'
import { ok, type Result } from '../../shared/api/result'
import { attentionItems, type AttentionItem } from './domain/attention'
import { needsYouItems, overallPosition, type NeedsYouItem } from './domain/needsYou'
import { lastActivityByGroup, monthSummary } from './domain/summary'
import styles from './DashboardPage.module.css'

const RECENT_LIMIT = 8
const GROUPS_SHOWN = 6

type DashboardData = {
  groups: GroupSummary[]
  activity: ActivityPage
  expenses: ExpenseListItem[]
  /** Null when proposals could not be loaded: the rest of the dashboard still shows. */
  proposals: Candidate[] | null
}

async function loadDashboard(userId: string): Promise<Result<DashboardData>> {
  const [groups, activity, expenses] = await Promise.all([
    listMyGroups(userId),
    listActivity({ limit: 30 }),
    // Only this month's expenses feed the summary; never the whole history.
    listMyExpenses(userId, { since: `${localIsoDate().slice(0, 7)}-01` }),
  ])
  if (!groups.ok) return groups
  if (!activity.ok) return activity
  if (!expenses.ok) return expenses
  const owned = groups.value.filter((g) => g.myRole === 'owner').map((g) => g.id)
  const proposals = await listActionableProposals(userId, owned)
  return ok({ groups: groups.value, activity: activity.value, expenses: expenses.value, proposals: proposals.ok ? proposals.value : null })
}

/** Groups with the most recent activity first (the ones the dashboard lists). */
function visibleGroups(groups: GroupSummary[], lastActivity: ReadonlyMap<string, string>): GroupSummary[] {
  return [...groups]
    .sort((a, b) => (lastActivity.get(b.id) ?? b.createdAt).localeCompare(lastActivity.get(a.id) ?? a.createdAt))
    .slice(0, GROUPS_SHOWN)
}

/** The caller's position in each group; one failed group never fails the others. */
async function loadPositions(groupIds: string[], userId: string): Promise<Result<Map<string, Result<number>>>> {
  const results = await Promise.all(groupIds.map((id) => loadMyBalance(id, userId)))
  return ok(new Map(groupIds.map((id, i) => [id, results[i]])))
}

function GroupPosition({ position }: { position: Result<number> | undefined }) {
  if (!position) return <span className={styles.positionMuted}>Checking balance…</span>
  if (!position.ok) return <span className={styles.positionMuted}>Balance unavailable</span>
  return <span className={styles[balanceTone(position.value)]}>{positionText(position.value)}</span>
}

const quoted = (text: string | null) => (text ? `“${text}”` : 'A proposal')

function needsYouText(item: NeedsYouItem) {
  if (item.kind === 'you_owe') {
    return (
      <>
        You owe <strong>{formatCents(item.amountCents)}</strong> in <strong>{item.groupName}</strong>
      </>
    )
  }
  const amount = item.amountCents !== null ? ` ${formatCents(item.amountCents)}` : ''
  return item.missing.length === 0 ? (
    <>
      <strong>{quoted(item.description)}</strong>{amount} is ready to review in <strong>{item.groupName}</strong>
    </>
  ) : (
    <>
      <strong>{quoted(item.description)}</strong>{amount} needs {item.missing.join(', ')} in <strong>{item.groupName}</strong>
    </>
  )
}

const needsYouAction = (item: NeedsYouItem) =>
  item.kind === 'you_owe' ? 'Settle up' : item.missing.length === 0 ? 'Review' : 'Add details'

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
  // Every group's position: the list shows a few, the overall figure needs all.
  const groupIds = data.status === 'ready' ? data.data.groups.map((g) => g.id) : []
  const positions = useResource(groupIds.length ? `positions:${userId}:${groupIds.join(',')}` : null, () =>
    loadPositions(groupIds, userId),
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
  const positionMap = positions.status === 'ready' ? positions.data : null
  const overall = positionMap ? overallPosition(positionMap) : null
  const actions = needsYouItems(data.data.proposals ?? [], groups, positionMap)
  const attention = attentionItems(activity, groups, userId).slice(0, Math.max(0, 6 - actions.length))
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
          <div className="summary-icon" aria-hidden="true">±</div>
          <div>
            <p>Overall</p>
            {overall === null ? (
              <h3 className={styles.positionMuted}>{positions.status === 'error' ? 'Unavailable' : 'Checking…'}</h3>
            ) : (
              <h3 className={styles[balanceTone(overall.netCents)]}>
                {overall.netCents > 0 ? `+${formatCents(overall.netCents)}` : overall.netCents < 0 ? `−${formatCents(-overall.netCents)}` : formatCents(0)}
              </h3>
            )}
            <span>
              {overall === null
                ? 'Across all your groups'
                : overall.netCents > 0
                  ? `You are owed, across ${overall.openGroups} ${overall.openGroups === 1 ? 'group' : 'groups'}`
                  : overall.netCents < 0
                    ? `You owe, across ${overall.openGroups} ${overall.openGroups === 1 ? 'group' : 'groups'}`
                    : overall.openGroups > 0
                      ? `Even overall; settle within each group`
                      : 'You are settled up everywhere'}
              {overall && overall.unavailable > 0 && ` · ${overall.unavailable} unavailable`}
            </span>
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
                <p className="eyebrow">NEEDS YOU</p>
                <h3>For you</h3>
              </div>
            </div>
            {actions.length === 0 && attention.length === 0 ? (
              <p className={styles.allClear}>Nothing needs you right now.</p>
            ) : (
              <ul className={styles.attentionList}>
                {actions.map((item) => (
                  <li key={item.key}>
                    <Link to={item.to} className={styles.attentionItem}>
                      <p className={styles.attentionText}>{needsYouText(item)}</p>
                      <span className={styles.actionLabel}>{needsYouAction(item)} →</span>
                    </Link>
                  </li>
                ))}
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
            {data.data.proposals === null && (
              <p className={styles.allClear} role="status">
                Expense proposals could not be checked. <button type="button" className={styles.inlineRetry} onClick={data.reload}>Try again</button>
              </p>
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
