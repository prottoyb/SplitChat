import { describe, expect, it } from 'vitest'
import { isUuid, parseMessage } from './messages'

const good = {
  id: 7, group_id: 'g', sender_id: 's', body: 'hi',
  client_request_id: 'r', created_at: '2026-09-28T10:00:00.123456+00:00',
}

describe('parseMessage', () => {
  it('reads a PostgREST or Realtime row', () => {
    expect(parseMessage(good)).toEqual({ id: 7, groupId: 'g', senderId: 's', body: 'hi', clientRequestId: 'r', createdAt: good.created_at })
    expect(parseMessage({ ...good, id: '7', created_at: '2026-09-28 10:00:00.123456+00' })?.id).toBe(7)
  })

  it.each([
    ['a missing field', { ...good, body: undefined }],
    ['a fractional id', { ...good, id: 1.5 }],
    ['an unsafe id', { ...good, id: 2 ** 60 }],
    ['a non-numeric id string', { ...good, id: '7; drop' }],
    ['a timestamp that could break a filter', { ...good, created_at: '2026-09-28T10:00:00Z",id.gt.0' }],
    ['not an object', 'hello'],
    ['null', null],
  ])('refuses %s', (_label, row) => {
    expect(parseMessage(row)).toBeNull()
  })
})

describe('isUuid', () => {
  it('accepts only UUIDs, so nothing else reaches a Realtime filter', () => {
    expect(isUuid('10000000-0000-4000-8000-000000000001')).toBe(true)
    expect(isUuid('10000000-0000-4000-8000-000000000001,id=eq.1')).toBe(false)
  })
})
