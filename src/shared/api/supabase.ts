import { createClient, type Session } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

if (!supabaseUrl || !supabasePublishableKey) {
  throw new Error('Missing Supabase environment variables')
}

export const supabase = createClient(
  supabaseUrl,
  supabasePublishableKey,
)

// Password recovery state for this page load. It is set only by supabase-js's
// PASSWORD_RECOVERY event, which auth-js emits after the Auth server has
// accepted the tokens carried by the emailed link (auth-js _getSessionFromURL
// → _getUser). Never derived from the URL text: anyone can type
// "#type=recovery" into the address bar of a signed-in browser (QA/Security
// CRITICAL, Phase 9). The listener is registered as the client is created
// because the event fires only during the client's start-up; a listener added
// later would miss it.
//
// The state is bound to the recovery session's id (the access token's
// `session_id` claim, kept across token refreshes) and cleared on sign-out, so
// it cannot carry over to a later ordinary sign-in in the same page load. It
// is not cleared on SIGNED_IN: auth-js re-emits that for the same session when
// the tab becomes visible again.
let recoverySessionId: string | null = null
const recoveryListeners = new Set<(session: Session) => void>()

/**
 * The `session_id` claim of the session's access token, or null if unreadable.
 * Decoded, not verified: it is only a key matching a session to the one the
 * PASSWORD_RECOVERY event named, never an authority in itself.
 */
function sessionIdOf(session: Session | null): string | null {
  const payload = session?.access_token?.split('.')[1]
  if (!payload) return null
  try {
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    const claims: unknown = JSON.parse(json)
    const id = (claims as { session_id?: unknown } | null)?.session_id
    return typeof id === 'string' && id !== '' ? id : null
  } catch {
    return null
  }
}

supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_OUT') {
    recoverySessionId = null
    return
  }
  if (event !== 'PASSWORD_RECOVERY' || !session) return
  recoverySessionId = sessionIdOf(session)
  if (recoverySessionId) for (const listener of recoveryListeners) listener(session)
})

/**
 * True when `session` is the recovery session started by a reset link on this
 * page load (and not signed out since).
 */
export function isPasswordRecovery(session: Session | null): boolean {
  return recoverySessionId !== null && sessionIdOf(session) === recoverySessionId
}

/**
 * Calls `listener` with the session when a PASSWORD_RECOVERY event arrives
 * (auth-js emits it just after start-up finishes, so a page that has already
 * read the session may still be waiting for it). Returns the unsubscribe
 * function.
 */
export function onPasswordRecovery(listener: (session: Session) => void): () => void {
  recoveryListeners.add(listener)
  return () => {
    recoveryListeners.delete(listener)
  }
}
