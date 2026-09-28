import { describe, expect, it } from 'vitest'
import vectors from './fixtures/settle-up-vectors.json'
import { simplifyDebts, type NetBalance, type Transfer } from './simplifyDebts'

/** Applies a plan and returns everyone's remaining balance. */
const afterPlan = (balances: NetBalance[], plan: Transfer[]) => {
  const net = new Map(balances.map((b) => [b.userId, b.netCents]))
  for (const t of plan) {
    net.set(t.from, (net.get(t.from) ?? 0) + t.amountCents)
    net.set(t.to, (net.get(t.to) ?? 0) - t.amountCents)
  }
  return [...net.values()]
}

describe('simplifyDebts', () => {
  it.each(vectors.vectors.map((v) => [v.name, v] as const))('matches the shared vector: %s', (_name, v) => {
    expect(simplifyDebts(v.balances)).toEqual(v.plan)
  })

  it('does not depend on input order', () => {
    const v = vectors.vectors.find((x) => x.name === 'mixed partials')
    if (!v) throw new Error('vector missing')
    expect(simplifyDebts([...v.balances].reverse())).toEqual(v.plan)
  })

  it('settles everyone exactly with at most n - 1 positive transfers (generated ledgers)', () => {
    let seed = 7
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    for (let round = 0; round < 200; round += 1) {
      const n = 2 + rand(9)
      const balances: NetBalance[] = []
      let sum = 0
      for (let i = 0; i < n - 1; i += 1) {
        const cents = rand(200001) - 100000
        balances.push({ userId: `u${i}`, netCents: cents })
        sum += cents
      }
      balances.push({ userId: `u${n - 1}`, netCents: -sum })
      const plan = simplifyDebts(balances)
      expect(plan.length).toBeLessThanOrEqual(n - 1)
      expect(plan.every((t) => Number.isSafeInteger(t.amountCents) && t.amountCents > 0 && t.from !== t.to)).toBe(true)
      expect(afterPlan(balances, plan).every((x) => x === 0)).toBe(true)
    }
  })

  it('rejects input that is not a ledger', () => {
    expect(() => simplifyDebts([{ userId: 'a', netCents: 1 }])).toThrow(RangeError)
    expect(() => simplifyDebts([{ userId: 'a', netCents: 0.5 }, { userId: 'b', netCents: -0.5 }])).toThrow(RangeError)
    expect(() => simplifyDebts([{ userId: 'a', netCents: 1 }, { userId: 'a', netCents: -1 }])).toThrow(RangeError)
  })
})
