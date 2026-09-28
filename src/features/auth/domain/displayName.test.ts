import { describe, expect, it } from 'vitest'
import { validateDisplayName, validateNewPassword } from './displayName'

describe('validateDisplayName (mirrors M25)', () => {
  it.each([
    ['  Priya Raman  ', { ok: true, value: 'Priya Raman' }],
    ['x'.repeat(80), { ok: true, value: 'x'.repeat(80) }],
    ['Deleted users', { ok: true, value: 'Deleted users' }],
  ])('accepts %j', (raw, expected) => {
    expect(validateDisplayName(raw)).toEqual(expected)
  })

  it.each([
    ['   ', 'Please enter your name.'],
    ['x'.repeat(81), 'Names must be 80 characters or fewer.'],
    ['Deleted user', 'That name is reserved. Please choose another.'],
    ['  DELETED   User ', 'That name is reserved. Please choose another.'],
  ])('refuses %j', (raw, error) => {
    expect(validateDisplayName(raw)).toEqual({ ok: false, error })
  })
})

describe('validateNewPassword', () => {
  it('needs 8 characters and a matching confirmation', () => {
    expect(validateNewPassword('short', 'short')).toMatch(/at least 8/)
    expect(validateNewPassword('long enough', 'different')).toMatch(/do not match/)
    expect(validateNewPassword('long enough', 'long enough')).toBeNull()
  })
})
