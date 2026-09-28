import { MAX_AMOUNT_CENTS } from '../../../shared/domain/money'

export type EqualSplitShare = { userId: string; shareCents: number }

export type EqualSplitError =
  | 'invalid_amount'
  | 'invalid_participants'
  | 'amount_too_small_to_split'

export type EqualSplitResult =
  | { ok: true; shares: EqualSplitShare[] }
  | { ok: false; error: EqualSplitError }

/**
 * The canonical equal split (ADR-0006), identical to the database's
 * private.equal_split_cents and tested against the same vectors
 * (fixtures/equal-split-vectors.json).
 *
 * Participant ids are lower-cased and de-duplicated, then sorted ascending.
 * The default sort compares UTF-16 code units, which for lowercase hex UUIDs
 * is the same order as PostgreSQL's bytewise uuid order. Each share is
 * floor(total / n) cents and the first total % n participants in that order
 * get one extra cent, so the result never depends on selection order.
 * Shares are returned in canonical order with lowercase ids.
 */
export function allocateEqualSplit(
  totalCents: number,
  participantIds: readonly string[],
): EqualSplitResult {
  if (
    !Number.isSafeInteger(totalCents) ||
    totalCents <= 0 ||
    totalCents > MAX_AMOUNT_CENTS
  ) {
    return { ok: false, error: 'invalid_amount' }
  }

  const ids = [
    ...new Set(participantIds.map((id) => id.toLowerCase())),
  ].sort()

  if (ids.length === 0 || ids.some((id) => id === '')) {
    return { ok: false, error: 'invalid_participants' }
  }

  if (totalCents < ids.length) {
    return { ok: false, error: 'amount_too_small_to_split' }
  }

  // Integer arithmetic only: the remainder is exact, and so is dividing the
  // remaining multiple of n.
  const remainder = totalCents % ids.length
  const baseCents = (totalCents - remainder) / ids.length

  return {
    ok: true,
    shares: ids.map((userId, index) => ({
      userId,
      shareCents: baseCents + (index < remainder ? 1 : 0),
    })),
  }
}
