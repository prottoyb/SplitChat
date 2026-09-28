import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AuthPage from '../AuthPage'
import ProfilePage from './ProfilePage'
import ResetPasswordPage from './ResetPasswordPage'

const api = vi.hoisted(() => ({
  recovery: false,
  session: null as unknown,
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
  isPasswordRecovery: () => api.recovery,
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

beforeEach(() => {
  vi.clearAllMocks()
  api.recovery = false
  api.getSession.mockResolvedValue({ user: { id: 'u1' } })
  api.signOut.mockResolvedValue({ ok: true, value: undefined })
})

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
  it('refuses an ordinary signed-in session: only a reset link may set a password here', async () => {
    at('/reset-password')
    expect(await screen.findByText('This reset link is invalid or has expired.')).toBeInTheDocument()
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument()
  })

  it('refuses a recovery flag without a session', async () => {
    api.recovery = true
    api.getSession.mockResolvedValue(null)
    at('/reset-password')
    expect(await screen.findByText('This reset link is invalid or has expired.')).toBeInTheDocument()
  })

  it('sets the new password from a reset link, signs out and asks to sign in again', async () => {
    const user = userEvent.setup()
    api.recovery = true
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
    api.recovery = true
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
