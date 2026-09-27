import { useEffect, useRef, type RefObject } from 'react'
import { Link, Navigate, NavLink, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { useResource } from '../../shared/hooks/useResource'
import { ErrorState, LoadingState, SECTION_HEADING_ID } from '../../shared/ui'
import { useAuth } from '../../features/auth'
import { balanceTone, loadMyBalance, positionText } from '../../features/balances'
import { GroupMembersSection, loadGroupDetail } from '../../features/groups'
import { GroupBalancesSection } from '../../features/settlements'
import { ActivitySection } from './sections/ActivitySection'
import { ExpensesSection } from './sections/ExpensesSection'
import { OverviewSection } from './sections/OverviewSection'
import styles from './GroupWorkspace.module.css'

const SECTIONS = [
  { path: '', label: 'Overview' },
  { path: 'expenses', label: 'Expenses' },
  { path: 'balances', label: 'Balances' },
  { path: 'activity', label: 'Activity' },
  { path: 'members', label: 'Members' },
] as const

/**
 * Keeps the current section's link in view in the (scrollable) section nav,
 * and moves focus to the section heading after navigating between sections
 * (not on first load).
 */
function useSectionFocus(nav: RefObject<HTMLElement | null>, ready: boolean) {
  const { pathname } = useLocation()
  const previous = useRef(pathname)
  useEffect(() => {
    nav.current?.querySelector('[aria-current="page"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    if (previous.current === pathname) return
    previous.current = pathname
    document.getElementById(SECTION_HEADING_ID)?.focus()
  }, [pathname, nav, ready])
}

/**
 * One group's workspace at `/groups/:groupId/*`: a persistent header (group
 * identity, the caller's position from the server balances, the primary
 * action) and section navigation. Sections own their own loading and error
 * states, so the header and navigation stay in place.
 */
function GroupWorkspace() {
  const { groupId = '' } = useParams<{ groupId: string }>()
  const { session } = useAuth()
  const userId = session?.user.id ?? ''
  const ready = groupId && userId
  const group = useResource(ready ? `group:${groupId}:${userId}` : null, () => loadGroupDetail(groupId, userId))
  // A failed position degrades only the position, never the workspace.
  const position = useResource(ready ? `position:${groupId}:${userId}` : null, () => loadMyBalance(groupId, userId))
  const sectionNav = useRef<HTMLElement>(null)
  useSectionFocus(sectionNav, group.status === 'ready')

  if (group.status === 'loading') {
    return <LoadingState title="Loading group..." message="Getting the group and its members." />
  }
  if (group.status === 'error') {
    return (
      <ErrorState
        title="Group unavailable"
        message={group.error.message}
        actions={[
          ...(group.error.code === 'network' || group.error.code === 'unknown'
            ? [{ label: 'Try again', onClick: group.reload }]
            : []),
          { label: '← Back to groups', to: '/groups' },
        ]}
      />
    )
  }

  const detail = group.data
  const base = `/groups/${groupId}`
  const memberCount = detail.members.length
  const myNet = position.status === 'ready' ? position.data : null

  return (
    <div className={styles.workspace}>
      <header className={styles.header}>
        <nav aria-label="Breadcrumb">
          <ol className={styles.breadcrumb}>
            <li>
              <Link to="/groups">Groups</Link>
            </li>
            <li aria-current="page">{detail.name}</li>
          </ol>
        </nav>

        <div className={styles.titleRow}>
          <div className={styles.identity}>
            <div className={styles.titleLine}>
              <h2>{detail.name}</h2>
              <span className={styles.roleBadge}>{detail.myRole === 'owner' ? 'Owner' : 'Member'}</span>
            </div>
            <p className={styles.meta}>
              {memberCount} {memberCount === 1 ? 'member' : 'members'}
              {detail.description && <span className={styles.description}> · {detail.description}</span>}
            </p>
          </div>

          <div className={styles.aside}>
            <div className={styles.position} aria-live="polite">
              <span className={styles.positionLabel}>Your position</span>
              {position.status === 'loading' ? (
                <strong className={styles.positionMuted}>Checking…</strong>
              ) : position.status === 'error' ? (
                <span className={styles.positionError}>
                  <strong className={styles.positionMuted}>Unavailable</strong>
                  <button type="button" className={styles.retry} onClick={position.reload}>
                    Retry
                  </button>
                </span>
              ) : (
                <strong className={styles[balanceTone(position.data)]}>{positionText(position.data)}</strong>
              )}
            </div>
            <Link to={`${base}/expenses/new`} className={`primary-button ${styles.addButton}`}>
              + Add expense
            </Link>
          </div>
        </div>

        <nav aria-label="Group sections" className={styles.tabs} ref={sectionNav}>
          {SECTIONS.map((s) => (
            <NavLink
              key={s.label}
              to={s.path ? `${base}/${s.path}` : base}
              end={!s.path}
              className={({ isActive }) => `${styles.tab}${isActive ? ` ${styles.tabActive}` : ''}`}
            >
              {s.label}
            </NavLink>
          ))}
        </nav>
      </header>

      <div className={styles.body}>
        <Routes>
          <Route index element={<OverviewSection group={detail} userId={userId} myNet={myNet} />} />
          <Route path="expenses" element={<ExpensesSection group={detail} userId={userId} />} />
          <Route
            path="balances"
            element={<GroupBalancesSection group={detail} userId={userId} onBalancesChanged={position.reload} />}
          />
          <Route path="activity" element={<ActivitySection group={detail} userId={userId} />} />
          <Route
            path="members"
            element={
              <GroupMembersSection
                group={detail}
                userId={userId}
                updateGroup={group.setData}
                reloadGroup={group.reload}
              />
            }
          />
          <Route path="*" element={<Navigate to={base} replace />} />
        </Routes>
      </div>
    </div>
  )
}

export default GroupWorkspace
