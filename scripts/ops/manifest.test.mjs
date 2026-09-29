import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BATCHES, M } from './prod.mjs'

// prod.mjs refuses a file whose digest differs from its pinned value, but only
// when the operator runs it. These tests catch, in CI, a committed migration or
// expected schema that no longer matches its pin, and a batch whose pre-checks
// lack one of its zero-checks. A new migration fails the first test until it
// is reviewed into a batch in prod.mjs: that is intended, do not loosen it.
const root = path.resolve(import.meta.dirname, '..', '..')
const OPS = path.join(root, 'supabase', 'ops')
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).digest('hex')
const version = (f) => f.slice(0, 14)

describe('prod.mjs manifest', () => {
  it('pins every migration in supabase/migrations, in order, with its current digest', () => {
    const files = fs.readdirSync(path.join(root, 'supabase', 'migrations')).filter((f) => f.endsWith('.sql')).sort()
    expect(Object.keys(M)).toEqual(files)
    for (const [file, digest] of Object.entries(M)) {
      expect(sha256(path.join(root, 'supabase', 'migrations', file)), file).toBe(digest)
    }
  })

  for (const [id, b] of Object.entries(BATCHES)) {
    describe(id, () => {
      it('pins its before and expected schemas with their current digests', () => {
        for (const [file, digest] of [b.before, b.expectedSchema]) {
          expect(sha256(path.join(OPS, file)), file).toBe(digest)
        }
      })

      it('uses migrations from the manifest with their pinned digests', () => {
        for (const [file, digest] of Object.entries(b.migrations)) expect(M[file], file).toBe(digest)
      })

      it('defines every zero-check in its pre-checks, and names its post-checks', () => {
        const pre = fs.readFileSync(path.join(OPS, b.prechecks), 'utf8')
        for (const q of b.zeroChecks) expect(pre, q).toMatch(new RegExp(`SELECT '${q} `))
        expect(fs.existsSync(path.join(OPS, b.postchecks))).toBe(true)
      })
    })
  }

  it('batch5 is exactly M24 and M25 on top of the 25 batch 4 versions, starting from the batch 4 schema', () => {
    const b4 = BATCHES.batch4
    const b5 = BATCHES.batch5
    const added = Object.keys(b5.migrations).filter((f) => !(f in b4.migrations))
    expect(added).toEqual(['20261001100000_group_details.sql', '20261001110000_profile_name_rules.sql'])
    expect(Object.keys(b4.migrations).every((f) => f in b5.migrations)).toBe(true)
    expect(b5.startHistory).toEqual(Object.keys(b4.migrations).map(version))
    expect(b5.preflightHistory).toEqual(b5.startHistory)
    expect(b5.startHistory).toHaveLength(25)
    expect(b5.before).toEqual(b4.expectedSchema)
    expect(b5.zeroChecks).toEqual(expect.arrayContaining(['Q4', 'Q5', 'Q23']))
  })

  it('batch5 Q23 is the M25 compatibility count: the rule of the M25 constraint, for live profiles', () => {
    const pre = fs.readFileSync(path.join(OPS, 'batch5_prechecks.sql'), 'utf8')
    const q23 = pre.slice(pre.indexOf("SELECT 'Q23 "), pre.indexOf("SELECT 'Q24 "))
    expect(q23).toContain('WHERE deleted_at IS NULL')
    expect(q23).toContain('full_name = btrim(full_name)')
    expect(q23).toContain('char_length(full_name) BETWEEN 1 AND 80')
    expect(q23).toContain("lower(regexp_replace(full_name, '\\s+', ' ', 'g')) <> 'deleted user'")
  })
})
