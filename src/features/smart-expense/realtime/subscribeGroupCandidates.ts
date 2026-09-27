import { supabase } from '../../../shared/api/supabase'

export type CandidateRealtimeEvent = { type: 'row'; row: unknown } | { type: 'status'; status: 'live' | 'paused' }

/**
 * Live proposals and decisions for one group (Postgres Changes on
 * expense_candidates, INSERT and UPDATE; RLS evaluated per subscriber).
 * Payloads are untrusted in shape. `groupId` must be a validated UUID.
 */
export function subscribeGroupCandidates(groupId: string, onEvent: (event: CandidateRealtimeEvent) => void): () => void {
  const filter = `group_id=eq.${groupId}`
  const channel = supabase
    .channel(`expense-candidates:${groupId}:${crypto.randomUUID()}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'expense_candidates', filter }, (p) =>
      onEvent({ type: 'row', row: p.new }),
    )
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'expense_candidates', filter }, (p) =>
      onEvent({ type: 'row', row: p.new }),
    )
    .subscribe((status) => onEvent({ type: 'status', status: status === 'SUBSCRIBED' ? 'live' : 'paused' }))
  return () => {
    void supabase.removeChannel(channel)
  }
}
