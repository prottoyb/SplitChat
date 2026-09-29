import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@supabase/supabase-js'

// The real client module (not a mock of it), with only createClient replaced
// so the test can drive Auth events.
type Listener = (event: string, session: Session | null) => void
const auth = vi.hoisted(() => ({ listener: null as null | ((event: string, session: unknown) => void) }))
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: {
      onAuthStateChange: (cb: Listener) => {
        auth.listener = cb as (event: string, session: unknown) => void
        return { data: { subscription: { unsubscribe: () => {} } } }
      },
    },
  }),
}))

const base64url = (value: object) => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** A session whose access token carries `session_id` (as Supabase Auth issues it). */
function sessionFor(sessionId: string | null, tokenNo = 1): Session {
  const claims = { sub: 'u1', aal: 'aal1', n: tokenNo, ...(sessionId ? { session_id: sessionId } : {}) }
  return { access_token: `${base64url({ alg: 'HS256' })}.${base64url(claims)}.sig`, user: { id: 'u1' } } as unknown as Session
}

const emit = (event: string, session: Session | null) => auth.listener?.(event, session)

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
  vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'public-key')
})
afterEach(() => {
  vi.unstubAllEnvs()
  window.location.hash = ''
})

describe('isPasswordRecovery', () => {
  it('is not unlocked by a hand-typed #type=recovery on an ordinary session (regression: QA CRITICAL)', async () => {
    window.location.hash = '#type=recovery'
    const { isPasswordRecovery } = await import('./supabase')
    const ordinary = sessionFor('s-ordinary')
    expect(isPasswordRecovery(ordinary)).toBe(false)
    emit('SIGNED_IN', ordinary)
    expect(isPasswordRecovery(ordinary)).toBe(false)
  })

  it('is set only by the PASSWORD_RECOVERY event, for that recovery session', async () => {
    const { isPasswordRecovery } = await import('./supabase')
    const recovery = sessionFor('s-recovery')
    expect(isPasswordRecovery(recovery)).toBe(false)
    emit('PASSWORD_RECOVERY', recovery)
    expect(isPasswordRecovery(recovery)).toBe(true)
    // A refreshed token of the same session still counts; any other session or none does not.
    expect(isPasswordRecovery(sessionFor('s-recovery', 2))).toBe(true)
    expect(isPasswordRecovery(sessionFor('s-other'))).toBe(false)
    expect(isPasswordRecovery(null)).toBe(false)
  })

  it('survives the SIGNED_IN auth-js re-emits for the same session when the tab becomes visible', async () => {
    const { isPasswordRecovery } = await import('./supabase')
    const recovery = sessionFor('s-recovery')
    emit('PASSWORD_RECOVERY', recovery)
    emit('SIGNED_IN', recovery)
    emit('TOKEN_REFRESHED', sessionFor('s-recovery', 2))
    expect(isPasswordRecovery(sessionFor('s-recovery', 2))).toBe(true)
  })

  it('does not carry over to a later sign-in in the same page load (regression: stale recovery state)', async () => {
    const { isPasswordRecovery } = await import('./supabase')
    const recovery = sessionFor('s-recovery')
    emit('PASSWORD_RECOVERY', recovery)
    // The reset page signs out after the change; the user then signs in with a password.
    emit('SIGNED_OUT', null)
    const later = sessionFor('s-password-sign-in')
    emit('SIGNED_IN', later)
    expect(isPasswordRecovery(later)).toBe(false)
    expect(isPasswordRecovery(recovery)).toBe(false)
  })

  it('never unlocks for a session whose token has no readable session id (fails safe)', async () => {
    const { isPasswordRecovery } = await import('./supabase')
    for (const broken of [sessionFor(null), { access_token: 'not-a-jwt' } as unknown as Session, { access_token: 'a.%%%.c' } as unknown as Session]) {
      emit('PASSWORD_RECOVERY', broken)
      expect(isPasswordRecovery(broken)).toBe(false)
      expect(isPasswordRecovery(sessionFor(null))).toBe(false)
    }
  })
})

describe('onPasswordRecovery', () => {
  it('tells a waiting page when the recovery event arrives, until it unsubscribes', async () => {
    const { onPasswordRecovery } = await import('./supabase')
    const listener = vi.fn()
    const unsubscribe = onPasswordRecovery(listener)
    emit('SIGNED_IN', sessionFor('s-ordinary'))
    expect(listener).not.toHaveBeenCalled()
    const recovery = sessionFor('s-recovery')
    emit('PASSWORD_RECOVERY', recovery)
    expect(listener).toHaveBeenCalledWith(recovery)
    unsubscribe()
    emit('PASSWORD_RECOVERY', sessionFor('s-recovery-2'))
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
