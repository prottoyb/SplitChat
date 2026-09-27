/** A message as stored by the server (ADR-0011). */
export type ChatMessage = {
  id: number
  groupId: string
  senderId: string
  body: string
  clientRequestId: string
  /** Exactly as the server returned it (a keyset cursor may be built from it). */
  createdAt: string
}

/** A message being sent, not yet confirmed by the server. */
export type PendingMessage = {
  clientRequestId: string
  body: string
  status: 'sending' | 'failed'
  error?: string
}

export type LiveStatus = 'connecting' | 'live' | 'paused'

export type Timeline = {
  /** Confirmed messages, oldest first, by (createdAt, id). */
  messages: ChatMessage[]
  /** Unconfirmed sends, in the order they were made. */
  pending: PendingMessage[]
  /** More (older) messages exist on the server before the first one loaded. */
  hasOlder: boolean
  live: LiveStatus
  /**
   * Counts wholesale replacements of the list (a reconnect whose newest
   * page does not overlap what was shown), so the view can reset its
   * position instead of reflowing under the reader.
   */
  epoch: number
}

export const emptyTimeline: Timeline = { messages: [], pending: [], hasOlder: false, live: 'connecting', epoch: 0 }

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):?(\d{2})?)$/

/**
 * Microseconds since the epoch for a server timestamp, so that timestamps in
 * different formats (PostgREST vs Realtime payloads) order exactly. NaN for
 * anything unparseable.
 */
export function timeKey(ts: string): number {
  const m = TIMESTAMP.exec(ts)
  if (!m) return Number.NaN
  const [, y, mo, d, h, mi, s, frac = '', zone, sign, oh = '0', om = '0'] = m
  const seconds = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) / 1000
  const offset = zone === 'Z' ? 0 : (sign === '-' ? -1 : 1) * (+oh * 3600 + +om * 60)
  return (seconds - offset) * 1_000_000 + Number(frac.padEnd(6, '0'))
}

export function compareMessages(a: ChatMessage, b: ChatMessage): number {
  return timeKey(a.createdAt) - timeKey(b.createdAt) || a.id - b.id
}

/** Adds messages, de-duplicated by id (an already-known id keeps its first copy). */
function merge(current: readonly ChatMessage[], incoming: readonly ChatMessage[]): ChatMessage[] {
  const byId = new Map(current.map((m) => [m.id, m]))
  for (const m of incoming) if (!byId.has(m.id)) byId.set(m.id, m)
  return [...byId.values()].sort(compareMessages)
}

/** Drops pending sends that a confirmed message of mine now covers. */
function settle(pending: readonly PendingMessage[], messages: readonly ChatMessage[], me: string): PendingMessage[] {
  const confirmed = new Set(messages.filter((m) => m.senderId === me).map((m) => m.clientRequestId))
  return pending.filter((p) => !confirmed.has(p.clientRequestId))
}

export type TimelineAction =
  /** The newest page (oldest first). `hasOlder`: more exist before it. */
  | { type: 'loaded'; messages: ChatMessage[]; hasOlder: boolean }
  /** An older page, prepended. */
  | { type: 'olderLoaded'; messages: ChatMessage[]; hasOlder: boolean }
  /** The newest page after a reconnect; replaces the list when it does not overlap. */
  | { type: 'gapFilled'; messages: ChatMessage[]; hasOlder: boolean }
  | { type: 'received'; message: ChatMessage }
  | { type: 'sendStarted'; clientRequestId: string; body: string }
  | { type: 'sendConfirmed'; message: ChatMessage }
  | { type: 'sendFailed'; clientRequestId: string; error: string }
  | { type: 'retry'; clientRequestId: string }
  | { type: 'discard'; clientRequestId: string }
  | { type: 'status'; live: LiveStatus }

/**
 * The chat timeline (ADR-0011): confirmed messages ordered by
 * (createdAt, id) and de-duplicated by id, whichever of the send result or
 * the realtime event arrives first; pending sends until confirmed.
 */
export function timelineReducer(me: string) {
  return (state: Timeline, action: TimelineAction): Timeline => {
    switch (action.type) {
      case 'loaded': {
        const messages = merge([], action.messages)
        return { ...state, messages, hasOlder: action.hasOlder, pending: settle(state.pending, messages, me) }
      }
      case 'olderLoaded':
        return { ...state, messages: merge(state.messages, action.messages), hasOlder: action.hasOlder }
      case 'gapFilled': {
        const known = new Set(state.messages.map((m) => m.id))
        // Merging is safe when the page shares a message with what is shown,
        // or when nothing older exists: then the page is the whole history,
        // a superset of anything shown.
        const overlaps = state.messages.length === 0 || action.messages.some((m) => known.has(m.id)) || !action.hasOlder
        const messages = overlaps ? merge(state.messages, action.messages) : merge([], action.messages)
        return {
          ...state,
          messages,
          // Overlapping: older history is as before (or as the page says, if
          // nothing was loaded). Replaced: the page decides.
          hasOlder: overlaps && state.messages.length > 0 ? state.hasOlder : action.hasOlder,
          pending: settle(state.pending, messages, me),
          epoch: overlaps ? state.epoch : state.epoch + 1,
        }
      }
      case 'received':
      case 'sendConfirmed': {
        const messages = merge(state.messages, [action.message])
        return { ...state, messages, pending: settle(state.pending, messages, me) }
      }
      case 'sendStarted':
        return state.pending.some((p) => p.clientRequestId === action.clientRequestId)
          ? state
          : { ...state, pending: [...state.pending, { clientRequestId: action.clientRequestId, body: action.body, status: 'sending' }] }
      case 'sendFailed':
        return {
          ...state,
          pending: state.pending.map((p) =>
            p.clientRequestId === action.clientRequestId ? { ...p, status: 'failed', error: action.error } : p,
          ),
        }
      case 'retry':
        return {
          ...state,
          pending: state.pending.map((p) =>
            p.clientRequestId === action.clientRequestId ? { clientRequestId: p.clientRequestId, body: p.body, status: 'sending' } : p,
          ),
        }
      case 'discard':
        return { ...state, pending: state.pending.filter((p) => p.clientRequestId !== action.clientRequestId) }
      case 'status':
        return state.live === action.live ? state : { ...state, live: action.live }
    }
  }
}

/** The body rule shared with the server (trimmed, 1–2000 characters, no control characters). */
export const bodyLength = (raw: string) => [...raw].length
export const MAX_BODY = 2000
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x01-\x08\x0B-\x1F\x7F]/

export function validateBody(raw: string): { ok: true; body: string } | { ok: false; error: string } {
  const body = raw.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, '')
  // Code points, as the server's char_length counts (an emoji is one).
  const length = [...body].length
  if (length === 0) return { ok: false, error: 'Write a message first.' }
  if (length > MAX_BODY) return { ok: false, error: `Messages can be up to ${MAX_BODY.toLocaleString('en-AU')} characters.` }
  if (CONTROL.test(body)) return { ok: false, error: 'The message contains characters that cannot be sent.' }
  return { ok: true, body }
}
