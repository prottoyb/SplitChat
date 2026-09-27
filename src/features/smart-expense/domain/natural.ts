import { isIsoDate } from '../../../shared/domain/dates'
import { readAmount, type AmountToken } from './amounts'
import { checkedDate, description, markMissing, relativeDate } from './fields'
import { EVERYONE, resolvePeople, resolvePerson } from './people'
import { bare } from './text'
import { DETERMINISTIC_VERSION, MAX_NATURAL_LENGTH, type Draft, type InterpretContext, type Interpretation, type Issue } from './types'

// Natural language: conservative detection (D1–D5) and extraction (N1–N6).

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

export function interpretNatural(text: string, ctx: InterpretContext): Interpretation {
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
  markMissing(draft, issues, 'description', 'description')

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
