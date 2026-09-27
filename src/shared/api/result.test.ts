import { describe, expect, it, vi } from 'vitest'
import { fail, failureFrom, guard, ok } from './result'

describe('failureFrom', () => {
  it.each([
    ['stale_expense', 'stale', /changed by someone else/],
    ['forbidden', 'forbidden', /added this expense or the group owner/],
    ['not_found_or_forbidden', 'not_found', /unavailable/],
    ['auth_required', 'auth', /sign in again/],
    ['invalid_amount', 'validation', /between \$0\.01/],
    ['owner_must_transfer', 'conflict', /another member the owner/],
    ['group_has_other_members', 'conflict', /other people have been members/],
    ['exceeds_balance', 'conflict', /more than is owed/],
    ['nothing_to_settle', 'conflict', /payer must owe money and the recipient must be owed/],
    ['already_voided', 'conflict', /already been voided/],
    ['invalid_parties', 'validation', /two different people/],
    ['invalid_reason', 'validation', /reason/],
  ])('maps %s to %s with its message', (message, code, text) => {
    const failure = failureFrom({ message }, 'fallback')

    expect(failure.code).toBe(code)
    expect(failure.message).toMatch(text)
  })

  it('lets a call override the wording of a code, keeping its category', () => {
    expect(failureFrom({ message: 'forbidden' }, 'fb', { forbidden: 'Only the two people involved can do that.' }))
      .toEqual(fail('forbidden', 'Only the two people involved can do that.'))
    expect(failureFrom({ message: 'stale_expense' }, 'fb', { forbidden: 'x' }).message).toMatch(/changed by someone else/)
  })

  it('treats a PostgREST privilege error as an auth failure', () => {
    expect(failureFrom({ message: 'permission denied for function x', code: '42501' }, 'fb').code).toBe('auth')
  })

  it('never exposes raw database text', () => {
    expect(failureFrom({ message: 'duplicate key value violates unique constraint "x"' }, 'Try again.'))
      .toEqual({ ok: false, code: 'unknown', message: 'Try again.' })
    expect(failureFrom(null, 'Try again.')).toEqual(fail('unknown', 'Try again.'))
  })
})

describe('guard', () => {
  it('passes results through', async () => {
    await expect(guard(async () => ok(1), 'x')).resolves.toEqual(ok(1))
    await expect(guard(async () => fail('stale', 'm'), 'x')).resolves.toEqual(fail('stale', 'm'))
  })

  it('turns a thrown error into a network failure without leaking it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await guard(async () => {
      throw new TypeError('Failed to fetch secret-internal-host')
    }, 'Unable to load.')

    expect(result).toEqual(fail('network', 'Unable to load. Please check your connection and try again.'))
  })
})
