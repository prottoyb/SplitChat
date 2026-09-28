/**
 * Design tokens (docs/phase9/design-system.md): colours are defined once on
 * :root in src/index.css and used through var(--token). A raw hex colour in
 * any other stylesheet fails this test, except the documented exceptions
 * below.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

// Documented exceptions (design-system.md): mask gradients use pure black
// as an alpha stop; the auth hero is its own dark surface; activity icon
// chips use categorical colours that are not status colours.
const ALLOWED = {
  'app/App.css': ['#000'],
  'app/workspace/GroupWorkspace.module.css': ['#000'],
  'features/auth/AuthPage.module.css': ['#11131a', '#191b23', '#292c36', '#7357ff', '#a8afbc', '#a999ff', '#aeb3c2', '#b8bec9'],
  'features/activity/components/activity.module.css': ['#1f5f8b', '#8a5a00', '#e6f1fa', '#eaf7ef', '#fff4dc'],
}

function stylesheets(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return stylesheets(full)
    return entry.name.endsWith('.css') ? [full] : []
  })
}

describe('design tokens', () => {
  it('uses no raw hex colours outside :root and the documented exceptions', () => {
    const offenders = []
    for (const file of stylesheets(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join('/')
      if (rel === 'index.css') continue
      const allowed = new Set(ALLOWED[rel] ?? [])
      const text = fs.readFileSync(file, 'utf8')
      for (const [hex] of text.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        if (!allowed.has(hex.toLowerCase())) offenders.push(`${rel}: ${hex}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('defines every token that a stylesheet uses', () => {
    const root = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8')
    const defined = new Set([...root.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]))
    const missing = new Set()
    for (const file of stylesheets(SRC)) {
      for (const [, name] of fs.readFileSync(file, 'utf8').matchAll(/var\((--[a-z0-9-]+)/g)) {
        if (!defined.has(name)) missing.add(name)
      }
    }
    expect([...missing]).toEqual([])
  })
})
