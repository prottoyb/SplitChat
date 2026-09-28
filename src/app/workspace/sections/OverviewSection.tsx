import { Link } from 'react-router-dom'
import { useResource } from '../../../shared/hooks/useResource'
import { Avatar, ErrorState, LoadingState, SectionHeader } from '../../../shared/ui'
import { ActivityFeed, listActivity } from '../../../features/activity'
import { loadGroupBalances, simplifyDebts } from '../../../features/balances'
import { nextStep } from './nextStep'
import { ExpenseList, listMyExpenses } from '../../../features/expenses'
import type { GroupDetail } from '../../../features/groups'
import styles from '../GroupWorkspace.module.css'

const RECENT_EXPENSES = 5
const RECENT_EVENTS = 6
const MEMBERS_SHOWN = 6

async function loadPlan(groupId: string) {
  const balances = await loadGroupBalances(groupId)
  if (!balances.ok) return balances
  const transfers = simplifyDebts(balances.value.people.map((p) => ({ userId: p.userId, netCents: p.netCents })))
  return { ok: true as const, value: { transfers, names: balances.value.names } }
}

/** A group's landing section: what to do next, recent expenses and activity, and who is in it. */
export function OverviewSection({ group, userId, myNet }: { group: GroupDetail; userId: string; myNet: number | null }) {
  const base = `/groups/${group.id}`
  const expenses = useResource(`overview-expenses:${group.id}:${userId}`, () =>
    listMyExpenses(userId, { groupId: group.id, limit: RECENT_EXPENSES }),
  )
  const activity = useResource(`overview-activity:${group.id}:${userId}`, () =>
    listActivity({ groupId: group.id, limit: RECENT_EVENTS }),
  )
  // Keyed on the header position so a payment recorded elsewhere refreshes it.
  const plan = useResource(`overview-plan:${group.id}:${userId}:${myNet}`, () => loadPlan(group.id))
  const step = nextStep(group, userId, plan.status === 'ready' ? plan.data : null, expenses.status === 'ready' ? expenses.data.length : null)

  return (
    <>
      <SectionHeader title="Overview" />

      {step && (
        <div className={styles.nextStep}>
          <p>{step.text}</p>
          <Link to={step.to} className="secondary-button">
            {step.label}
          </Link>
        </div>
      )}

      <div className={styles.overviewGrid}>
        <div className={styles.column}>
          <article className={`panel ${styles.compactPanel}`}>
            <div className={styles.panelHead}>
              <h4>Recent expenses</h4>
              {expenses.status === 'ready' && expenses.data.length > 0 && <Link to={`${base}/expenses`}>All expenses →</Link>}
            </div>
            {expenses.status === 'loading' ? (
              <LoadingState compact title="Loading expenses..." />
            ) : expenses.status === 'error' ? (
              <ErrorState compact title="Expenses unavailable" message={expenses.error.message} actions={[{ label: 'Try again', onClick: expenses.reload }]} />
            ) : expenses.data.length === 0 ? (
              <p className={styles.muted}>No expenses yet.</p>
            ) : (
              <ExpenseList expenses={expenses.data} userId={userId} showGroup={false} />
            )}
          </article>

          <article className={`panel ${styles.compactPanel}`}>
            <div className={styles.panelHead}>
              <h4>Recent activity</h4>
              {activity.status === 'ready' && activity.data.events.length > 0 && <Link to={`${base}/activity`}>All activity →</Link>}
            </div>
            {activity.status === 'loading' ? (
              <LoadingState compact title="Loading activity..." />
            ) : activity.status === 'error' ? (
              <ErrorState compact title="Activity unavailable" message={activity.error.message} actions={[{ label: 'Try again', onClick: activity.reload }]} />
            ) : (
              <ActivityFeed page={{ ...activity.data, next: null }} currentUserId={userId} emptyText="Nothing has happened in this group yet." />
            )}
          </article>
        </div>

        <article className={`panel ${styles.compactPanel}`}>
          <div className={styles.panelHead}>
            <h4>Members</h4>
            <Link to={`${base}/members`}>{group.myRole === 'owner' ? 'Manage →' : 'View all →'}</Link>
          </div>
          <ul className={styles.memberList} aria-label="Members">
            {group.members.slice(0, MEMBERS_SHOWN).map((m) => (
              <li key={m.userId}>
                <Avatar name={m.fullName} />
                <span className={styles.memberName}>
                  {m.fullName}
                  {m.userId === userId && <span className={styles.you}> (you)</span>}
                </span>
                {m.role === 'owner' && <span className={styles.ownerTag}>Owner</span>}
              </li>
            ))}
          </ul>
          {group.members.length > MEMBERS_SHOWN && (
            <p className={styles.muted}>and {group.members.length - MEMBERS_SHOWN} more</p>
          )}
        </article>
      </div>
    </>
  )
}
