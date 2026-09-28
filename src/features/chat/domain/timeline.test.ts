import { describe, expect, it } from 'vitest'
import { emptyTimeline, timeKey, timelineReducer, validateBody, type ChatMessage, type Timeline } from './timeline'

const ME = 'u1'
const reduce = timelineReducer(ME)

const msg = (id: number, createdAt: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  groupId: 'g1',
  senderId: 'u2',
  body: `message ${id}`,
  clientRequestId: `r${id}`,
  createdAt,
  ...extra,
})

const ids = (t: Timeline) => t.messages.map((m) => m.id)

describe('timeKey', () => {
  it('orders PostgREST and Realtime timestamp formats of the same instant equally, to the microsecond', () => {
    expect(timeKey('2026-09-28T10:00:00.123456+00:00')).toBe(timeKey('2026-09-28 10:00:00.123456+00'))
    expect(timeKey('2026-09-28T20:00:00.5+10:00')).toBe(timeKey('2026-09-28T10:00:00.500000Z'))
    expect(timeKey('2026-09-28T10:00:00.000002Z') - timeKey('2026-09-28T10:00:00.000001Z')).toBe(1)
  })

  it('refuses anything that is not a timestamp', () => {
    expect(timeKey('yesterday')).toBeNaN()
  })
})

describe('timelineReducer', () => {
  it('orders by time, then id, whatever the arrival order', () => {
    let t = reduce(emptyTimeline, { type: 'loaded', messages: [msg(3, '2026-09-28T10:00:01Z'), msg(1, '2026-09-28T10:00:00Z')], hasOlder: false })
    t = reduce(t, { type: 'received', message: msg(2, '2026-09-28T10:00:00Z') })
    expect(ids(t)).toEqual([1, 2, 3])
  })

  it('shows a message once when the send result and the realtime event both arrive', () => {
    let t = reduce(emptyTimeline, { type: 'loaded', messages: [], hasOlder: false })
    t = reduce(t, { type: 'sendStarted', clientRequestId: 'rq', body: 'hi' })
    expect(t.pending).toHaveLength(1)
    const mine = msg(10, '2026-09-28T10:00:00Z', { senderId: ME, clientRequestId: 'rq', body: 'hi' })
    t = reduce(t, { type: 'received', message: mine })
    t = reduce(t, { type: 'sendConfirmed', message: mine })
    expect(ids(t)).toEqual([10])
    expect(t.pending).toEqual([])
  })

  it('does not confirm my pending send with someone else’s message that reuses the request id', () => {
    let t = reduce(emptyTimeline, { type: 'sendStarted', clientRequestId: 'rq', body: 'hi' })
    t = reduce(t, { type: 'received', message: msg(11, '2026-09-28T10:00:00Z', { clientRequestId: 'rq' }) })
    expect(t.pending).toHaveLength(1)
  })

  it('marks a failed send for retry, then sends it again with the same request id', () => {
    let t = reduce(emptyTimeline, { type: 'sendStarted', clientRequestId: 'rq', body: 'hi' })
    t = reduce(t, { type: 'sendFailed', clientRequestId: 'rq', error: 'offline' })
    expect(t.pending[0]).toMatchObject({ status: 'failed', error: 'offline' })
    t = reduce(t, { type: 'retry', clientRequestId: 'rq' })
    expect(t.pending[0]).toEqual({ clientRequestId: 'rq', body: 'hi', status: 'sending' })
    t = reduce(t, { type: 'discard', clientRequestId: 'rq' })
    expect(t.pending).toEqual([])
  })

  it('ignores a repeated sendStarted for the same request', () => {
    let t = reduce(emptyTimeline, { type: 'sendStarted', clientRequestId: 'rq', body: 'hi' })
    t = reduce(t, { type: 'sendStarted', clientRequestId: 'rq', body: 'hi' })
    expect(t.pending).toHaveLength(1)
  })

  it('prepends older pages without duplicates', () => {
    let t = reduce(emptyTimeline, { type: 'loaded', messages: [msg(5, '2026-09-28T10:00:05Z'), msg(6, '2026-09-28T10:00:06Z')], hasOlder: true })
    t = reduce(t, { type: 'olderLoaded', messages: [msg(4, '2026-09-28T10:00:04Z'), msg(5, '2026-09-28T10:00:05Z')], hasOlder: false })
    expect(ids(t)).toEqual([4, 5, 6])
    expect(t.hasOlder).toBe(false)
  })

  it('merges a reconnect page that overlaps what is loaded', () => {
    let t = reduce(emptyTimeline, { type: 'loaded', messages: [msg(1, '2026-09-28T10:00:01Z'), msg(2, '2026-09-28T10:00:02Z')], hasOlder: true })
    t = reduce(t, { type: 'gapFilled', messages: [msg(2, '2026-09-28T10:00:02Z'), msg(3, '2026-09-28T10:00:03Z')], hasOlder: true })
    expect(ids(t)).toEqual([1, 2, 3])
    expect(t.hasOlder).toBe(true)
    expect(t.epoch).toBe(0)
  })

  it('replaces the list after a long disconnect whose page does not overlap', () => {
    let t = reduce(emptyTimeline, { type: 'loaded', messages: [msg(1, '2026-09-28T10:00:01Z')], hasOlder: false })
    t = reduce(t, { type: 'gapFilled', messages: [msg(90, '2026-09-28T11:00:00Z'), msg(91, '2026-09-28T11:00:01Z')], hasOlder: true })
    expect(ids(t)).toEqual([90, 91])
    expect(t.hasOlder).toBe(true)
    expect(t.epoch).toBe(1) // the view resets to the latest messages
  })

  it('tracks the live status', () => {
    expect(reduce(emptyTimeline, { type: 'status', live: 'paused' }).live).toBe('paused')
  })
})

describe('validateBody', () => {
  it('trims and accepts a normal message', () => {
    expect(validateBody('  Dinner 84.50 with Sam \n')).toEqual({ ok: true, body: 'Dinner 84.50 with Sam' })
  })

  it.each([
    ['', 'Write a message first.'],
    [' \n\t ', 'Write a message first.'],
    ['x'.repeat(2001), 'Messages can be up to 2,000 characters.'],
    ['bell\u0007', 'The message contains characters that cannot be sent.'],
  ])('refuses %j', (raw, error) => {
    expect(validateBody(raw)).toEqual({ ok: false, error })
  })

  it('counts characters as the server does (an emoji is one)', () => {
    expect(validateBody('😀'.repeat(2000)).ok).toBe(true)
    expect(validateBody('x'.repeat(2000)).ok).toBe(true)
  })

  it('keeps inner newlines and tabs', () => {
    expect(validateBody('a\n\tb')).toEqual({ ok: true, body: 'a\n\tb' })
  })
})
