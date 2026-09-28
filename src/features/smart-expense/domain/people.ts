import type { DraftField, InterpretContext, Issue } from './types'
import { bare, normalize } from './text'

// People (M1–M6): active members only; exact full name or a unique first
// name; no prefixes, nicknames or fuzzy matching.

type Resolution = { ok: true; id: string } | { ok: false; issue: Omit<Issue, 'field'> } | { ok: true; all: true }

export function resolvePerson(raw: string, ctx: InterpretContext): Resolution {
  const token = raw.trim()
  const key = bare(token).replace(/\s+/g, ' ')
  if (key === 'me' || key === 'i' || key === 'myself') return { ok: true, id: ctx.senderId }
  if (key === 'us' || key === 'we' || key === 'you') return { ok: false, issue: { code: 'ambiguous', token } }
  if (!key) return { ok: false, issue: { code: 'unknown_name', token } }
  const lower = ctx.members.map((m) => ({ id: m.id, full: normalize(m.name).toLowerCase() }))
  const exact = lower.filter((m) => m.full === key)
  if (exact.length === 1) return { ok: true, id: exact[0].id }
  if (exact.length > 1) return { ok: false, issue: { code: 'ambiguous', token, matches: exact.map((m) => m.id) } }
  if (!key.includes(' ')) {
    const first = lower.filter((m) => m.full.split(' ')[0] === key)
    if (first.length === 1) return { ok: true, id: first[0].id }
    if (first.length > 1) return { ok: false, issue: { code: 'ambiguous', token, matches: first.map((m) => m.id) } }
  }
  return { ok: false, issue: { code: 'unknown_name', token } }
}

export const EVERYONE = new Set(['all', 'everyone', 'everybody'])
const LIST_SPLIT = /\s*(?:,|&|\band\b)\s*/i

/** A list of people; all resolve or the field is null with one issue per bad token. */
export function resolvePeople(text: string, ctx: InterpretContext, field: DraftField): { ids: string[] | null; issues: Issue[] } {
  const names = text.split(LIST_SPLIT).map((s) => s.trim()).filter(Boolean)
  if (names.length === 0) return { ids: null, issues: [{ field, code: 'missing' }] }
  if (names.length === 1 && EVERYONE.has(bare(names[0]))) return { ids: ctx.members.map((m) => m.id), issues: [] }
  const ids: string[] = []
  const issues: Issue[] = []
  for (const name of names) {
    const r = resolvePerson(name, ctx)
    if (!r.ok) issues.push({ field, ...r.issue })
    else if ('id' in r && !ids.includes(r.id)) ids.push(r.id)
  }
  return issues.length ? { ids: null, issues } : { ids, issues: [] }
}
