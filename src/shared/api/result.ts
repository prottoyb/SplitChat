import { rpcErrorCode, rpcErrorMessage } from './rpcErrors'

/**
 * Machine-readable failure categories (ADR-0008 rule 3). The UI branches on
 * the code and shows the message; raw database text never reaches the UI.
 */
export type ErrorCode =
  | 'auth'
  | 'not_found'
  | 'forbidden'
  | 'stale'
  | 'validation'
  | 'conflict'
  | 'rate_limited'
  | 'network'
  | 'unknown'

export type Failure = { ok: false; code: ErrorCode; message: string }
export type Result<T> = { ok: true; value: T } | Failure

export const ok = <T>(value: T): Result<T> => ({ ok: true, value })

export const fail = (code: ErrorCode, message: string): Failure => ({
  ok: false,
  code,
  message,
})

// Category of every stable RPC code the database raises (Phase 1 contract).
const CATEGORY: Record<string, ErrorCode> = {
  auth_required: 'auth',
  not_found_or_forbidden: 'not_found',
  forbidden: 'forbidden',
  stale_expense: 'stale',
  invalid_email: 'validation',
  invalid_description: 'validation',
  invalid_amount: 'validation',
  invalid_date: 'validation',
  invalid_payer: 'validation',
  invalid_participants: 'validation',
  amount_too_small_to_split: 'validation',
  invalid_notes: 'validation',
  invalid_new_owner: 'validation',
  cannot_remove_owner: 'conflict',
  member_not_found: 'conflict',
  owner_must_transfer: 'conflict',
  group_has_other_members: 'conflict',
  group_has_shared_history: 'conflict',
  invalid_parties: 'validation',
  invalid_note: 'validation',
  invalid_reason: 'validation',
  nothing_to_settle: 'conflict',
  exceeds_balance: 'conflict',
  duplicate_request: 'conflict',
  already_voided: 'conflict',
  invalid_body: 'validation',
  invalid_request: 'validation',
  rate_limited: 'rate_limited',
  stale_candidate: 'stale',
  candidate_decided: 'conflict',
  candidate_rejected: 'conflict',
  candidate_incomplete: 'validation',
  invalid_source: 'validation',
}

/** Converts a Supabase/PostgREST error into a Failure with a safe message. */
export function failureFrom(
  error: { message?: string; code?: string } | null | undefined,
  fallback: string,
  overrides?: Readonly<Record<string, string>>,
): Failure {
  const rpcCode = rpcErrorCode(error)
  if (rpcCode && CATEGORY[rpcCode]) {
    return fail(CATEGORY[rpcCode], rpcErrorMessage(error, fallback, overrides))
  }
  // PostgREST: 42501 = insufficient privilege (e.g. signed out).
  if (error?.code === '42501') return fail('auth', rpcErrorMessage({ message: 'auth_required' }, fallback))
  return fail('unknown', fallback)
}

/**
 * Runs an API call, turning a thrown exception (offline, DNS, CORS...) into a
 * `network` failure instead of an unhandled rejection.
 */
export async function guard<T>(
  call: () => Promise<Result<T>>,
  fallback: string,
): Promise<Result<T>> {
  try {
    return await call()
  } catch (error) {
    console.error(fallback, error)
    return fail('network', `${fallback} Please check your connection and try again.`)
  }
}
