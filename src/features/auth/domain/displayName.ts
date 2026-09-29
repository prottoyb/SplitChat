/** Mirrors the database rule profiles_full_name_check (M25, ADR-0013). */
export const MAX_DISPLAY_NAME = 80

export function validateDisplayName(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const name = raw.trim()
  if (!name) return { ok: false, error: 'Please enter your name.' }
  if (name.length > MAX_DISPLAY_NAME) return { ok: false, error: `Names must be ${MAX_DISPLAY_NAME} characters or fewer.` }
  if (name.replace(/\s+/g, ' ').toLowerCase() === 'deleted user') {
    return { ok: false, error: 'That name is reserved. Please choose another.' }
  }
  return { ok: true, value: name }
}

export const MIN_PASSWORD = 8

/** The same rule as sign-up (Supabase Auth enforces its own minimum too). */
export function validateNewPassword(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD) return `Your password must be at least ${MIN_PASSWORD} characters.`
  if (password !== confirm) return 'Your passwords do not match.'
  return null
}
