/**
 * ADR-0008 boundaries, checked on src/ (no lint plugin needed; runs in npm test):
 * 1. only shared/api, features/<f>/api and features/<f>/realtime import the
 *    Supabase client;
 * 2. a feature imports another feature only through its index.ts, and only
 *    in the allowed direction (no cycles);
 * 4. no float arithmetic on money outside shared/domain/money.ts.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')
const CLIENT = path.join(SRC, 'shared', 'api', 'supabase.ts')

// Lower layers first; a feature may import only features listed before it.
const FEATURE_ORDER = ['auth', 'people', 'groups', 'expenses', 'balances', 'settlements', 'dashboard', 'activity', 'chat', 'smart-expense']

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [full] : []
  })
}

function importsOf(file) {
  const text = fs.readFileSync(file, 'utf8')
  return [...text.matchAll(/(?:import|export)\s[^'"]*?from\s+['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)]
    .map((m) => m[1] ?? m[2])
}

function resolve(file, spec) {
  const base = path.resolve(path.dirname(file), spec)
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  return base
}

const rel = (p) => path.relative(SRC, p).split(path.sep).join('/')
const featureOf = (p) => /^features\/([^/]+)\//.exec(rel(p))?.[1] ?? null
const files = sourceFiles(SRC)

describe('architecture (ADR-0008)', () => {
  it('only API modules import the Supabase client', () => {
    const offenders = files
      .filter((file) => importsOf(file).some((spec) => resolve(file, spec) === CLIENT))
      .map(rel)
      .filter((f) => !/^shared\/api\//.test(f) && !/^features\/[^/]+\/(api|realtime)\//.test(f))

    expect(offenders).toEqual([])
  })

  it('features import other features only through their index, in the allowed direction', () => {
    const offenders = []
    for (const file of files) {
      const from = featureOf(file)
      if (!from) continue
      for (const spec of importsOf(file)) {
        const target = resolve(file, spec)
        const to = featureOf(target)
        if (!to || to === from) continue
        if (!/^features\/[^/]+\/index\.tsx?$/.test(rel(target))) offenders.push(`${rel(file)} -> ${rel(target)} (not the public index)`)
        if (FEATURE_ORDER.indexOf(to) >= FEATURE_ORDER.indexOf(from)) offenders.push(`${rel(file)} -> ${to} (wrong direction)`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('does no float arithmetic on money outside the money module', () => {
    const suspicious = /\.toFixed\(|\bparseFloat\(|[*/]\s*100\b(?!\d)|\bcentsToAmount\b/
    const offenders = files
      .filter((file) => !rel(file).startsWith('shared/domain/money'))
      .filter((file) => suspicious.test(fs.readFileSync(file, 'utf8')))
      .map(rel)

    expect(offenders).toEqual([])
  })

  it('checks a meaningful number of files', () => {
    expect(files.length).toBeGreaterThan(30)
  })
})
