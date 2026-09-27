/** Mirrors the database checks `groups_name_check` / `groups_description_check`. */
export const MAX_GROUP_NAME = 80
export const MAX_GROUP_DESCRIPTION = 300

export type GroupInput = { name: string; description: string | null }

export function validateGroupInput(name: string, description: string): { ok: true; value: GroupInput } | { ok: false; error: string } {
  const cleanName = name.trim()
  const cleanDescription = description.trim()
  if (!cleanName) return { ok: false, error: 'Please enter a group name.' }
  if (cleanName.length > MAX_GROUP_NAME) return { ok: false, error: `Group names must be ${MAX_GROUP_NAME} characters or fewer.` }
  if (cleanDescription.length > MAX_GROUP_DESCRIPTION) {
    return { ok: false, error: `Descriptions must be ${MAX_GROUP_DESCRIPTION} characters or fewer.` }
  }
  return { ok: true, value: { name: cleanName, description: cleanDescription || null } }
}

/** Normalises an email for add-by-email (the server re-validates). */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase()
}
