import { supabase } from '../../../shared/api/supabase'

export type ChatRealtimeEvent =
  | { type: 'insert'; row: unknown }
  | { type: 'status'; status: 'live' | 'paused' }

/**
 * Live INSERTs of one group's messages (Postgres Changes, ADR-0011). The
 * server evaluates the table's RLS for this user on every change, so a
 * non-member receives nothing. Payloads are untrusted in shape: callers
 * parse them strictly. `groupId` must already be a validated UUID (it is
 * placed in the filter). Returns an unsubscribe function.
 */
export function subscribeGroupMessages(groupId: string, onEvent: (event: ChatRealtimeEvent) => void): () => void {
  const channel = supabase
    .channel(`group-messages:${groupId}:${crypto.randomUUID()}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'group_messages', filter: `group_id=eq.${groupId}` },
      (payload) => onEvent({ type: 'insert', row: payload.new }),
    )
    .subscribe((status) => {
      onEvent({ type: 'status', status: status === 'SUBSCRIBED' ? 'live' : 'paused' })
    })
  return () => {
    void supabase.removeChannel(channel)
  }
}
