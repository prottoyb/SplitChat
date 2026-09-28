import { useEffect, useRef, type RefObject } from 'react'
import { Link, Navigate, NavLink, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { useResource } from '../../shared/hooks/useResource'
import { ErrorState, LoadingState, Menu, SECTION_HEADING_ID } from '../../shared/ui'
import { useAuth } from '../../features/auth'
import { balanceTone, loadMyBalance, positionText } from '../../features/balances'
import { GroupMembersSection, loadGroupDetail } from '../../features/groups'
import { GroupBalancesSection } from '../../features/settlements'
import { ActivitySection } from './sections/ActivitySection'
import { ChatSection } from './sections/ChatSection'
import { ExpensesSection } from './sections/ExpensesSection'
import { OverviewSection } from './sections/OverviewSection'
import { SettingsSection } from './sections/SettingsSection'
import styles from './GroupWorkspace.module.css'

// Primary sections are tabs (operator decision D2, Phase 9); the secondary
// pages are reached from the group menu and keep their deep links.
const SECTIONS = [
  { path: '', label: 'Overview' },
  { path: 'expenses', label: 'Expenses' },
  { path: 'balances', label: 'Balances' },
  { path: 'chat', label: 'Chat' },
] as const

const SECONDARY: Record<string, string> = {
  members: 'Members',
  activity: 'Activity',
  settings: 'Group settings',
}

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
    // `ready` is not read: it re-runs the effect once the header (and so the
    // nav) has rendered after the group loads.
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
  const { pathname } = useLocation()
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
  const inChat = pathname.startsWith(`${base}/chat`)
  const secondary = SECONDARY[pathname.slice(base.length + 1).split('/')[0]]

  const groupMenu = (
    <Menu
      label="Group options"
      trigger={<span aria-hidden="true">⋯</span>}
      triggerClassName={styles.menuButton}
      items={[
        { key: 'members', label: <>Members <span className={styles.menuCount}>{memberCount}</span></>, to: `${base}/members` },
        { key: 'activity', label: 'Activity', to: `${base}/activity` },
        { key: 'settings', label: 'Group settings', to: `${base}/settings` },
      ]}
    />
  )

  return (
    // The Chat tab is a full-height surface: on narrow screens the header
    // compacts so the composer stays reachable (UI review, Phase 6).
    <div className={`${styles.workspace}${inChat ? ` ${styles.chatMode}` : ''}`}>
      <header className={styles.header}>
        <nav aria-label="Breadcrumb">
          <ol className={styles.breadcrumb}>
            <li>
              <Link to="/groups">Groups</Link>
            </li>
            {secondary ? (
              <>
                <li>
                  <Link to={base}>{detail.name}</Link>
                </li>
                <li aria-current="page">{secondary}</li>
              </>
            ) : (
              <li aria-current="page">{detail.name}</li>
            )}
          </ol>
        </nav>

        <div className={styles.titleRow}>
          <div className={styles.identity}>
            <div className={styles.titleLine}>
              {inChat && (
                <Link to={base} className={styles.chatBack} aria-label={`Back to ${detail.name} overview`}>
                  ←
                </Link>
              )}
              <h2>{detail.name}</h2>
              <span className={styles.roleBadge}>{detail.myRole === 'owner' ? 'Owner' : 'Member'}</span>
            </div>
            <p className={styles.meta}>
              <Link to={`${base}/members`} className={styles.memberLink}>
                {memberCount} {memberCount === 1 ? 'member' : 'members'}
              </Link>
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
            {groupMenu}
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
          <Route path="chat" element={<ChatSection group={detail} userId={userId} />} />
          <Route path="activity" element={<ActivitySection group={detail} userId={userId} />} />
          <Route path="settings" element={<SettingsSection group={detail} />} />
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
