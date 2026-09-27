#!/usr/bin/env node
// Rendered UI review on SplitChat-Dev: seeds realistic synthetic data, runs
// the Vite dev server pointed at SplitChat-Dev (process env beats .env.local,
// which targets PRODUCTION), and captures full-page screenshots in headless
// Chrome over the DevTools protocol at desktop, tablet and mobile widths.
//
// Fail closed: every browser request is intercepted and any request to the
// production project is blocked and makes the run fail.
//
//   node scripts/rehearsal/render-review.mjs <out-dir> [--routes <file.json>]
//
// A routes file is a JSON array of { name, path } where path may use
// {flat}, {trip}, {solo} and {missing}. Without one, the Phase 5 set is used.

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createClient } from '@supabase/supabase-js'
import { loadDevTarget, PROD_REF, verifySentinel } from './dev.mjs'

const [outDir, ...rest] = process.argv.slice(2)
if (!outDir) throw new Error('usage: render-review.mjs <out-dir> [--routes file.json]')
const routesFile = rest[0] === '--routes' ? rest[1] : null
const CHROME = process.env.SPLITCHAT_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
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

const ids = { flat, trip, solo, missing: crypto.randomUUID() }
const defaultRoutes = [
  { name: 'dashboard', path: '/' },
  { name: 'flat-overview', path: '/groups/{flat}' },
  { name: 'flat-expenses', path: '/groups/{flat}/expenses' },
  { name: 'flat-balances', path: '/groups/{flat}/balances' },
  { name: 'flat-activity', path: '/groups/{flat}/activity' },
  { name: 'flat-members', path: '/groups/{flat}/members' },
  { name: 'trip-overview', path: '/groups/{trip}' },
  { name: 'trip-members', path: '/groups/{trip}/members' },
  { name: 'solo-overview', path: '/groups/{solo}' },
  { name: 'solo-expenses', path: '/groups/{solo}/expenses' },
  { name: 'add-expense', path: '/groups/{flat}/expenses/new' },
  { name: 'missing-group', path: '/groups/{missing}' },
]
const routes = (routesFile ? JSON.parse(fs.readFileSync(routesFile, 'utf8')) : defaultRoutes).map((r) => ({
  ...r,
  path: r.path.replace(/\{(\w+)\}/g, (_, k) => ids[k] ?? k),
}))

// ---- Vite (SplitChat-Dev env only) -----------------------------------------
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(PORT), '--strictPort'], {
  env: { ...process.env, VITE_SUPABASE_URL: t.url, VITE_SUPABASE_PUBLISHABLE_KEY: t.anonKey },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let viteOut = ''
vite.stdout.on('data', (d) => (viteOut += d))
vite.stderr.on('data', (d) => (viteOut += d))

// ---- Chrome over CDP --------------------------------------------------------
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'splitchat-render-'))
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' })

const violations = []
let exitCode = 0
try {
  for (let i = 0; !viteOut.replace(/\x1b\[[0-9;]*m/g, '').includes('Local:'); i++) {
    if (i > 100) throw new Error(`vite did not start:\n${viteOut}`)
    await sleep(200)
  }
  const portFile = path.join(profile, 'DevToolsActivePort')
  for (let i = 0; !fs.existsSync(portFile); i++) {
    if (i > 100) throw new Error('chrome did not start')
    await sleep(100)
  }
  const cdpPort = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim()
  const target = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' })).json()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  let nextId = 0
  const pending = new Map()
  const listeners = []
  ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data)
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id)
      pending.delete(data.id)
      return data.error ? reject(new Error(data.error.message)) : resolve(data.result)
    }
    for (const l of listeners) l(data)
  }
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })

  // Fail closed on production; everything else continues.
  listeners.push((event) => {
    if (event.method !== 'Fetch.requestPaused') return
    const { requestId, request } = event.params
    if (request.url.includes(PROD_REF)) {
      violations.push(request.url)
      void send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' })
    } else {
      void send('Fetch.continueRequest', { requestId })
    }
  })
  await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] })
  await send('Page.enable')
  await send('Runtime.enable')

  const origin = `http://localhost:${PORT}`
  // Sign in by storing the dev session where supabase-js looks for it.
  await send('Page.navigate', { url: `${origin}/login` })
  await sleep(2500)
  const storageKey = `sb-${t.ref}-auth-token`
  await send('Runtime.evaluate', { expression: `localStorage.setItem(${JSON.stringify(storageKey)}, ${JSON.stringify(JSON.stringify(me.session))})` })

  for (const size of WIDTHS) {
    await send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: size.mobile })
    for (const route of routes) {
      await send('Page.navigate', { url: origin + route.path })
      // Wait for data: no spinner and no "Checking…" left, up to 15 s.
      for (let i = 0; i < 60; i++) {
        await sleep(250)
        const busy = await send('Runtime.evaluate', {
          expression: `!!document.querySelector('[aria-busy="true"]') || document.body.innerText.includes('Checking')`,
          returnByValue: true,
        })
        if (i > 3 && !busy.result.value) break
      }
      await sleep(300)
      const { result } = await send('Runtime.evaluate', { expression: 'document.documentElement.scrollHeight', returnByValue: true })
      const { data } = await send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: size.width, height: Math.min(result.value, 6000), scale: 1 },
      })
      const file = path.join(outDir, `${route.name}-${size.label}.png`)
      fs.writeFileSync(file, Buffer.from(data, 'base64'))
      const overflow = await send('Runtime.evaluate', {
        expression: 'document.documentElement.scrollWidth > window.innerWidth',
        returnByValue: true,
      })
      console.log(`${file}${overflow.result.value ? '  (HORIZONTAL OVERFLOW)' : ''}`)
    }
  }
  ws.close()
} catch (error) {
  console.error(error)
  exitCode = 1
} finally {
  chrome.kill()
  vite.kill()
  await sleep(500)
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 })
}

if (violations.length) {
  console.error(`FAIL: ${violations.length} request(s) to the production project were blocked`)
  exitCode = 1
} else {
  console.log('No request reached the production project.')
}
process.exit(exitCode)
