import { supabase } from '../../../shared/api/supabase'
import { beforeFilter, isValidCursor, type Cursor } from '../../../shared/api/cursor'
import { fail, failureFrom, guard, ok, type Result } from '../../../shared/api/result'
import { resolveDisplayNames, type NameMap } from '../../people'
import type { ChatMessage } from '../domain/timeline'

export const PAGE_SIZE = 30
const MAX_PAGE_SIZE = 50
const COLUMNS = 'id, group_id, sender_id, body, client_request_id, created_at'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** True for a well-formed UUID (checked before a group id reaches a query or a Realtime filter). */
export const isUuid = (value: string) => UUID.test(value)

/**
 * Reads one message row strictly (from PostgREST or a Realtime payload,
 * both untrusted in shape); null for anything malformed.
 */
export function parseMessage(row: unknown): ChatMessage | null {
  if (!row || typeof row !== 'object') return null
  const r = row as Record<string, unknown>
  const id = typeof r.id === 'string' && /^\d+$/.test(r.id) ? Number(r.id) : r.id
  if (
    typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 ||
    typeof r.group_id !== 'string' || typeof r.sender_id !== 'string' ||
    typeof r.body !== 'string' || typeof r.client_request_id !== 'string' ||
    typeof r.created_at !== 'string' || !isValidCursor({ createdAt: r.created_at, id })
  ) {
    return null
  }
  return {
    id,
    groupId: r.group_id,
    senderId: r.sender_id,
    body: r.body,
    clientRequestId: r.client_request_id,
    createdAt: r.created_at,
  }
}

export type MessagePage = {
  /** Oldest first. */
  messages: ChatMessage[]
  /** More messages exist before the first one. */
  hasOlder: boolean
  names: NameMap
}

/**
 * The newest messages of a group (RLS: active members only), or the page
 * before `before`, keyset-paginated on (created_at, id) (ADR-0011).
 */
export function listMessages(
  groupId: string,
  { before, limit = PAGE_SIZE }: { before?: Cursor | null; limit?: number } = {},
): Promise<Result<MessagePage>> {
  return guard(async () => {
    if (!isUuid(groupId)) return fail('not_found', 'This group does not exist or you do not have access to it.')
    if (before && !isValidCursor(before)) return fail('validation', 'Unable to load earlier messages.')
    const size = Math.max(1, Math.min(limit, MAX_PAGE_SIZE))
    let query = supabase.from('group_messages').select(COLUMNS).eq('group_id', groupId)
    if (before) query = query.or(beforeFilter(before))
    const result = await query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(size + 1)
    if (result.error) return failureFrom(result.error, 'Unable to load messages.')

    const rows = (Array.isArray(result.data) ? result.data : []).slice(0, size + 1)
    const messages: ChatMessage[] = []
    for (const row of rows.slice(0, size)) {
      const message = parseMessage(row)
      if (!message || message.groupId !== groupId) return fail('unknown', 'Unable to load messages.')
      messages.push(message)
    }
    const names = await namesFor(groupId, messages)
    if (!names.ok) return names
    return ok({ messages: messages.reverse(), hasOlder: rows.length > size, names: names.value })
  }, 'Unable to load messages.')
}

/** Display names for the senders of `messages` (former and deleted ones included). */
export function namesFor(groupId: string, messages: readonly ChatMessage[]): Promise<Result<NameMap>> {
  return resolveDisplayNames([{ groupId, userIds: messages.map((m) => m.senderId) }])
}

/**
 * Sends a message through the only write path (send_group_message). A retry
 * with the same request id returns the message already sent.
 */
export function sendMessage(groupId: string, body: string, clientRequestId: string): Promise<Result<ChatMessage>> {
  return guard(async () => {
    const { data, error } = await supabase.rpc('send_group_message', {
      p_group_id: groupId,
      p_body: body,
      p_client_request_id: clientRequestId,
    })
    if (error) {
      return failureFrom(error, 'The message could not be sent. Please try again.', {
        not_found_or_forbidden: 'You are no longer a member of this group, so you cannot send messages here.',
        duplicate_request: 'That message was already sent with different text. Please write it again.',
      })
    }
    const message = parseMessage(data)
    if (!message) return fail('unknown', 'The message could not be sent. Please try again.')
    return ok(message)
  }, 'The message could not be sent. Please check your connection and try again.')
}
