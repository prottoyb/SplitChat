import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The real client module (not a mock of it), with only createClient replaced
// so the test can drive Auth events.
const auth = vi.hoisted(() => ({ listener: null as null | ((event: string) => void) }))
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: {
      onAuthStateChange: (cb: (event: string) => void) => {
        auth.listener = cb
        return { data: { subscription: { unsubscribe: () => {} } } }
      },
    },
  }),
}))

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
    expect(isPasswordRecovery()).toBe(false)
    auth.listener?.('SIGNED_IN')
    expect(isPasswordRecovery()).toBe(false)
  })

  it('is set only by the PASSWORD_RECOVERY event the client emits for a validated reset link', async () => {
    const { isPasswordRecovery } = await import('./supabase')
    expect(isPasswordRecovery()).toBe(false)
    auth.listener?.('PASSWORD_RECOVERY')
    expect(isPasswordRecovery()).toBe(true)
  })
})
