import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

if (!supabaseUrl || !supabasePublishableKey) {
  throw new Error('Missing Supabase environment variables')
}

// Whether this page load is a genuine password recovery: supabase-js emits
// PASSWORD_RECOVERY only after the Auth server has validated the full token
// set carried by the emailed link (auth-js _getSessionFromURL). Never derived
// from the URL text itself: anyone can type "#type=recovery" into the address
// bar of a signed-in browser (QA/Security CRITICAL, Phase 9). The listener is
// registered as the client is created because the event fires only during
// the client's start-up; a listener added later would miss it.
let passwordRecovery = false

export const supabase = createClient(
  supabaseUrl,
  supabasePublishableKey,
)

supabase.auth.onAuthStateChange((event) => {
  if (event === 'PASSWORD_RECOVERY') passwordRecovery = true
})

/** True when this page load is a password recovery (reset link) session. */
export const isPasswordRecovery = () => passwordRecovery