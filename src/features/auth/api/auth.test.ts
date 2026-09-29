import { beforeEach, describe, expect, it, vi } from 'vitest'
import { changePassword, requestPasswordReset, setNewPassword, updateDisplayName } from './auth'

const auth = vi.hoisted(() => ({
  resetPasswordForEmail: vi.fn(),
  signInWithPassword: vi.fn(),
  updateUser: vi.fn(),
}))
const profiles = vi.hoisted(() => ({ result: { error: null as unknown }, calls: [] as unknown[][] }))

vi.mock('../../../shared/api/supabase', () => ({
  isPasswordRecovery: () => false,
  supabase: {
    auth,
    from: (table: string) => ({
      update: (values: unknown) => ({
        eq: (column: string, value: string) => {
          profiles.calls.push([table, values, column, value])
          return Promise.resolve(profiles.result)
        },
      }),
    }),
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  profiles.calls = []
  profiles.result = { error: null }
})

describe('requestPasswordReset', () => {
  it('sends the link back to /reset-password on this site', async () => {
    auth.resetPasswordForEmail.mockResolvedValue({ error: null })
    await requestPasswordReset('priya@example.com')
    expect(auth.resetPasswordForEmail).toHaveBeenCalledWith('priya@example.com', {
      redirectTo: `${window.location.origin}/reset-password`,
    })
  })

  it('reports the same success whether or not the account exists', async () => {
    auth.resetPasswordForEmail.mockResolvedValue({ error: { code: 'user_not_found', status: 404 } })
    expect(await requestPasswordReset('nobody@example.com')).toEqual({ ok: true, value: undefined })
  })

  it('reports rate limits, which do not reveal accounts', async () => {
    auth.resetPasswordForEmail.mockResolvedValue({ error: { code: 'over_email_send_rate_limit', status: 429 } })
    const result = await requestPasswordReset('priya@example.com')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.code).toBe('rate_limited')
  })
})

describe('changePassword', () => {
  it('confirms the current password before changing it', async () => {
    auth.signInWithPassword.mockResolvedValue({ error: null })
    auth.updateUser.mockResolvedValue({ error: null })
    expect(await changePassword('priya@example.com', 'old secret', 'new secret!')).toEqual({ ok: true, value: undefined })
    expect(auth.signInWithPassword).toHaveBeenCalledWith({ email: 'priya@example.com', password: 'old secret' })
    expect(auth.updateUser).toHaveBeenCalledWith({ password: 'new secret!' })
  })

  it('never changes the password when the current one is wrong', async () => {
    auth.signInWithPassword.mockResolvedValue({ error: { code: 'invalid_credentials', status: 400 } })
    const result = await changePassword('priya@example.com', 'guess', 'new secret!')
    expect(result).toEqual({ ok: false, code: 'validation', message: 'Your current password is incorrect.' })
    expect(auth.updateUser).not.toHaveBeenCalled()
  })

  it('maps Auth refusals to fixed messages, never raw Auth text', async () => {
    auth.updateUser.mockResolvedValue({ error: { code: 'same_password', status: 422, message: 'raw auth text' } })
    const result = await setNewPassword('same one!')
    expect(!result.ok && result.message).toBe('Choose a password you have not used for this account before.')
  })
})

describe('updateDisplayName', () => {
  it('updates only the caller’s own row', async () => {
    expect(await updateDisplayName('u1', 'Priya R')).toEqual({ ok: true, value: undefined })
    expect(profiles.calls).toEqual([['profiles', { full_name: 'Priya R' }, 'id', 'u1']])
  })

  it('explains a name the database refuses (M25)', async () => {
    profiles.result = { error: { code: '23514', message: 'new row violates check constraint' } }
    const result = await updateDisplayName('u1', 'Deleted user')
    expect(result).toEqual({ ok: false, code: 'validation', message: 'That name cannot be used. Please choose another.' })
  })
})
