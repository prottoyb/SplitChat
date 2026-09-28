import { useResource } from '../shared/hooks/useResource'
import { balanceTone, loadMyBalance, positionText } from '../features/balances'
import GroupsPage from '../features/groups/pages/GroupsPage'
import styles from './GroupsRoute.module.css'

/** The caller's server position in one group (P16); a failure degrades only this line. */
function GroupPosition({ groupId, userId }: { groupId: string; userId: string }) {
  const position = useResource(userId ? `position:${groupId}:${userId}` : null, () => loadMyBalance(groupId, userId))
  if (position.status === 'loading') return <p className={`${styles.position} ${styles.muted}`}>Checking balance…</p>
  if (position.status === 'error') return <p className={`${styles.position} ${styles.muted}`}>Balance unavailable</p>
  return <p className={`${styles.position} ${styles[balanceTone(position.data)]}`}>{positionText(position.data)}</p>
}

/** The Groups page with each card's position (groups may not import balances, ADR-0008). */
export default function GroupsRoute() {
  return <GroupsPage Position={GroupPosition} />
}
