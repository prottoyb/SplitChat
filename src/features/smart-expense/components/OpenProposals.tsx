import { formatCents } from '../../../shared/domain/money'
import type { Candidate } from '../api/candidates'
import { missingFields, proposalElementId } from '../domain/proposalState'
import styles from './CandidateCard.module.css'

const SHOWN = 3

/** Scrolls to a proposal's card and moves focus to it (no smooth scroll under reduced motion). */
function jumpTo(id: string) {
  const card = document.getElementById(proposalElementId(id))
  if (!card) return
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  card.scrollIntoView?.({ block: 'center', behavior: reduce ? 'auto' : 'smooth' })
  card.focus({ preventScroll: true })
}

/**
 * The open proposals the reader can act on among the loaded messages,
 * pinned above the conversation so they do not scroll away (P5, Phase 9).
 * Renders nothing when there are none.
 */
export function OpenProposals({ proposals }: { proposals: readonly Candidate[] }) {
  if (proposals.length === 0) return null
  const label = `${proposals.length} open ${proposals.length === 1 ? 'proposal needs' : 'proposals need'} you`
  return (
    <nav className={styles.openStrip} aria-label={label}>
      <span className={styles.openCount}>{label}</span>
      <ul>
        {proposals.slice(0, SHOWN).map((c) => (
          <li key={c.id}>
            <button type="button" onClick={() => jumpTo(c.id)}>
              {c.description ?? 'Proposal'}
              {c.amountCents !== null && ` ${formatCents(c.amountCents)}`}
              <span className={styles.openState}>{missingFields(c).length === 0 ? 'ready' : 'needs details'}</span>
            </button>
          </li>
        ))}
        {proposals.length > SHOWN && <li className={styles.openMore}>+{proposals.length - SHOWN} more</li>}
      </ul>
    </nav>
  )
}
