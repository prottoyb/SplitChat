import { describe, expect, it } from 'vitest'
import { rpcErrorCode, rpcErrorMessage } from './rpcErrors'

describe('rpcErrorMessage', () => {
  it.each([
    ['not_found_or_forbidden', /unavailable, or you do not have permission/],
    ['owner_must_transfer', /another member the owner/],
    ['cannot_remove_owner', /cannot be removed/],
    ['invalid_new_owner', /another current member/],
    ['member_not_found', /no longer a member/],
    ['invalid_email', /valid email/],
    ['auth_required', /sign in again/],
  ])('maps %s to user-facing text', (code, text) => {
    expect(rpcErrorMessage({ message: code }, 'fallback')).toMatch(text)
  })

  it('never shows an unknown code or a raw database message', () => {
    expect(rpcErrorMessage({ message: 'some_new_code' }, 'Try again.')).toBe('Try again.')
    expect(
      rpcErrorMessage({ message: 'duplicate key value violates unique constraint "x"' }, 'Try again.'),
    ).toBe('Try again.')
    expect(rpcErrorMessage(null, 'Try again.')).toBe('Try again.')
  })

  it('extracts only snake_case codes', () => {
    expect(rpcErrorCode({ message: ' not_found_or_forbidden ' })).toBe('not_found_or_forbidden')
    expect(rpcErrorCode({ message: 'Permission denied' })).toBeNull()
    expect(rpcErrorCode(undefined)).toBeNull()
  })
})
