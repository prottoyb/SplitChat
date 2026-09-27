import { addDays, checkExpenseDate, isIsoDate } from '../../../shared/domain/dates'
import { MAX_AMOUNT_CENTS } from '../../../shared/domain/money'

/**
 * Deterministic Smart Expense interpretation (ADR-0012). An interpreter only
 * turns a chat message into a draft: it never writes anything, never calls an
 * API, and never guesses a critical field — anything not stated and resolved
 * to exactly one value is left null with an issue explaining why.
 */

export type Member = { id: string; name: string }

export type InterpretContext = {
  senderId: string
  /** The sender's local date of the message (YYYY-MM-DD). */
  messageDate: string
  /** Active members of the group (former and deleted members never match). */
  members: readonly Member[]
}

export type DraftField = 'description' | 'amount' | 'date' | 'payer' | 'participants'

export type IssueCode =
  | 'missing'
  | 'ambiguous'
  | 'unknown_name'
  | 'multiple_amounts'
  | 'invalid_amount'
  | 'unsupported_currency'
  | 'too_long'
  | 'invalid_date'

export type Issue = { field: DraftField; code: IssueCode; token?: string; matches?: string[] }

export type Draft = {
  description: string | null
  amountCents: number | null
  expenseDate: string | null
  paidBy: string | null
  participantIds: string[] | null
}

export type Interpretation =
  | { kind: 'none' }
  | { kind: 'candidate'; source: 'command' | 'natural'; draft: Draft; issues: Issue[]; interpreterVersion: string }

/** Anything that can produce a candidate draft — deterministic now, possibly an LLM later — without authority over money. */
export interface ExpenseInterpreter {
  readonly version: string
  interpret(body: string, ctx: InterpretContext): Promise<Interpretation>
}

export const MAX_NATURAL_LENGTH = 500
const MAX_DESCRIPTION = 120
const MAX_DAYS_AHEAD = 365

// ---------------------------------------------------------------------------
// Normalisation

/** NFKC, typographic apostrophes, no zero-width or bidi controls, single spaces. */
export function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, "")
    .replace(/\s+/g, ' ')
    .trim()
}

const bare = (token: string) => token.toLowerCase().replace(/^[("'@]+|[)"'.,;:!?]+$/g, '')

// ---------------------------------------------------------------------------
// Amounts (rule A): integer cents by string arithmetic, never floats.

const AMOUNT = /^(a\$|\$|aud)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(aud)?$/i
const FOREIGN_MARK = /^(us\$|nz\$)|[€£¥]/i
const FOREIGN_WORDS = new Set(['usd', 'nzd', 'eur', 'gbp', 'euro', 'euros', 'pound', 'pounds'])
const NUMERIC_LOOKING = /^[-−]?(?:a\$|\$|aud)?\.?\d/i

type AmountToken =
  | { kind: 'amount'; cents: number; marked: boolean }
  | { kind: 'invalid' }
  | { kind: 'unsupported' }

function readAmount(token: string, next: string | undefined): AmountToken | null {
  const t = token.replace(/^\(+/, '').replace(/[).,;:!?]+$/, '')
  if (!/\d/.test(t)) return null
  const nextWord = next ? bare(next) : ''
  if (FOREIGN_MARK.test(t) || FOREIGN_WORDS.has(nextWord)) return { kind: 'unsupported' }
  if (/^[-−]/.test(t)) return { kind: 'invalid' }
  const m = AMOUNT.exec(t)
  if (!m) return NUMERIC_LOOKING.test(t) ? { kind: 'invalid' } : null
  const whole = m[2].replace(/,/g, '').replace(/^0+(?=\d)/, '')
  if (whole.length > 10) return { kind: 'invalid' }
  const cents = Number(whole) * 100 + Number((m[3] ?? '').padEnd(2, '0'))
  if (cents < 1 || cents > MAX_AMOUNT_CENTS) return { kind: 'invalid' }
  return { kind: 'amount', cents, marked: Boolean(m[1] || m[4] || nextWord === 'aud') }
}

// ---------------------------------------------------------------------------
// People (M1–M6)

type Resolution = { ok: true; id: string } | { ok: false; issue: Omit<Issue, 'field'> } | { ok: true; all: true }

function resolvePerson(raw: string, ctx: InterpretContext): Resolution {
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

const EVERYONE = new Set(['all', 'everyone', 'everybody'])
const LIST_SPLIT = /\s*(?:,|&|\band\b)\s*/i

/** A list of people; all resolve or the field is null with one issue per bad token. */
function resolvePeople(text: string, ctx: InterpretContext, field: DraftField): { ids: string[] | null; issues: Issue[] } {
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

// ---------------------------------------------------------------------------
// Dates

function checkedDate(iso: string, ctx: InterpretContext): string | null {
  return isIsoDate(iso) && checkExpenseDate(iso, ctx.messageDate) === null && iso <= addDays(ctx.messageDate, MAX_DAYS_AHEAD)
    ? iso
    : null
}

function relativeDate(word: string, ctx: InterpretContext): string | null {
  if (word === 'today') return ctx.messageDate
  if (word === 'yesterday') return addDays(ctx.messageDate, -1)
  return null
}

function description(text: string, issues: Issue[]): string | null {
  const d = text.trim().replace(/[\s,;:]+$/, '')
  if (!d) return null
  if ([...d].length > MAX_DESCRIPTION) {
    issues.push({ field: 'description', code: 'too_long' })
    return null
  }
  return d
}

// ---------------------------------------------------------------------------
// `/expense` command

const COMMAND = /^\/expense(?:\s|$)/i
const OPTION = /^(paid|with|split|date):(.*)$/i

function interpretCommand(text: string, ctx: InterpretContext): Interpretation {
  const tokens = text.replace(COMMAND, '').trim().split(' ').filter(Boolean)
  const issues: Issue[] = []
  const draft: Draft = { description: null, amountCents: null, expenseDate: ctx.messageDate, paidBy: null, participantIds: null }

  const head: string[] = []
  const options = new Map<string, string[]>()
  const repeated = new Set<string>()
  let current: string[] | null = null
  for (const token of tokens) {
    const opt = OPTION.exec(token)
    if (opt) {
      const key = opt[1].toLowerCase()
      if (options.has(key)) repeated.add(key)
      current = opt[2] ? [opt[2]] : []
      options.set(key, current)
    } else if (current) {
      current.push(token)
    } else {
      head.push(token)
    }
  }

  // Amount: the first token, if it is one.
  let rest = head
  if (head.length) {
    const amount = readAmount(head[0], head[1])
    if (amount?.kind === 'amount') {
      draft.amountCents = amount.cents
      rest = head.slice(bare(head[1] ?? '') === 'aud' ? 2 : 1)
    } else if (amount) {
      issues.push({ field: 'amount', code: amount.kind === 'unsupported' ? 'unsupported_currency' : 'invalid_amount', token: head[0] })
      rest = head.slice(1)
    }
  }
  if (draft.amountCents === null && !issues.some((i) => i.field === 'amount')) issues.push({ field: 'amount', code: 'missing' })

  draft.description = description(rest.join(' '), issues)
  if (draft.description === null && !issues.some((i) => i.field === 'description')) issues.push({ field: 'description', code: 'missing' })

  const value = (key: string) => (options.get(key) ?? []).join(' ')

  if (repeated.has('paid')) issues.push({ field: 'payer', code: 'ambiguous' })
  else if (options.has('paid')) {
    const r = resolvePerson(value('paid'), ctx)
    if (r.ok && 'id' in r) draft.paidBy = r.id
    else if (!r.ok) issues.push({ field: 'payer', ...r.issue })
  } else issues.push({ field: 'payer', code: 'missing' })

  if (repeated.has('with') || repeated.has('split') || (options.has('with') && options.has('split'))) {
    issues.push({ field: 'participants', code: 'ambiguous' })
  } else if (options.has('with')) {
    const r = resolvePeople(value('with'), ctx, 'participants')
    draft.participantIds = r.ids && [ctx.senderId, ...r.ids.filter((id) => id !== ctx.senderId)]
    issues.push(...r.issues)
  } else if (options.has('split')) {
    const r = resolvePeople(value('split'), ctx, 'participants')
    draft.participantIds = r.ids
    issues.push(...r.issues)
  } else issues.push({ field: 'participants', code: 'missing' })

  if (repeated.has('date')) {
    draft.expenseDate = null
    issues.push({ field: 'date', code: 'ambiguous' })
  } else if (options.has('date')) {
    const raw = value('date').trim()
    const word = bare(raw)
    draft.expenseDate = relativeDate(word, ctx) ?? checkedDate(raw, ctx)
    if (draft.expenseDate === null) issues.push({ field: 'date', code: 'invalid_date', token: raw })
  }

  return { kind: 'candidate', source: 'command', draft, issues, interpreterVersion: DETERMINISTIC_VERSION }
}

// ---------------------------------------------------------------------------
// Natural language

const NEGATION = /\b(?:not|never|don't|didn't|won't|can't|isn't|wasn't)\b/i
const CUE = /\b(?:paid|spent|bought|covered|split)\b/i
const AMOUNT_VERBS = new Set(['paid', 'spent', 'cost', 'costs', 'was'])
const PAYER_VERBS = new Set(['paid', 'spent', 'bought', 'covered', 'got'])
const LIST_STOP = new Set(['for', 'on', 'paid', 'today', 'yesterday'])
const DESCRIPTION_STOP = new Set([...LIST_STOP, 'with', 'split', 'between', 'among'])
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october',
  'november', 'december', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec']
const DATE_WORDS = new Set([...WEEKDAYS, ...MONTHS, 'tomorrow', 'tonight', 'ago'])
const ENDS_CLAUSE = /[.!?;]$/

type Word = { raw: string; low: string; amount: AmountToken | null; endsClause: boolean; comma: boolean }

function words(text: string): Word[] {
  const raws = text.split(' ')
  return raws.map((raw, i) => ({
    raw,
    low: bare(raw),
    amount: readAmount(raw, raws[i + 1]),
    endsClause: ENDS_CLAUSE.test(raw) && !/^\$?\d+(?:\.\d+)?$/.test(raw),
    comma: raw.endsWith(','),
  }))
}

/** Words from `start` until a clause end, a stop word or an amount. */
function phrase(ws: Word[], start: number, stops: ReadonlySet<string>): { text: string; end: number } {
  const out: string[] = []
  let i = start
  for (; i < ws.length; i++) {
    const w = ws[i]
    if (stops.has(w.low) || w.amount) break
    out.push(w.raw)
    if (w.endsClause) {
      i++
      break
    }
  }
  return { text: out.join(' ').replace(/[.!?;,]+$/, ''), end: i }
}

function interpretNatural(text: string, ctx: InterpretContext): Interpretation {
  // Detection D1–D5.
  if (text.startsWith('/') || [...text].length > MAX_NATURAL_LENGTH || text.endsWith('?')) return { kind: 'none' }
  if (NEGATION.test(text) || !CUE.test(text)) return { kind: 'none' }
  const ws = words(text)
  const amountAt = (i: number) => {
    const a = ws[i].amount
    if (!a) return null
    if (a.kind === 'amount' && (a.marked || (i > 0 && AMOUNT_VERBS.has(ws[i - 1].low)))) return a
    if (a.kind === 'unsupported') return a
    return null
  }
  const found: AmountToken[] = []
  for (let i = 0; i < ws.length; i++) {
    const a = amountAt(i)
    if (a) found.push(a)
  }
  if (found.length === 0) return { kind: 'none' }

  const issues: Issue[] = []
  const draft: Draft = { description: null, amountCents: null, expenseDate: null, paidBy: null, participantIds: null }

  // N1 amount
  if (found.some((a) => a.kind === 'unsupported')) issues.push({ field: 'amount', code: 'unsupported_currency' })
  else {
    const values = [...new Set(found.flatMap((a) => (a.kind === 'amount' ? [a.cents] : [])))]
    if (values.length === 1) draft.amountCents = values[0]
    else issues.push({ field: 'amount', code: 'multiple_amounts' })
  }

  // N2 payer
  const payers: string[] = []
  const payerIssues: Issue[] = []
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i]
    if (w.low === 'i' && PAYER_VERBS.has(ws[i + 1]?.low ?? '')) payers.push(ctx.senderId)
    if (w.low === 'paid' && ws[i + 1]?.low === 'by') {
      // The payer is 1–3 words and ends at a comma or clause end.
      const nameWords: string[] = []
      for (let j = i + 2; j < ws.length && nameWords.length < 3; j++) {
        if (LIST_STOP.has(ws[j].low) || ws[j].amount) break
        nameWords.push(ws[j].raw)
        if (ws[j].comma || ws[j].endsClause) break
      }
      const name = nameWords.join(' ')
      const r = resolvePerson(name, ctx)
      if (r.ok && 'id' in r) payers.push(r.id)
      else if (!r.ok) payerIssues.push({ field: 'payer', ...r.issue })
    }
    // "P paid" where P is 1–3 words at the start of a sentence or after a comma.
    if (PAYER_VERBS.has(w.low) && w.low !== 'got' && i > 0 && ws[i + 1]?.low !== 'by') {
      let start = i
      while (start > 0 && i - start < 3 && !ws[start - 1].endsClause && !ws[start - 1].comma) start--
      const atBoundary = start === 0 || ws[start - 1].endsClause || ws[start - 1].comma
      const name = ws.slice(start, i).map((x) => x.raw).join(' ')
      if (atBoundary && name && bare(name) !== 'i') {
        const r = resolvePerson(name, ctx)
        if (r.ok && 'id' in r) payers.push(r.id)
        else if (!r.ok) payerIssues.push({ field: 'payer', ...r.issue })
      }
    }
  }
  const distinctPayers = [...new Set(payers)]
  if (distinctPayers.length === 1 && payerIssues.length === 0) draft.paidBy = distinctPayers[0]
  else if (distinctPayers.length > 1 || (distinctPayers.length && payerIssues.length)) issues.push({ field: 'payer', code: 'ambiguous' })
  else if (payerIssues.length) issues.push(...payerIssues)
  else issues.push({ field: 'payer', code: 'missing' })

  // N3 participants
  const low = ws.map((w) => w.low)
  let participantsSet = false
  for (let i = 0; i < ws.length && !participantsSet; i++) {
    const next = low[i + 1] ?? ''
    const afterSplit = low[i] === 'split' ? (next === 'it' ? i + 2 : i + 1) : -1
    if ((low[i] === 'for' || low[i] === 'with') && EVERYONE.has(next)) {
      draft.participantIds = ctx.members.map((m) => m.id)
      participantsSet = true
    } else if (afterSplit > 0 && (low[afterSplit] === 'between' || low[afterSplit] === 'among')) {
      const from = low[afterSplit + 1] === 'us' ? afterSplit + 2 : afterSplit + 1
      const p = phrase(ws, from, LIST_STOP)
      if (EVERYONE.has(low[from] ?? '')) draft.participantIds = ctx.members.map((m) => m.id)
      else {
        const r = resolvePeople(p.text, ctx, 'participants')
        draft.participantIds = r.ids
        issues.push(...r.issues)
      }
      participantsSet = true
    } else if (low[i] === 'with' && !EVERYONE.has(next)) {
      const r = resolvePeople(phrase(ws, i + 1, LIST_STOP).text, ctx, 'participants')
      draft.participantIds = r.ids && [ctx.senderId, ...r.ids.filter((id) => id !== ctx.senderId)]
      issues.push(...r.issues)
      participantsSet = true
    }
  }
  if (!participantsSet) issues.push({ field: 'participants', code: 'missing' })

  // N4 description
  for (let i = 0; i < ws.length && draft.description === null; i++) {
    const w = low[i]
    if (w !== 'for' && w !== 'bought' && w !== 'on') continue
    const p = phrase(ws, i + 1, DESCRIPTION_STOP)
    if (!p.text) continue
    if (w === 'for' && (EVERYONE.has(bare(p.text)) || resolvePeople(p.text, ctx, 'participants').ids)) continue
    if (w === 'on' && (isIsoDate(p.text) || DATE_WORDS.has(bare(p.text)))) continue
    draft.description = description(p.text, issues)
    if (draft.description === null) break
  }
  if (draft.description === null && !issues.some((x) => x.field === 'description')) issues.push({ field: 'description', code: 'missing' })

  // N5 date
  const isoOn = low.findIndex((w, i) => w === 'on' && isIsoDate(bare(ws[i + 1]?.raw ?? '')))
  const relative = low.find((w) => w === 'today' || w === 'yesterday')
  const dateLike =
    low.some((w) => DATE_WORDS.has(w)) || /\blast night\b/i.test(text) || /\b\d{1,2}\/\d{1,2}\b/.test(text)
  if (dateLike) issues.push({ field: 'date', code: 'ambiguous' })
  else if (isoOn >= 0) {
    const raw = bare(ws[isoOn + 1].raw)
    draft.expenseDate = checkedDate(raw, ctx)
    if (!draft.expenseDate) issues.push({ field: 'date', code: 'invalid_date', token: raw })
  } else draft.expenseDate = relative ? relativeDate(relative, ctx) : ctx.messageDate

  return { kind: 'candidate', source: 'natural', draft, issues, interpreterVersion: DETERMINISTIC_VERSION }
}

// ---------------------------------------------------------------------------

export const DETERMINISTIC_VERSION = 'deterministic-1'

/** Synchronous core, for tests and callers that need no interface. */
export function interpretMessage(body: string, ctx: InterpretContext): Interpretation {
  const text = normalize(body)
  if (!text) return { kind: 'none' }
  if (COMMAND.test(text)) return interpretCommand(text, ctx)
  return interpretNatural(text, ctx)
}

export const deterministicInterpreter: ExpenseInterpreter = {
  version: DETERMINISTIC_VERSION,
  interpret: (body, ctx) => Promise.resolve(interpretMessage(body, ctx)),
}
