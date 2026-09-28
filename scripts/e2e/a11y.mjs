#!/usr/bin/env node
// Rendered accessibility audit (WCAG 2.1 AA-oriented) of SplitChat's key
// screens in real Chrome on SplitChat-Dev, at desktop and mobile widths:
//   - names: every interactive element has an accessible name (Chrome's own
//     accessibility tree, as screen readers get it);
//   - keyboard: Tab reaches controls in order, and every focus stop shows a
//     visible indicator (outline or box-shadow differs from the unfocused state);
//   - contrast: visible text meets 4.5:1 (3:1 for large text) against its
//     effective background;
//   - structure: <html lang>, a main landmark, labelled navigation, no
//     skipped heading levels.
// Reports every finding; exits 1 if any exist.
//
//   node scripts/e2e/a11y.mjs [--json <file>]

import crypto from 'node:crypto'
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { loadDevTarget, verifySentinel } from '../rehearsal/dev.mjs'
import { openBrowser, startApp } from '../rehearsal/browser.mjs'

const args = process.argv.slice(2)
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null
const t = loadDevTarget()
verifySentinel(t)
const run = Date.now()
const password = crypto.randomBytes(18).toString('base64url') + 'Aa9!'
const email = (k) => `splitchat-rehearsal+a11y-${k}-${run}@example.com`
const admin = createClient(t.url, t.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
const must = (r, what) => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`)
  return r.data
}
async function user(key, name) {
  const { data, error } = await admin.auth.admin.createUser({ email: email(key), password, email_confirm: true, user_metadata: { full_name: name } })
  if (error) throw new Error(`create ${key}: ${error.message}`)
  const client = createClient(t.url, t.anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const s = await client.auth.signInWithPassword({ email: email(key), password })
  if (s.error) throw new Error(`sign in ${key}: ${s.error.message}`)
  return { id: data.user.id, key, client, session: s.data.session }
}

// Fixture: a group with an expense, a payment, a chat message and an open proposal.
const me = await user('priya', 'Priya Raman')
const sam = await user('sam', 'Sam Lee')
const name = `A11y flat ${run % 100000}`
must(await me.client.from('groups').insert({ name, description: 'Rent and bills', created_by: me.id }), 'group')
const groupId = must(await me.client.from('groups').select('id').eq('name', name).limit(1), 'group id')[0].id
must(await me.client.rpc('add_group_member_by_email', { target_group_id: groupId, target_email: email('sam') }), 'add')
const d = new Date()
const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const expenseId = must(await me.client.rpc('create_equal_split_expense_v2', {
  p_group_id: groupId, p_description: 'Groceries', p_amount_cents: 9630, p_expense_date: today,
  p_paid_by: me.id, p_participant_ids: [me.id, sam.id], p_notes: 'Weekly shop',
}), 'expense')
must(await sam.client.rpc('record_settlement', { p_group_id: groupId, p_from_user: sam.id, p_to_user: me.id, p_amount_cents: 1000, p_settled_on: today, p_note: null, p_client_request_id: crypto.randomUUID() }), 'payment')
must(await sam.client.rpc('send_group_message', { p_group_id: groupId, p_body: 'Groceries are in the fridge', p_client_request_id: crypto.randomUUID() }), 'message')
const msg = must(await me.client.rpc('send_group_message', { p_group_id: groupId, p_body: 'I paid $30 for dinner, split with everyone', p_client_request_id: crypto.randomUUID() }), 'message 2')
const cand = must(await me.client.rpc('propose_expense_candidate', {
  p_message_id: msg.id, p_source: 'natural', p_interpreter_version: 'deterministic-1', p_description: 'dinner', p_amount_cents: 3000,
  p_expense_date: today, p_paid_by: me.id, p_participant_ids: [me.id, sam.id], p_notes: null,
}), 'proposal')

const g = `/groups/${groupId}`
const PAGES = [
  ['login (signed out)', '/login', false],
  ['dashboard', '/', true],
  ['groups', '/groups', true],
  ['group overview', g, true],
  ['group expenses', `${g}/expenses`, true],
  ['group balances', `${g}/balances`, true],
  ['group chat', `${g}/chat`, true],
  ['group activity', `${g}/activity`, true],
  ['group members', `${g}/members`, true],
  ['expense details', `/expenses/${expenseId}`, true],
  ['new expense', `${g}/expenses/new`, true],
  ['edit proposal', `${g}/proposals/${cand.id}/edit`, true],
]

// In-page checks (contrast, focus indicator, structure).
const PAGE_CHECKS = String.raw`(() => {
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(',').map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 } }
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
  const blend = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 })
  const bgOf = (el) => { const layers = []; for (let n = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break } }
    let bg = { r: 255, g: 255, b: 255, a: 1 }; for (const l of layers.reverse()) bg = blend(l, bg); return bg }
  const findings = []
  const seen = new Set()
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const node = walker.currentNode; const text = node.textContent.trim(); if (!text) continue
    const el = node.parentElement; if (!el || seen.has(el)) continue; seen.add(el)
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el)
    if (!r.width || !r.height || cs.visibility === 'hidden' || cs.display === 'none' || el.closest('[aria-hidden="true"]')) continue
    if (el.closest('input,textarea,select') || (el.matches(':disabled') || el.closest(':disabled'))) continue
    const fg = parse(cs.color); if (!fg) continue
    const bg = bgOf(el); const fgb = blend(fg, bg)
    const L1 = lum(fgb), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)
    const size = parseFloat(cs.fontSize); const bold = parseInt(cs.fontWeight, 10) >= 700
    const large = size >= 24 || (bold && size >= 18.66)
    if (ratio < (large ? 3 : 4.5)) findings.push({ kind: 'contrast', text: text.slice(0, 40), ratio: Math.round(ratio * 100) / 100, need: large ? 3 : 4.5, color: cs.color, size })
  }
  if (!document.documentElement.lang) findings.push({ kind: 'structure', text: 'html has no lang' })
  if (!document.querySelector('main')) findings.push({ kind: 'structure', text: 'no main landmark' })
  for (const nav of document.querySelectorAll('nav')) if (document.querySelectorAll('nav').length > 1 && !nav.getAttribute('aria-label') && !nav.getAttribute('aria-labelledby')) findings.push({ kind: 'structure', text: 'unlabelled nav among several' })
  let last = 0
  for (const h of document.querySelectorAll('h1,h2,h3,h4,h5,h6')) { const lv = +h.tagName[1]; if (last && lv > last + 1) findings.push({ kind: 'headings', text: 'skips from h' + last + ' to h' + lv + ': ' + h.textContent.trim().slice(0, 40) }); last = lv }
  return findings
})()`

const FOCUS_STYLE = `(() => { const el = document.activeElement; if (!el || el === document.body) return null; const cs = getComputedStyle(el);
  const p = el.parentElement ? getComputedStyle(el.parentElement) : null
  return { name: (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.tagName).trim().slice(0, 40), outline: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0, shadow: cs.boxShadow !== 'none', border: cs.borderColor, bg: cs.backgroundColor, tag: el.tagName,
    parent: p ? p.boxShadow + '|' + p.borderColor + '|' + p.outlineStyle : '' } })()`

const app = await startApp(t, 5196)
const allowedOrigins = [app.origin, new URL(t.url).origin]
const report = []
let pages = []
for (const [label, width, height, mobile] of [['desktop', 1280, 900, false], ['mobile', 390, 844, true]]) {
  const page = await openBrowser({ allowedOrigins, width, height, mobile })
  pages.push(page)
  for (const [pageName, path, signedIn] of PAGES) {
    await page.goto(`${app.origin}/login`)
    await page.evaluate(signedIn ? `localStorage.setItem(${JSON.stringify(`sb-${t.ref}-auth-token`)}, ${JSON.stringify(JSON.stringify(me.session))})` : 'localStorage.clear()')
    await page.goto(app.origin + path)
    await page.waitFor(`!document.querySelector('[aria-busy="true"]')`, 15000).catch(() => {})
    await new Promise((r) => setTimeout(r, 800))
    const findings = []

    // Names, from Chrome's accessibility tree.
    await page.send('DOM.getDocument', { depth: 0 })
    const { nodes } = await page.send('Accessibility.getFullAXTree')
    const INTERACTIVE = new Set(['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'searchbox', 'spinbutton', 'tab', 'menuitem', 'switch'])
    for (const n of nodes) {
      if (n.ignored || !INTERACTIVE.has(n.role?.value)) continue
      if (!String(n.name?.value ?? '').trim()) {
        const html = n.backendDOMNodeId
          ? (await page.send('DOM.getOuterHTML', { backendNodeId: n.backendDOMNodeId }).catch(() => ({ outerHTML: '' }))).outerHTML
          : ''
        findings.push({ kind: 'name', text: `${n.role.value} without an accessible name: ${html.replace(/\s+/g, ' ').slice(0, 120)}` })
      }
    }

    findings.push(...(await page.evaluate(PAGE_CHECKS)))

    // Touch targets on phones: buttons at least 44px tall (inline text links exempt).
    if (mobile) {
      const small = await page.evaluate(`[...document.querySelectorAll('button, [role="button"], .primary-button, .secondary-button')]
        .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && r.height < 43.5 })
        .map((el) => (el.getAttribute('aria-label') || el.innerText || '').trim().slice(0, 30) + ' ' + Math.round(el.getBoundingClientRect().height) + 'px')`)
      for (const s of small) findings.push({ kind: 'target', text: `touch target under 44px: ${s}` })
    }

    // Keyboard: Tab through up to 40 stops; each must show a focus indicator.
    await page.evaluate('document.activeElement?.blur(); window.scrollTo(0, 0)')
    const stops = []
    for (let i = 0; i < 40; i++) {
      await page.press('Tab')
      const focused = await page.evaluate(FOCUS_STYLE)
      if (!focused) break
      // Compare with the element's unfocused look (blur, read, refocus).
      const plain = await page.evaluate(`(() => { const el = document.activeElement; el.blur(); const cs = getComputedStyle(el); const p = el.parentElement ? getComputedStyle(el.parentElement) : null;
        const s = { border: cs.borderColor, bg: cs.backgroundColor, shadow: cs.boxShadow !== 'none', parent: p ? p.boxShadow + '|' + p.borderColor + '|' + p.outlineStyle : '' }; el.focus(); return s })()`)
      // A wrapper's :focus-within ring counts (e.g. the amount field's "$" box).
      const indicated = focused.outline || (focused.shadow && !plain.shadow) || focused.border !== plain.border || focused.bg !== plain.bg || focused.parent !== plain.parent
      if (!indicated) findings.push({ kind: 'focus', text: `no visible focus indicator on ${focused.tag} "${focused.name}"` })
      stops.push(focused.name)
      if (stops.length > 3 && stops.at(-1) === stops[0]) break
    }
    if (stops.length === 0) findings.push({ kind: 'keyboard', text: 'Tab reaches no control' })

    const unique = [...new Map(findings.map((f) => [JSON.stringify(f), f])).values()]
    report.push({ page: pageName, width: label, stops: stops.length, findings: unique })
    console.log(`${unique.length ? 'FIND' : 'PASS'}  ${pageName} (${label}): ${stops.length} tab stops, ${unique.length} findings`)
    for (const f of unique.slice(0, 12)) console.log(`      ${f.kind}: ${f.text}${f.ratio ? ` (${f.ratio}:1, needs ${f.need}:1, ${f.color}, ${f.size}px)` : ''}`)
  }
}
for (const p of pages) await p.close()
app.stop()
const violations = pages.flatMap((p) => p.violations)
if (violations.length) console.log(`FAIL  blocked requests outside localhost/Dev: ${violations.length}`)
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2))
const total = report.reduce((n, r) => n + r.findings.length, 0)
console.log(`\n${report.length} page views, ${total} findings`)
process.exit(total || violations.length ? 1 : 0)
