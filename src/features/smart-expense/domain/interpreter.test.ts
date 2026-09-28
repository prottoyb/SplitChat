import { describe, expect, it } from 'vitest'
import { deterministicInterpreter, interpretMessage, type Draft, type InterpretContext, type Issue } from './interpreter'

const P = 'id-priya'
const S = 'id-sam'
const A = 'id-alex'
const J = 'id-jo'
const ctx: InterpretContext = {
  senderId: P,
  messageDate: '2026-09-28',
  members: [
    { id: P, name: 'Priya Raman' },
    { id: S, name: 'Sam Lee' },
    { id: A, name: 'Alexander Montgomery-Whitfield' },
    { id: J, name: 'Jo Nguyen' },
  ],
}
const ALL = [P, S, A, J]

function candidate(body: string, c: InterpretContext = ctx) {
  const r = interpretMessage(body, c)
  if (r.kind !== 'candidate') throw new Error(`expected a candidate for ${JSON.stringify(body)}`)
  return r
}
const issue = (issues: Issue[], field: Issue['field']) => issues.find((i) => i.field === field)?.code
const complete = (d: Draft) => Object.values(d).every((v) => v !== null)

describe('/expense command', () => {
  it('reads every field of a full command', () => {
    const r = candidate("/expense $84.50 Dinner at Mama's paid:me with:Sam Lee, Alexander date:yesterday")
    expect(r.source).toBe('command')
    expect(r.draft).toEqual({
      description: "Dinner at Mama's",
      amountCents: 8450,
      expenseDate: '2026-09-27',
      paidBy: P,
      participantIds: [P, S, A],
    })
    expect(r.issues).toEqual([])
  })

  it('split: names exactly the people; all/everyone means every member', () => {
    expect(candidate('/expense 30 Taxi paid:Sam split:Jo & Alexander').draft.participantIds).toEqual([J, A])
    expect(candidate('/expense 30 Taxi paid:Sam split:everyone').draft.participantIds).toEqual(ALL)
  })

  it('never defaults the payer or participants', () => {
    const r = candidate('/expense 12 coffee')
    expect(r.draft).toMatchObject({ amountCents: 1200, description: 'coffee', paidBy: null, participantIds: null, expenseDate: '2026-09-28' })
    expect(issue(r.issues, 'payer')).toBe('missing')
    expect(issue(r.issues, 'participants')).toBe('missing')
  })

  it('proposes even an empty command, with everything missing but the date', () => {
    const r = candidate('/expense')
    expect(r.draft).toEqual({ description: null, amountCents: null, expenseDate: '2026-09-28', paidBy: null, participantIds: null })
    expect(r.issues.map((i) => i.field).sort()).toEqual(['amount', 'description', 'participants', 'payer'])
  })

  it('treats a first token that is not an amount as the start of the description', () => {
    const r = candidate('/expense Dinner 30 paid:me split:all')
    expect(r.draft).toMatchObject({ amountCents: null, description: 'Dinner 30' })
    expect(issue(r.issues, 'amount')).toBe('missing')
  })

  it.each([
    ['84.505', 'invalid_amount'],
    ['1,23.4', 'invalid_amount'],
    ['$', 'missing'],
    ['-5', 'invalid_amount'],
    ['−5', 'invalid_amount'],
    ['0', 'invalid_amount'],
    ['1e5', 'invalid_amount'],
    ['0x10', 'invalid_amount'],
    ['99999999999999999999', 'invalid_amount'],
    ['€20', 'unsupported_currency'],
    ['US$20', 'unsupported_currency'],
  ])('refuses the amount %j (%s)', (amount, code) => {
    const r = candidate(`/expense ${amount} lunch paid:me split:all`)
    expect(r.draft.amountCents).toBeNull()
    expect(issue(r.issues, 'amount')).toBe(code)
  })

  it.each([
    ['84', 8400], ['84.5', 8450], ['$84.50', 8450], ['A$84.50', 8450], ['AUD84.50', 8450], ['84.50AUD', 8450], ['1,234.56', 123456],
    ['９９.５０', 9950], // fullwidth digits become ASCII under NFKC
  ])('reads the amount %j as %i cents', (amount, cents) => {
    expect(candidate(`/expense ${amount} lunch`).draft.amountCents).toBe(cents)
  })

  it('reads a suffix AUD written as a separate word', () => {
    expect(candidate('/expense 20 AUD lunch').draft).toMatchObject({ amountCents: 2000, description: 'lunch' })
  })

  it('does not read Arabic-Indic digits as an amount', () => {
    expect(candidate('/expense ٨٤ lunch').draft.amountCents).toBeNull()
  })

  it('marks a repeated key, or with: together with split:, as ambiguous', () => {
    expect(issue(candidate('/expense 5 x paid:me paid:Sam').issues, 'payer')).toBe('ambiguous')
    const r = candidate('/expense 5 x with:Sam split:Jo')
    expect(r.draft.participantIds).toBeNull()
    expect(issue(r.issues, 'participants')).toBe('ambiguous')
  })

  it('refuses an invalid or out-of-range date instead of defaulting', () => {
    for (const d of ['2026-02-30', '1999-12-31', '2028-01-01', 'soon']) {
      const r = candidate(`/expense 5 x paid:me split:all date:${d}`)
      expect(r.draft.expenseDate).toBeNull()
      expect(issue(r.issues, 'date')).toBe('invalid_date')
    }
    expect(candidate('/expense 5 x date:2026-09-01').draft.expenseDate).toBe('2026-09-01')
  })

  it('keeps an unknown key inside the description', () => {
    expect(candidate('/expense 5 Dinner: pizza paid:me').draft.description).toBe('Dinner: pizza')
  })

  it('refuses a description over 120 characters', () => {
    const r = candidate(`/expense 5 ${'x'.repeat(121)}`)
    expect(r.draft.description).toBeNull()
    expect(issue(r.issues, 'description')).toBe('too_long')
  })

  it('keeps markup and SQL-like text as plain description text', () => {
    expect(candidate("/expense 5 <script>alert(1)</script>'; DROP TABLE expenses;-- paid:me").draft.description).toBe(
      "<script>alert(1)</script>'; DROP TABLE expenses;--",
    )
  })
})

describe('natural language', () => {
  it('reads a complete sentence', () => {
    const r = candidate('I paid $84.50 for dinner, split with everyone')
    expect(r.source).toBe('natural')
    expect(r.draft).toEqual({ description: 'dinner', amountCents: 8450, expenseDate: '2026-09-28', paidBy: P, participantIds: ALL })
    expect(r.issues).toEqual([])
  })

  it('reads another member as the payer, and "with" includes the sender', () => {
    const r = candidate('Sam paid $30 for the taxi yesterday, split with Jo')
    expect(r.draft).toEqual({ description: 'the taxi', amountCents: 3000, expenseDate: '2026-09-27', paidBy: S, participantIds: [P, J] })
  })

  it('reads "paid by" and "split between" (exactly those people)', () => {
    const r = candidate('Groceries $96.30 paid by Jo, split between Sam and Alexander')
    expect(r.draft).toMatchObject({ paidBy: J, participantIds: [S, A], amountCents: 9630 })
  })

  it('accepts a bare number right after a cue verb', () => {
    expect(candidate('I spent 45 on petrol, split with Sam').draft).toMatchObject({ amountCents: 4500, description: 'petrol' })
  })

  it.each([
    'Rent is due Friday',
    'Also did the big shop today, $96.30', // no cue word
    'Did you pay $20 for the tickets?',
    "I didn't pay $20 for that",
    'We never paid $20',
    'The table seats 12 people and I paid nothing', // bare number not after a cue verb
    '/nothing I paid $5',
  ])('does not detect an expense in %j', (body) => {
    expect(interpretMessage(body, ctx)).toEqual({ kind: 'none' })
  })

  it('does not interpret long messages in natural mode', () => {
    expect(interpretMessage(`I paid $5 for ${'x'.repeat(600)}`, ctx)).toEqual({ kind: 'none' })
  })

  it('leaves the amount unset when several amounts appear', () => {
    const r = candidate('I paid $20 for lunch and $15 for coffee, split with Sam')
    expect(r.draft.amountCents).toBeNull()
    expect(issue(r.issues, 'amount')).toBe('multiple_amounts')
  })

  it('refuses a foreign currency', () => {
    const r = candidate('I paid €20 for the museum, split with Sam')
    expect(r.draft.amountCents).toBeNull()
    expect(issue(r.issues, 'amount')).toBe('unsupported_currency')
  })

  it('marks two payers as ambiguous', () => {
    const r = candidate('I paid $20 for lunch, Sam paid too')
    expect(r.draft.paidBy).toBeNull()
    expect(issue(r.issues, 'payer')).toBe('ambiguous')
  })

  it('marks weekday and other vague dates as ambiguous instead of guessing', () => {
    for (const body of ['I paid $20 for lunch on Friday, split with Sam', 'I paid $20 for dinner last night, split with Sam', 'I paid $20 for lunch 2 days ago, split with Sam']) {
      const r = candidate(body)
      expect(r.draft.expenseDate).toBeNull()
      expect(issue(r.issues, 'date')).toBe('ambiguous')
    }
  })

  it('reads an explicit ISO date', () => {
    expect(candidate('I paid $20 for lunch on 2026-09-20, split with Sam').draft.expenseDate).toBe('2026-09-20')
  })

  it('reports an unknown participant and leaves participants unset', () => {
    const r = candidate('I paid $20 for lunch, split with Sam and Zed')
    expect(r.draft.participantIds).toBeNull()
    expect(r.issues).toContainEqual({ field: 'participants', code: 'unknown_name', token: 'Zed' })
  })

  it('marks "us" as ambiguous', () => {
    const r = candidate('I paid $20 for lunch, split with us')
    expect(r.draft.participantIds).toBeNull()
    expect(issue(r.issues, 'participants')).toBe('ambiguous')
  })

  it('leaves the payer unset when nobody is said to have paid', () => {
    const r = candidate('Dinner cost $60, split with Sam')
    expect(r.draft.paidBy).toBeNull()
    expect(issue(r.issues, 'payer')).toBe('missing')
  })
})

describe('name matching', () => {
  const twins: InterpretContext = {
    ...ctx,
    members: [...ctx.members, { id: 'id-sam-park', name: 'Sam Park' }, { id: 'id-jo-2', name: 'Jo Nguyen' }],
  }

  it('matches a unique first name, and a full name exactly, case-insensitively', () => {
    expect(candidate('/expense 5 x paid:alexander').draft.paidBy).toBe(A)
    expect(candidate('/expense 5 x paid:@Alexander Montgomery-Whitfield.').draft.paidBy).toBe(A)
  })

  it('lists the matches when a first name is shared', () => {
    const r = candidate('/expense 5 x paid:Sam', twins)
    expect(r.draft.paidBy).toBeNull()
    expect(r.issues).toContainEqual({ field: 'payer', code: 'ambiguous', token: 'Sam', matches: [S, 'id-sam-park'] })
    expect(candidate('/expense 5 x paid:Sam Park', twins).draft.paidBy).toBe('id-sam-park')
  })

  it('treats identical full names as ambiguous', () => {
    expect(issue(candidate('/expense 5 x paid:Jo Nguyen', twins).issues, 'payer')).toBe('ambiguous')
  })

  it('never matches prefixes, nicknames or non-members', () => {
    expect(issue(candidate('/expense 5 x paid:Al').issues, 'payer')).toBe('unknown_name')
    expect(issue(candidate('/expense 5 x paid:Alex').issues, 'payer')).toBe('unknown_name') // a nickname of Alexander
    expect(issue(candidate('/expense 5 x paid:Zed').issues, 'payer')).toBe('unknown_name')
  })

  it('ignores zero-width and bidi characters hidden in names', () => {
    expect(candidate('/expense 5 x paid:S​am').draft.paidBy).toBe(S)
    expect(candidate('/expense 5 x paid:‮Sam').draft.paidBy).toBe(S)
  })

  it('collapses the same person named twice', () => {
    expect(candidate('/expense 5 x split:Sam, sam lee, me').draft.participantIds).toEqual([S, P])
  })
})

describe('robustness', () => {
  it('handles a 2000-character message quickly', () => {
    const body = `/expense 5 ${'word '.repeat(398)}`
    const started = performance.now()
    candidate(body)
    interpretMessage('I paid $5 '.repeat(200), ctx)
    expect(performance.now() - started).toBeLessThan(50)
  })

  it('produces a complete draft only when every field is stated', () => {
    expect(complete(candidate('/expense 20 Lunch paid:me split:all').draft)).toBe(true)
    expect(complete(candidate('/expense 20 Lunch paid:me').draft)).toBe(false)
  })

  it('is available behind the ExpenseInterpreter interface', async () => {
    expect(deterministicInterpreter.version).toBe('deterministic-1')
    await expect(deterministicInterpreter.interpret('/expense 20 Lunch', ctx)).resolves.toMatchObject({ kind: 'candidate', interpreterVersion: 'deterministic-1' })
  })
})
