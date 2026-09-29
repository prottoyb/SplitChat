import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// prod.mjs refuses a file whose digest differs from its pinned value, but only
// when the operator runs it. These tests catch a committed migration, check or
// expected schema that no longer matches its pin in CI, long before that.
// prod.mjs runs on import, so its manifest is read as text.
const root = path.resolve(import.meta.dirname, '..', '..')
const source = fs.readFileSync(path.join(root, 'scripts', 'ops', 'prod.mjs'), 'utf8')
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).digest('hex')

const migrationPins = [...source.matchAll(/^\s*'(\d{14}_[a-z0-9_]+\.sql)': '([0-9a-f]{64})',$/gm)].map((m) => [m[1], m[2]])
const opsPins = [...source.matchAll(/\['([a-z0-9_./]+\.sql)', '([0-9a-f]{64})'\]/g)].map((m) => [m[1], m[2]])

describe('prod.mjs manifest', () => {
  it('pins every migration in supabase/migrations, in order, with its current digest', () => {
    const files = fs.readdirSync(path.join(root, 'supabase', 'migrations')).filter((f) => f.endsWith('.sql')).sort()
    expect(migrationPins.map(([f]) => f)).toEqual(files)
    for (const [file, digest] of migrationPins) {
      expect(sha256(path.join(root, 'supabase', 'migrations', file)), file).toBe(digest)
    }
  })

  it('pins every expected schema with its current digest', () => {
    expect(opsPins.length).toBeGreaterThan(0)
    for (const [file, digest] of opsPins) {
      expect(sha256(path.join(root, 'supabase', 'ops', file)), file).toBe(digest)
    }
  })

  it('defines batch5 as exactly M24 and M25 on top of the 25 batch 4 versions', () => {
    const batch5 = /batch5: \{([\s\S]*?)\n {2}\},/.exec(source)?.[1] ?? ''
    expect(batch5).toContain('migrations: pick(27)')
    expect(batch5).toContain('preflightHistory: versions(25)')
    expect(batch5).toContain('startHistory: versions(25)')
    expect(batch5).toContain("before: ['batch4_expected_schema.sql'")
    expect(batch5).toContain("zeroChecks: ['Q4', 'Q5', 'Q23', 'Q24', 'Q25', 'Q26', 'Q27', 'Q28']")
    expect(migrationPins.slice(25).map(([f]) => f)).toEqual([
      '20261001100000_group_details.sql',
      '20261001110000_profile_name_rules.sql',
    ])
  })

  it('batch5 pre-checks define every zero-check, including the M25 compatibility count', () => {
    const sql = fs.readFileSync(path.join(root, 'supabase', 'ops', 'batch5_prechecks.sql'), 'utf8')
    for (const q of ['Q4', 'Q5', 'Q23', 'Q24', 'Q25', 'Q26', 'Q27', 'Q28']) expect(sql).toMatch(new RegExp(`SELECT '${q} `))
    expect(sql).toContain("lower(regexp_replace(full_name, '\\s+', ' ', 'g')) <> 'deleted user'")
  })
})
