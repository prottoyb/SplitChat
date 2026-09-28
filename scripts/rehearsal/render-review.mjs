#!/usr/bin/env node
// Rendered UI review on SplitChat-Dev: seeds realistic synthetic data, runs
// the Vite dev server pointed at SplitChat-Dev (process env beats .env.local,
// which targets PRODUCTION), and captures full-page screenshots in headless
// Chrome over the DevTools protocol at desktop, tablet and mobile widths.
//
// Fail closed: every browser request is intercepted; only the local Vite
// origin and the SplitChat-Dev project are allowed, anything else (production
// above all) is blocked and makes the run fail.
//
//   node scripts/rehearsal/render-review.mjs <out-dir> [--routes <file.json>]
//
// A routes file is a JSON array of { name, path, expectVisible? } where path
// may use {flat}, {trip}, {solo} and {missing}, and expectVisible is a CSS
// selector reported as visible or not within the first viewport. Without one, the Phase 5 set is used.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createClient } from '@supabase/supabase-js'
import { openBrowser, startApp } from './browser.mjs'
import { PROD_REF, loadDevTarget, verifySentinel } from './dev.mjs'

const [outDir, ...rest] = process.argv.slice(2)
if (!outDir) throw new Error('usage: render-review.mjs <out-dir> [--routes file.json]')
const routesFile = rest[0] === '--routes' ? rest[1] : null
const PORT = 5199
const WIDTHS = [
  { label: 'desktop', width: 1440, height: 900, mobile: false },
  { label: 'tablet', width: 900, height: 1100, mobile: false },
  { label: 'mobile', width: 390, height: 844, mobile: true },
]

const t = loadDevTarget()
verifySentinel(t)
fs.mkdirSync(outDir, { recursive: true })

// ---- Seed -------------------------------------------------------------------
const run = Date.now()
const password = crypto.randomBytes(18).toString('base64url') + 'Aa9!'
const email = (k) => `splitchat-rehearsal+ui-${k}-${run}@example.com`
const admin = createClient(t.url, t.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

async function user(key, name) {
  const { data, error } = await admin.auth.admin.createUser({ email: email(key), password, email_confirm: true, user_metadata: { full_name: name } })
  if (error) throw new Error(`create ${key}: ${error.message}`)
  const client = createClient(t.url, t.anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const s = await client.auth.signInWithPassword({ email: email(key), password })
  if (s.error) throw new Error(`sign in ${key}: ${s.error.message}`)
  return { id: data.user.id, key, client, session: s.data.session }
}

const must = (r, what) => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`)
  return r.data
}

async function group(owner, name, description, members) {
  must(await owner.client.from('groups').insert({ name, description, created_by: owner.id }), `group ${name}`)
  const id = must(await owner.client.from('groups').select('id').eq('name', name).limit(1), 'group id')[0].id
  for (const m of members) must(await owner.client.rpc('add_group_member_by_email', { target_group_id: id, target_email: email(m.key) }), 'add member')
  return id
}

const expense = async (by, groupId, description, cents, date, participants, notes = null) =>
  must(
    await by.client.rpc('create_equal_split_expense_v2', {
      p_group_id: groupId, p_description: description, p_amount_cents: cents, p_expense_date: date,
      p_paid_by: by.id, p_participant_ids: participants.map((p) => p.id), p_notes: notes,
    }),
    `expense ${description}`,
  )

const me = await user('priya', 'Priya Raman')
const alex = await user('alex', 'Alexander Montgomery-Whitfield')
const sam = await user('sam', 'Sam Lee')
const jo = await user('jo', 'Jo Nguyen')

const flat = await group(me, `Flat 4B ${run % 1000}`, 'Rent, bills and groceries for the Brunswick St house', [alex, sam, jo])
const all = [me, alex, sam, jo]
await expense(me, flat, 'September rent', 240000, '2026-09-01', all)
await expense(sam, flat, 'Electricity (Aug–Sep)', 18745, '2026-09-12', all)
await expense(jo, flat, 'Groceries', 9630, '2026-09-20', all, 'Big shop at the market, incl. cleaning stuff')
await expense(alex, flat, 'Internet — NBN 100 plan for September, including the modem rental that we agreed to split', 8999, '2026-09-22', [me, alex, sam])
must(await sam.client.rpc('record_settlement', {
  p_group_id: flat, p_from_user: sam.id, p_to_user: me.id, p_amount_cents: 30000, p_settled_on: '2026-09-25',
  p_note: 'Bank transfer', p_client_request_id: crypto.randomUUID(),
}), 'settlement')

const trip = await group(alex, `Byron Bay long weekend with the extended uni crew ${run % 1000}`, null, [me, sam])
await expense(alex, trip, 'Airbnb', 123456, '2026-09-26', [me, alex, sam])
await expense(sam, trip, 'Fuel', 8420, '2026-09-26', [me, alex, sam])

const solo = await group(me, `Solo budget ${run % 1000}`, null, [])

// Chat (M18): a realistic short conversation in the flat.
const say = async (who, text) =>
  must(await who.client.rpc('send_group_message', { p_group_id: flat, p_body: text, p_client_request_id: crypto.randomUUID() }), 'message')
if (!process.env.RENDER_SKIP_CHAT) {
  await say(sam, 'Electricity bill came in — $187.45 for Aug–Sep. I paid it, added it just now.')
  await say(jo, 'Thanks Sam!')
  await say(jo, 'Also did the big shop today, $96.30')
  await say(me, 'Rent is paid for September 👍')
  await say(alex, 'Can we talk about the internet plan? I think we should switch to the NBN 100 plan because the current one keeps dropping out in the evenings when everyone is streaming. It is $89.99 a month including the modem rental, so about $30 each if the three of us who use it most split it.\n\nThoughts?')
  await say(sam, 'Works for me')
  await say(me, 'Sounds good, go for it')

  // Smart Expense (M19): proposals in each state, as the senders' clients
  // would have proposed them.
  const propose = async (who, body, draft) => {
    const msg = await say(who, body)
    return must(await who.client.rpc('propose_expense_candidate', {
      p_message_id: msg.id, p_source: body.startsWith('/') ? 'command' : 'natural', p_interpreter_version: 'deterministic-1',
      p_description: draft.description ?? null, p_amount_cents: draft.cents ?? null, p_expense_date: draft.date ?? null,
      p_paid_by: draft.paidBy ?? null, p_participant_ids: draft.participants ?? null, p_notes: null,
    }), 'proposal')
  }
  const d = new Date()
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const cleaning = await propose(jo, 'I paid $25 for cleaning supplies, split with everyone',
    { description: 'cleaning supplies', cents: 2500, date: today, paidBy: jo.id, participants: all.map((u) => u.id) })
  must(await jo.client.rpc('approve_expense_candidate', { p_id: cleaning.id, p_expected_version: 1 }), 'approve')
  await propose(sam, '/expense 18.50 Parking paid:me', { description: 'Parking', cents: 1850, date: today, paidBy: sam.id })
  await propose(me, 'I paid $42 for pizza, split with everyone',
    { description: 'pizza', cents: 4200, date: today, paidBy: me.id, participants: all.map((u) => u.id) })
}

const ids = { flat, trip, solo, missing: crypto.randomUUID() }
const defaultRoutes = [
  { name: 'dashboard', path: '/' },
  { name: 'flat-overview', path: '/groups/{flat}' },
  { name: 'flat-expenses', path: '/groups/{flat}/expenses' },
  { name: 'flat-balances', path: '/groups/{flat}/balances' },
  { name: 'flat-activity', path: '/groups/{flat}/activity' },
  { name: 'flat-members', path: '/groups/{flat}/members' },
  { name: 'flat-chat', path: '/groups/{flat}/chat' },
  { name: 'solo-chat', path: '/groups/{solo}/chat' },
  { name: 'trip-overview', path: '/groups/{trip}' },
  { name: 'trip-members', path: '/groups/{trip}/members' },
  { name: 'solo-overview', path: '/groups/{solo}' },
  { name: 'solo-expenses', path: '/groups/{solo}/expenses' },
  { name: 'add-expense', path: '/groups/{flat}/expenses/new' },
  { name: 'missing-group', path: '/groups/{missing}' },
  { name: 'login', path: '/login?signed-out' },
]
const routes = (routesFile ? JSON.parse(fs.readFileSync(routesFile, 'utf8')) : defaultRoutes).map((r) => ({
  ...r,
  path: r.path.replace(/\{(\w+)\}/g, (_, k) => ids[k] ?? k),
}))

// ---- Render (shared driver: SplitChat-Dev only, fail-closed requests) -------
const app = await startApp(t, PORT)
const page = await openBrowser({ allowedOrigins: [app.origin, new URL(t.url).origin] })
let exitCode = 0
try {
  // Sign in by storing the dev session where supabase-js looks for it.
  await page.goto(`${app.origin}/login`)
  await page.evaluate(`localStorage.setItem(${JSON.stringify(`sb-${t.ref}-auth-token`)}, ${JSON.stringify(JSON.stringify(me.session))})`)

  for (const size of WIDTHS) {
    await page.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: size.mobile })
    for (const route of routes) {
      await page.goto(app.origin + route.path)
      // Wait for data: no spinner and no "Checking…" left, up to 15 s.
      await page
        .waitFor(`!document.querySelector('[aria-busy="true"]') && !document.body.innerText.includes('Checking')`, 15000)
        .catch(() => {})
      await sleep(500)
      // Optional: is this element fully inside the viewport as the user first
      // sees it (before the full-page capture below)?
      let visibility = ''
      if (route.expectVisible) {
        const v = await page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(route.expectVisible)}); if (!el) return 'missing';
          const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight ? 'visible' : 'NOT VISIBLE (top ' + Math.round(r.top) + ', bottom ' + Math.round(r.bottom) + ', viewport ' + window.innerHeight + ')' })()`)
        visibility = `  [${route.expectVisible}: ${v}]`
      }
      const file = path.join(outDir, `${route.name}-${size.label}.png`)
      await page.screenshot(file)
      const overflow = await page.evaluate('document.documentElement.scrollWidth > window.innerWidth')
      console.log(`${file}${overflow ? '  (HORIZONTAL OVERFLOW)' : ''}${visibility}`)
    }
  }
} catch (error) {
  console.error(error)
  exitCode = 1
} finally {
  await page.close()
  app.stop()
}

if (page.violations.length) {
  console.error(`FAIL: ${page.violations.length} request(s) outside SplitChat-Dev and the local app were blocked:`)
  for (const url of page.violations) console.error(`  ${new URL(url).origin.replaceAll(PROD_REF, '<production-ref>')}`)
  exitCode = 1
} else {
  console.log('Only the local app and SplitChat-Dev were reached (no request to production or elsewhere).')
}
process.exit(exitCode)
