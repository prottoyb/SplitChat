import type { Session } from '@supabase/supabase-js'
import { isPasswordRecovery, supabase } from '../../../shared/api/supabase'
import { fail, failureFrom, guard, ok, type Result } from '../../../shared/api/result'
import type { Profile } from '../authState'

/**
 * Supabase Auth access for the app (ADR-0008 rule 1). Auth errors are mapped
 * from their stable codes to fixed messages; raw Auth text is not shown, and
 * sign-up never says whether an email is already registered.
 */

const AUTH_MESSAGES: Record<string, string> = {
  invalid_credentials: 'Email or password is incorrect.',
  email_not_confirmed: 'Please confirm your email address before signing in.',
  weak_password: 'Please choose a stronger password (at least 8 characters).',
  over_request_rate_limit: 'Too many attempts. Please wait a moment and try again.',
  over_email_send_rate_limit: 'Too many emails were requested. Please wait a while and try again.',
  signup_disabled: 'New accounts cannot be created right now.',
  same_password: 'Choose a password you have not used for this account before.',
  reauthentication_needed: 'For your security, sign in again and then change your password.',
  session_not_found: 'Your session has ended. Please sign in again.',
}

type AuthErrorLike = { code?: string; status?: number } | null

function authFailure(error: AuthErrorLike, fallback: string) {
  const code = error?.code ?? ''
  if (code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit') {
    return fail('rate_limited', AUTH_MESSAGES[code])
  }
  if (AUTH_MESSAGES[code]) return fail('validation', AUTH_MESSAGES[code])
  return fail('unknown', fallback)
}

export async function getSession(): Promise<Session | null> {
  const { data } = await supabase.auth.getSession()
  return data.session
}

/** Subscribes to session changes; returns the unsubscribe function. */
export function onSessionChange(callback: (session: Session | null) => void): () => void {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => callback(session))
  return () => data.subscription.unsubscribe()
}

export function loadProfile(userId: string): Promise<Result<Profile>> {
  return guard(async () => {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, full_name, avatar_url, created_at, updated_at')
      .eq('id', userId)
      .single()
    if (error) return failureFrom(error, 'Unable to load your profile.')
    return ok(data as Profile)
  }, 'Unable to load your profile.')
}

export function signIn(email: string, password: string): Promise<Result<void>> {
  return guard(async () => {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return error ? authFailure(error, 'Unable to sign in. Please try again.') : ok(undefined)
  }, 'Unable to sign in.')
}

/** `signedIn` is false when the account must first confirm its email. */
export function signUp(email: string, password: string, fullName: string): Promise<Result<{ signedIn: boolean }>> {
  return guard(async () => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: window.location.origin, data: { full_name: fullName } },
    })
    if (error) {
      // An existing address gets the same outcome as a new one (no enumeration).
      if (error.code === 'user_already_exists' || error.code === 'email_exists') return ok({ signedIn: false })
      return authFailure(error, 'Unable to create the account. Please try again.')
    }
    return ok({ signedIn: Boolean(data.session) })
  }, 'Unable to create the account.')
}

export function signOut(): Promise<Result<void>> {
  return guard(async () => {
    const { error } = await supabase.auth.signOut()
    return error ? fail('unknown', 'Unable to sign out. Please try again.') : ok(undefined)
  }, 'Unable to sign out.')
}

export { isPasswordRecovery }

/**
 * Sends a password-reset link. The outcome is the same whether or not the
 * address has an account (no enumeration); only rate limits are reported.
 */
export function requestPasswordReset(email: string): Promise<Result<void>> {
  return guard(async () => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    })
    if (error && (error.code === 'over_request_rate_limit' || error.code === 'over_email_send_rate_limit')) {
      return authFailure(error, 'Unable to send the reset link. Please try again.')
    }
    return ok(undefined)
  }, 'Unable to send the reset link.')
}

/** Sets a new password for the signed-in (or recovering) user. */
export function setNewPassword(password: string): Promise<Result<void>> {
  return guard(async () => {
    const { error } = await supabase.auth.updateUser({ password })
    return error ? authFailure(error, 'Unable to change the password. Please try again.') : ok(undefined)
  }, 'Unable to change the password.')
}

/**
 * Changes the password of the signed-in user after confirming the current
 * one (signing in again also satisfies Auth's "recent sign-in" rule).
 */
export function changePassword(email: string, currentPassword: string, newPassword: string): Promise<Result<void>> {
  return guard(async () => {
    const check = await supabase.auth.signInWithPassword({ email, password: currentPassword })
    if (check.error) {
      return check.error.code === 'invalid_credentials'
        ? fail('validation', 'Your current password is incorrect.')
        : authFailure(check.error, 'Unable to change the password. Please try again.')
    }
    return setNewPassword(newPassword)
  }, 'Unable to change the password.')
}

/** Updates the caller's display name (own row only: RLS and a column grant; M25 rules). */
export function updateDisplayName(userId: string, fullName: string): Promise<Result<void>> {
  return guard(async () => {
    const { error } = await supabase.from('profiles').update({ full_name: fullName }).eq('id', userId)
    if (error) {
      return error.code === '23514'
        ? fail('validation', 'That name cannot be used. Please choose another.')
        : failureFrom(error, 'Unable to save your name. Please try again.')
    }
    return ok(undefined)
  }, 'Unable to save your name.')
}
