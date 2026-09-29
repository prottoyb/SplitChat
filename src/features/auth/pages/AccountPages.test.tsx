import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AuthPage from '../AuthPage'
import ProfilePage from './ProfilePage'
import ResetPasswordPage from './ResetPasswordPage'

// A fake of the recovery state in shared/api/supabase: unlocked only for the
// session a PASSWORD_RECOVERY event named (tests emit it with emitRecovery).
const api = vi.hoisted(() => ({
  recoverySession: null as unknown,
  recoveryListeners: new Set<(session: unknown) => void>(),
  getSession: vi.fn(),
  setNewPassword: vi.fn(),
  signOut: vi.fn(),
  requestPasswordReset: vi.fn(),
  updateDisplayName: vi.fn(),
  changePassword: vi.fn(),
  signIn: vi.fn(),
  signUp: vi.fn(),
}))

vi.mock('../api/auth', () => ({
  isPasswordRecovery: (session: unknown) => session != null && session === api.recoverySession,
  onPasswordRecovery: (listener: (session: unknown) => void) => {
    api.recoveryListeners.add(listener)
    return () => api.recoveryListeners.delete(listener)
  },
  getSession: api.getSession,
  setNewPassword: api.setNewPassword,
  signOut: api.signOut,
  requestPasswordReset: api.requestPasswordReset,
  updateDisplayName: api.updateDisplayName,
  changePassword: api.changePassword,
  signIn: api.signIn,
  signUp: api.signUp,
}))

const refreshProfile = vi.fn()
vi.mock('../useAuth', () => ({
  useAuth: () => ({
    session: { user: { id: 'u1', email: 'priya@example.com' } },
    profile: { id: 'u1', full_name: 'Priya Raman' },
    isLoading: false,
    isProfileLoading: false,
    refreshProfile,
  }),
}))

const ordinarySession = { user: { id: 'u1' }, kind: 'ordinary password sign-in' }
const recoverySession = { user: { id: 'u1' }, kind: 'recovery link' }

/** The PASSWORD_RECOVERY event auth-js emits for a link the Auth server accepted. */
function emitRecovery(session: unknown) {
  act(() => {
    api.recoverySession = session
    for (const listener of api.recoveryListeners) listener(session)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  api.recoverySession = null
  api.recoveryListeners.clear()
  api.getSession.mockResolvedValue(ordinarySession)
  api.signOut.mockResolvedValue({ ok: true, value: undefined })
})
afterEach(() => {
  vi.useRealTimers()
})

const INVALID = 'This reset link is invalid or has expired.'
// Lets the page's getSession() promise settle.
const settle = () => act(async () => {})
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

const at = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/login" element={<AuthPage />} />
        <Route path="/profile" element={<ProfilePage />} />
      </Routes>
    </MemoryRouter>,
  )

describe('Reset password page', () => {
  it('unlocks for a genuine link whose PASSWORD_RECOVERY arrives after the session is known (regression: reset-link race)', async () => {
    vi.useFakeTimers()
    api.getSession.mockResolvedValue(recoverySession)
    at('/reset-password')
    await settle()
    // auth-js has saved the session but not yet emitted the event: neutral, never "invalid".
    expect(screen.getByRole('status')).toHaveTextContent('Checking your reset link…')
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toBeInTheDocument()
    await advance(1500)
    expect(screen.queryByText(INVALID)).not.toBeInTheDocument()
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument()
    emitRecovery(recoverySession)
    expect(screen.getByLabelText('New password')).toBeInTheDocument()
    expect(screen.queryByText(INVALID)).not.toBeInTheDocument()
  })

  it('unlocks when the recovery event arrived before the page loaded', async () => {
    api.recoverySession = recoverySession
    api.getSession.mockResolvedValue(recoverySession)
    at('/reset-password')
    expect(await screen.findByLabelText('New password')).toBeInTheDocument()
  })

  it('refuses a hand-typed #type=recovery on a signed-in session (regression: QA CRITICAL)', async () => {
    vi.useFakeTimers()
    at('/reset-password#type=recovery')
    await settle()
    await advance(2000)
    expect(screen.getByRole('status')).toHaveTextContent(INVALID)
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument()
  })

  it('refuses a direct visit without any session', async () => {
    api.getSession.mockResolvedValue(null)
    at('/reset-password')
    expect(await screen.findByText(INVALID)).toBeInTheDocument()
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument()
  })

  it('refuses an ordinary signed-in session: only a reset link may set a password here', async () => {
    vi.useFakeTimers()
    at('/reset-password')
    await settle()
    await advance(2000)
    expect(screen.getByText(INVALID)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Request a new link from the sign-in page' })).toBeInTheDocument()
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument()
  })

  it('refuses an ordinary session even when an earlier recovery session exists in this page load', async () => {
    vi.useFakeTimers()
    api.recoverySession = recoverySession
    at('/reset-password')
    await settle()
    await advance(2000)
    expect(screen.getByText(INVALID)).toBeInTheDocument()
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument()
  })

  it('does not wait forever when Auth never answers, and still offers no form', async () => {
    vi.useFakeTimers()
    api.getSession.mockReturnValue(new Promise(() => {}))
    at('/reset-password')
    await advance(19000)
    expect(screen.getByRole('status')).toHaveTextContent('Checking your reset link…')
    await advance(1000)
    expect(screen.getByRole('status')).toHaveTextContent(INVALID)
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument()
  })

  it('sets the new password from a reset link, signs out and asks to sign in again', async () => {
    const user = userEvent.setup()
    api.recoverySession = recoverySession
    api.getSession.mockResolvedValue(recoverySession)
    api.setNewPassword.mockResolvedValue({ ok: true, value: undefined })
    at('/reset-password')
    await user.type(await screen.findByLabelText('New password'), 'a new secret')
    await user.type(screen.getByLabelText('Confirm new password'), 'a new secret')
    await user.click(screen.getByRole('button', { name: 'Save new password' }))
    expect(api.setNewPassword).toHaveBeenCalledWith('a new secret')
    expect(api.signOut).toHaveBeenCalled()
    expect(await screen.findByText('Your password has been changed. Sign in with your new password.')).toBeInTheDocument()
  })

  it('checks the new password before calling Auth', async () => {
    const user = userEvent.setup()
    api.recoverySession = recoverySession
    api.getSession.mockResolvedValue(recoverySession)
    at('/reset-password')
    await user.type(await screen.findByLabelText('New password'), 'short')
    await user.type(screen.getByLabelText('Confirm new password'), 'short')
    await user.click(screen.getByRole('button', { name: 'Save new password' }))
    expect(screen.getByRole('alert')).toHaveTextContent('at least 8 characters')
    expect(api.setNewPassword).not.toHaveBeenCalled()
  })
})

describe('Forgot password', () => {
  it('asks for an email and answers the same way whether or not it has an account', async () => {
    const user = userEvent.setup()
    api.requestPasswordReset.mockResolvedValue({ ok: true, value: undefined })
    at('/login')
    await user.click(screen.getByRole('button', { name: 'Forgot password?' }))
    expect(screen.getByRole('heading', { name: 'Reset your password' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('Email address'), '  Priya@Example.com ')
    await user.click(screen.getByRole('button', { name: 'Send reset link' }))
    expect(api.requestPasswordReset).toHaveBeenCalledWith('priya@example.com')
    expect(await screen.findByRole('status')).toHaveTextContent('If an account exists for that email')
  })
})

describe('Profile page', () => {
  it('saves a new display name and refreshes the profile everywhere', async () => {
    const user = userEvent.setup()
    api.updateDisplayName.mockResolvedValue({ ok: true, value: undefined })
    at('/profile')
    const name = screen.getByLabelText('Display name')
    await user.clear(name)
    await user.type(name, '  Priya R  ')
    await user.click(screen.getByRole('button', { name: 'Save name' }))
    expect(api.updateDisplayName).toHaveBeenCalledWith('u1', 'Priya R')
    expect(refreshProfile).toHaveBeenCalled()
    expect(await screen.findByText(/Your name has been updated/)).toBeInTheDocument()
  })

  it('refuses the reserved name before calling the server', async () => {
    const user = userEvent.setup()
    at('/profile')
    const name = screen.getByLabelText('Display name')
    await user.clear(name)
    await user.type(name, 'Deleted user')
    await user.click(screen.getByRole('button', { name: 'Save name' }))
    expect(screen.getByText('That name is reserved. Please choose another.')).toBeInTheDocument()
    expect(name).toHaveAttribute('aria-invalid', 'true')
    expect(api.updateDisplayName).not.toHaveBeenCalled()
  })

  it('changes the password with the current one, and offers no account deletion', async () => {
    const user = userEvent.setup()
    api.changePassword.mockResolvedValue({ ok: true, value: undefined })
    at('/profile')
    expect(screen.getByText('priya@example.com')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Current password'), 'old secret')
    await user.type(screen.getByLabelText('New password'), 'new secret!')
    await user.type(screen.getByLabelText('Confirm new password'), 'new secret!')
    await user.click(screen.getByRole('button', { name: 'Change password' }))
    expect(api.changePassword).toHaveBeenCalledWith('priya@example.com', 'old secret', 'new secret!')
    expect(await screen.findByText('Your password has been changed.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument()
  })
})
