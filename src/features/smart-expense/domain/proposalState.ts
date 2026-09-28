import type { Candidate } from '../api/candidates'

/** The draft fields a proposal still needs before it can be approved, in reading order. */
export function missingFields(c: Pick<Candidate, 'amountCents' | 'description' | 'expenseDate' | 'paidBy' | 'participantIds'>): string[] {
  return [
    c.amountCents === null && 'amount',
    c.description === null && 'what it was for',
    c.expenseDate === null && 'date',
    c.paidBy === null && 'who paid',
    c.participantIds === null && 'who shares it',
  ].filter(Boolean) as string[]
}

/**
 * Who may complete, approve or reject an open proposal: its proposer or the
 * group owner (the server enforces the same rule, ADR-0012).
 */
export function canActOnProposal(c: Pick<Candidate, 'status' | 'proposedBy'>, userId: string, isOwner: boolean): boolean {
  return c.status === 'proposed' && (c.proposedBy === userId || isOwner)
}

/** The DOM id of a proposal's card in the chat, so other views can jump to it. */
export const proposalElementId = (candidateId: string) => `proposal-${candidateId}`
