import { readAmount } from './amounts'
import { checkedDate, description, markMissing, relativeDate } from './fields'
import { resolvePeople, resolvePerson } from './people'
import { bare } from './text'
import { DETERMINISTIC_VERSION, type Draft, type InterpretContext, type Interpretation, type Issue } from './types'

// The `/expense` command (ADR-0012 grammar).

export const COMMAND = /^\/expense(?:\s|$)/i
const OPTION = /^(paid|with|split|date):(.*)$/i

export function interpretCommand(text: string, ctx: InterpretContext): Interpretation {
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
  markMissing(draft, issues, 'amount', 'amountCents')

  draft.description = description(rest.join(' '), issues)
  markMissing(draft, issues, 'description', 'description')

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
