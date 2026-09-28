import { describe, expect, it } from 'vitest'
import { CLI_MODE_FLAGS, MIGRATION_LIST_ARGS, SECURITY_AUDIT_CHECKS, evaluateSecurityAudit, parseMigrationList } from './cliOutput.mjs'

const row = (local, remote) => ({ local, remote, time: '2026-09-26 00:00:00' })
const doc = (rows) => JSON.stringify({ migrations: rows })

// The text table the pinned CLI prints when it does not detect an agent:
// the output that broke the first production preflight.
const HUMAN_TABLE = `

   Local            | Remote           | Time (UTC)
  ------------------|------------------|-----------------------
   \`20260926000000\` | \`20260926000000\` | \`2026-09-26 00:00:00\`
`

describe('parseMigrationList', () => {
  it('returns the remote versions of a well-formed JSON listing', () => {
    expect(parseMigrationList(doc([row('20260926000000', '20260926000000'), row('20260926100000', '20260926100000')])))
      .toEqual(['20260926000000', '20260926100000'])
  })

  it('ignores versions that exist only locally (not yet applied)', () => {
    expect(parseMigrationList(doc([row('20260926000000', '20260926000000'), row('20260927100000', '')])))
      .toEqual(['20260926000000'])
  })

  it('keeps remote-only versions (applied but missing locally)', () => {
    expect(parseMigrationList(doc([row('', '20260926000000')]))).toEqual(['20260926000000'])
  })

  it('accepts an empty history as a real, parsed empty list', () => {
    expect(parseMigrationList(doc([]))).toEqual([])
    expect(parseMigrationList(doc([row('20260926000000', '')]))).toEqual([])
  })

  it('tolerates surrounding whitespace only', () => {
    expect(parseMigrationList(`\n  ${doc([row('20260926000000', '20260926000000')])}  \n`)).toEqual(['20260926000000'])
  })

  it.each([
    ['empty output', ''],
    ['whitespace only', '   \n'],
    ['undefined output', undefined],
    ['the human text table (regression: first production preflight)', HUMAN_TABLE],
    ['truncated JSON', doc([row('20260926000000', '20260926000000')]).slice(0, 40)],
    ['JSON followed by other text', `${doc([])}\nA new version of Supabase CLI is available`],
    ['text before the JSON', `Connecting...\n${doc([])}`],
    ['two JSON documents', `${doc([])}${doc([])}`],
    ['a JSON array', '[]'],
    ['JSON null', 'null'],
    ['an object without migrations', '{"upToDate":true}'],
    ['migrations that is not an array', '{"migrations":{}}'],
    ['a non-object entry', '{"migrations":["20260926000000"]}'],
    ['a malformed remote version', doc([row('20260926000000', '2026-09-26')])],
    ['a numeric version', '{"migrations":[{"local":20260926000000,"remote":20260926000000}]}'],
    ['an entry with neither side', doc([row('', '')])],
    ['duplicate remote versions', doc([row('20260926000000', '20260926000000'), row('', '20260926000000')])],
  ])('refuses %s', (_label, stdout) => {
    expect(() => parseMigrationList(stdout)).toThrow(/^REFUSING: could not read the migration history/)
  })

  it('never returns an empty history for unreadable output', () => {
    // The dangerous failure would be treating garbage as "no migrations yet".
    for (const bad of ['', HUMAN_TABLE, '{}', '{"migrations":null}']) {
      expect(() => parseMigrationList(bad)).toThrow()
    }
  })
})

describe('CLI invocation flags', () => {
  it('pins agent detection off and asks migration list for JSON explicitly', () => {
    expect(CLI_MODE_FLAGS).toEqual(['--agent', 'no'])
    expect(MIGRATION_LIST_ARGS).toEqual(['migration', 'list', '--output-format', 'json'])
  })
})

describe('evaluateSecurityAudit', () => {
  const section = (name, rows) =>
    `${name} some description\n col \n-----\n${' x\n'.repeat(rows)}(${rows} ${rows === 1 ? 'row' : 'rows'})\n\n`
  const allClean = () => SECURITY_AUDIT_CHECKS.map((n) => section(n, 0)).join('')

  it('passes when every check is present with no offending rows', () => {
    const r = evaluateSecurityAudit(`I1 informational\n(3 rows)\n\n${allClean()}`)
    expect(r.passed).toBe(true)
    expect(r.sections).toHaveLength(SECURITY_AUDIT_CHECKS.length)
  })

  it('fails on offending rows and names the check', () => {
    const r = evaluateSecurityAudit(allClean().replace(section('A5', 0), section('A5', 1)))
    expect(r.passed).toBe(false)
    expect(r.offending).toEqual([['A5', 1]])
  })

  it('fails when a check is missing, so a vanished section never passes', () => {
    const r = evaluateSecurityAudit(allClean().replace(section('A3b', 0), ''))
    expect(r.passed).toBe(false)
    expect(r.missing).toEqual(['A3b'])
  })

  it('fails on a repeated or unknown check', () => {
    const r = evaluateSecurityAudit(allClean() + section('A4', 0) + section('A12', 0))
    expect(r.passed).toBe(false)
    expect(r.unexpected).toEqual(['A4', 'A12'])
  })

  it('fails on empty or unreadable output', () => {
    expect(evaluateSecurityAudit('').passed).toBe(false)
    expect(evaluateSecurityAudit(undefined).passed).toBe(false)
  })
})
