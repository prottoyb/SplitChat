/** Keyset position: the last row already shown, ordered by (created_at, id). */
export type Cursor = { createdAt: string; id: number }

// A PostgREST timestamptz as returned for created_at (no quotes, commas or
// parentheses can occur in a value that passes this).
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/

/**
 * True only for a cursor this client could have produced from a server row.
 * Checked before any query is built, so a cursor value can never break out
 * of the quoted filter literal it is placed in.
 */
export function isValidCursor(cursor: Cursor): boolean {
  return TIMESTAMP.test(cursor.createdAt) && Number.isSafeInteger(cursor.id) && cursor.id > 0
}

/** The keyset filter for rows strictly before `cursor` (validate first). */
export function beforeFilter(cursor: Cursor): string {
  return `created_at.lt."${cursor.createdAt}",and(created_at.eq."${cursor.createdAt}",id.lt.${cursor.id})`
}
