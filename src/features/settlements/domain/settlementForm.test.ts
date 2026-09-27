import { describe, expect, it } from 'vitest'
import { maxPayableCents, validateSettlementForm, validateVoidReason, type SettlementFormValues } from './settlementForm'

const net = new Map([['alice', 4666], ['bob', -4333], ['eve', -333]])
const today = '2026-09-28'
const values = (fields: Partial<SettlementFormValues> = {}): SettlementFormValues => ({
  fromUserId: 'bob', toUserId: 'alice', amount: '10.00', settledOn: today, note: '', ...fields,
})

describe('maxPayableCents', () => {
  it('is the smaller of what the payer owes and the payee is owed', () => {
    expect(maxPayableCents(net, 'bob', 'alice')).toBe(4333)
    expect(maxPayableCents(net, 'eve', 'alice')).toBe(333)
  })

  it('is zero for a reversal or between two debtors', () => {
    expect(maxPayableCents(net, 'alice', 'bob')).toBe(0)
    expect(maxPayableCents(net, 'eve', 'bob')).toBe(0)
    expect(maxPayableCents(net, 'nobody', 'alice')).toBe(0)
  })
})

describe('validateSettlementForm', () => {
  it('accepts a partial payment in exact cents and trims the note', () => {
    expect(validateSettlementForm(values({ amount: '12.34', note: '  cash ' }), net, today)).toEqual({
      ok: true,
      value: { fromUserId: 'bob', toUserId: 'alice', amountCents: 1234, settledOn: today, note: 'cash' },
    })
  })

  it('accepts exactly the full debt and refuses one cent more', () => {
    expect(validateSettlementForm(values({ amount: '43.33' }), net, today).ok).toBe(true)
    const over = validateSettlementForm(values({ amount: '43.34' }), net, today)
    expect(!over.ok && over.errors.amount).toMatch(/most that can be paid is \$43\.33/)
  })

  it('refuses a reversal and paying yourself', () => {
    const reversal = validateSettlementForm(values({ fromUserId: 'alice', toUserId: 'bob' }), net, today)
    expect(!reversal.ok && reversal.errors.parties).toMatch(/nothing to settle/)
    const self = validateSettlementForm(values({ toUserId: 'bob' }), net, today)
    expect(!self.ok && self.errors.parties).toMatch(/Choose who paid/)
  })

  it.each([
    ['', /enter the amount/],
    ['0', /greater than zero/],
    ['-1', /greater than zero/],
    ['1.005', /two decimal places/],
    ['1e3', /greater than zero/],
    ['10000000000', /between \$0\.01/],
  ])('rejects amount %j', (amount, message) => {
    const result = validateSettlementForm(values({ amount }), net, today)
    expect(!result.ok && result.errors.amount).toMatch(message)
  })

  it('checks the date with payment wording', () => {
    const early = validateSettlementForm(values({ settledOn: '1999-12-31' }), net, today)
    expect(!early.ok && early.errors.settledOn).toBe('The payment date cannot be before 1 January 2000.')
    const missing = validateSettlementForm(values({ settledOn: '' }), net, today)
    expect(!missing.ok && missing.errors.settledOn).toBe('Please select the payment date.')
  })

  it('limits the note', () => {
    const result = validateSettlementForm(values({ note: 'n'.repeat(201) }), net, today)
    expect(!result.ok && result.errors.note).toMatch(/200 characters/)
  })
})

describe('validateVoidReason', () => {
  it('requires a reason of at most 200 characters', () => {
    expect(validateVoidReason('  ')).toMatch(/why/)
    expect(validateVoidReason('r'.repeat(201))).toMatch(/200/)
    expect(validateVoidReason('Recorded twice')).toBeNull()
  })
})
