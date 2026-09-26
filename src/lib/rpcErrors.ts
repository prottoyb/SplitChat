/**
 * Maps the stable error codes raised by SplitChat's database RPCs
 * (SQLSTATE P0001, message = snake_case code) to user-facing text. Raw
 * database messages are never shown: unknown errors get the caller's
 * generic fallback.
 */
const MESSAGES: Record<string, string> = {
  auth_required: 'Your session has ended. Please sign in again.',
  not_found_or_forbidden:
    'This group is unavailable, or you do not have permission to do that.',
  invalid_email: 'Please enter a valid email address.',
  cannot_remove_owner:
    'The group owner cannot be removed. Transfer ownership first.',
  member_not_found: 'That person is no longer a member of this group.',
  owner_must_transfer:
    'Make another member the owner before leaving this group.',
  invalid_new_owner:
    'Ownership can only be given to another current member of this group.',
}

export type RpcError = { message?: string } | null | undefined

export function rpcErrorCode(error: RpcError): string | null {
  const code = error?.message?.trim()
  return code && /^[a-z_]+$/.test(code) ? code : null
}

export function rpcErrorMessage(error: RpcError, fallback: string): string {
  const code = rpcErrorCode(error)
  return (code && MESSAGES[code]) || fallback
}
