import type { Result } from '../../../shared/api/result'
import type { GroupSummary } from '../../groups'
import { missingFields, type Candidate } from '../../smart-expense'

export type NeedsYouItem =
  | {
      key: string
      kind: 'proposal'
      groupName: string
      to: string
      description: string | null
      amountCents: number | null
      /** Draft fields still missing; empty when it is ready to review. */
      missing: string[]
    }
  | { key: string; kind: 'you_owe'; groupName: string; to: string; amountCents: number }

/**
 * What the user can act on now: open proposals they may complete or approve
 * (the query already limits them to their own and those in groups they own),
 * then the groups where they owe money. Links go to the place where the
 * action happens; nothing is approved or recorded from the dashboard.
 */
export function needsYouItems(
  proposals: readonly Candidate[],
  groups: readonly GroupSummary[],
  positions: ReadonlyMap<string, Result<number>> | null,
): NeedsYouItem[] {
  const name = (id: string) => groups.find((g) => g.id === id)?.name ?? 'a group'
  const items: NeedsYouItem[] = proposals
    .filter((c) => groups.some((g) => g.id === c.groupId))
    .map((c) => ({
      key: `proposal-${c.id}`,
      kind: 'proposal',
      groupName: name(c.groupId),
      to: `/groups/${c.groupId}/chat`,
      description: c.description,
      amountCents: c.amountCents,
      missing: missingFields(c),
    }))
  for (const g of groups) {
    const p = positions?.get(g.id)
    if (p?.ok && p.value < 0) {
      items.push({ key: `owe-${g.id}`, kind: 'you_owe', groupName: g.name, to: `/groups/${g.id}/balances`, amountCents: -p.value })
    }
  }
  return items
}

export type Overall = {
  /** Sum of the caller's position in every group whose position loaded. */
  netCents: number
  /** Groups where the caller owes or is owed something. */
  openGroups: number
  unavailable: number
}

/**
 * The caller's positions added up across groups, for display only: money is
 * still settled inside each group, never across groups.
 */
export function overallPosition(positions: ReadonlyMap<string, Result<number>>): Overall {
  let netCents = 0
  let openGroups = 0
  let unavailable = 0
  for (const p of positions.values()) {
    if (!p.ok) {
      unavailable++
      continue
    }
    netCents += p.value
    if (p.value !== 0) openGroups++
  }
  return { netCents, openGroups, unavailable }
}
