import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

if (!supabaseUrl || !supabasePublishableKey) {
  throw new Error('Missing Supabase environment variables')
}

// Whether this page load came from a password-reset email link. Captured
// before the client consumes the link from the URL, and from the
// PASSWORD_RECOVERY event, which fires only during the client's start-up:
// a listener added later (e.g. by a lazily loaded page) would miss both.
let passwordRecovery =
  typeof window !== 'undefined' && /(^|[#&?])type=recovery(&|$)/.test(`${window.location.hash}&${window.location.search}`)

export const supabase = createClient(
  supabaseUrl,
  supabasePublishableKey,
)

supabase.auth.onAuthStateChange((event) => {
  if (event === 'PASSWORD_RECOVERY') passwordRecovery = true
})

/** True when this page load is a password recovery (reset link) session. */
export const isPasswordRecovery = () => passwordRecovery