#!/usr/bin/env node
// End-to-end tests of SplitChat's critical journeys, in real headless Chrome
// against the real app and SplitChat-Dev (Auth, PostgREST, RPCs, Realtime).
// Never production: the shared driver serves the app with SplitChat-Dev
// settings and blocks every request outside localhost and SplitChat-Dev.
//
// Tests assert what a person sees and can do (text, roles, accessible
// names), not pixels or CSS. Fresh synthetic users and a fresh group per run.
//
//   node scripts/e2e/e2e.mjs [--artifacts <dir>]   (screenshots on failure)

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { PROD_REF, loadDevTarget, verifySentinel } from '../rehearsal/dev.mjs'
import { openBrowser, startApp } from '../rehearsal/browser.mjs'

const args = process.argv.slice(2)
const artifacts = args.includes('--artifacts') ? args[args.indexOf('--artifacts') + 1] : null
if (artifacts) fs.mkdirSync(artifacts, { recursive: true })

const t = loadDevTarget()
verifySentinel(t)
const run = Date.now()
const password = crypto.randomBytes(18).toString('base64url') + 'Aa9!'
const email = (k) => `splitchat-rehearsal+e2e-${k}-${run}@example.com`
const admin = createClient(t.url, t.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
for (const [key, name] of [['priya', 'Priya Raman'], ['sam', 'Sam Lee'], ['jo', 'Jo Nguyen'], ['oscar', 'Oscar Outsider']]) {
  const { error } = await admin.auth.admin.createUser({ email: email(key), password, email_confirm: true, user_metadata: { full_name: name } })
  if (error) throw new Error(`create ${key}: ${error.message}`)
}

const app = await startApp(t, 5197)
const allowedOrigins = [app.origin, new URL(t.url).origin]
const groupName = `E2E flat ${run % 100000}`
const results = []
const pages = []
let current = ''

async function step(name, fn) {
  current = name
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`PASS  ${name}`)
  } catch (error) {
    results.push({ name, ok: false })
    console.log(`FAIL  ${name}\n      ${error.message}`)
    if (artifacts) {
      for (const [i, p] of pages.entries()) {
        await p.screenshot(path.join(artifacts, `${name.replace(/[^a-z0-9]+/gi, '-')}-${i}.png`)).catch(() => {})
      }
    }
    throw error
  }
}
const assert = (cond, message) => {
  if (!cond) throw new Error(message)
}

async function signIn(key, opts = {}) {
  const page = await openBrowser({ allowedOrigins, ...opts })
  pages.push(page)
  await page.goto(`${app.origin}/login`)
  await page.type('Email address', email(key))
  await page.type('Password', password)
  await page.press('Enter')
  await page.waitFor(`location.pathname === '/'`, 20000, 'the dashboard after signing in')
  return page
}

/** A workspace section tab (the sidebar has same-named global links). */
async function tab(page, name) {
  const nav = await page.find('navigation', 'Group sections')
  await page.click('link', name, { within: nav })
  await page.find('heading', name)
}

let groupPath = ''
let exitCode = 0
try {
  const priya = await signIn('priya')

  await step('sign in lands on the dashboard with a personal greeting', async () => {
    await priya.waitForText('Welcome back, Priya')
  })

  await step('create a group and open its workspace', async () => {
    await priya.click('link', 'Groups')
    await priya.click('button', '+ Create group')
    await priya.type('Group name', groupName)
    await priya.click('button', 'Create group')
    await priya.click('link', new RegExp(groupName).toString(), { ms: 20000 })
    await priya.find('heading', groupName)
    groupPath = await priya.evaluate('location.pathname')
    assert(/^\/groups\/[0-9a-f-]{36}$/.test(groupPath), `unexpected workspace path ${groupPath}`)
    await priya.waitForText('You are settled up')
  })

  await step('add two members by email', async () => {
    await tab(priya, 'Members')
    for (const [key, name] of [['sam', 'Sam Lee'], ['jo', 'Jo Nguyen']]) {
      await priya.type('Email address', email(key))
      await priya.click('button', '+ Add member')
      await priya.waitForText(`${name} was added`)
    }
    await priya.waitForText('3 members')
  })

  await step('add an expense split with everyone', async () => {
    await priya.click('link', '+ Add expense')
    await priya.type('Description', 'Groceries')
    await priya.type('Amount', '96.30')
    await priya.click('button', 'Create expense')
    await priya.waitForText('Expense created successfully and split between 3 people')
  })

  await step('edit the expense amount; the canonical shares follow', async () => {
    await priya.click('link', 'View expense')
    await priya.waitForText('$96.30')
    await priya.click('link', 'Edit expense')
    await priya.type('Amount', '100.00')
    await priya.click('button', 'Save changes')
    await priya.waitFor(`location.pathname.startsWith('/expenses/') && !location.pathname.endsWith('/edit')`, 15000, 'the expense details after saving')
    await priya.find('list', 'Participant shares')
    await priya.waitForText('$100.00')
    const shares = await priya.evaluate(`[...document.querySelectorAll('[aria-label="Participant shares"] li')].map((li) => li.innerText.match(/\\$[\\d.,]+/)?.[0])`)
    assert(JSON.stringify(shares.slice().sort()) === JSON.stringify(['$33.33', '$33.33', '$33.34']), `shares ${shares}`)
  })

  await step('delete an expense after confirming', async () => {
    await priya.goto(`${app.origin}${groupPath}/expenses/new`)
    await priya.type('Description', 'Entered by mistake')
    await priya.type('Amount', '10')
    await priya.click('button', 'Create expense')
    await priya.click('link', 'View expense')
    await priya.click('button', 'Delete expense')
    assert(await priya.hasText('Entered by mistake'), 'deleted before confirming')
    await priya.click('button', 'Yes, delete')
    await priya.waitFor(`location.pathname === '/expenses'`, 15000, 'the expenses list after deleting')
    await priya.goto(`${app.origin}${groupPath}/expenses`)
    await priya.waitForText('Groceries')
    assert(!(await priya.hasText('Entered by mistake')), 'the deleted expense is still listed')
  })

  await step('balances show my server position and the fewest payments', async () => {
    await tab(priya, 'Balances')
    await priya.waitFor(`/You are owed \\$66\\.6[67]/.test(document.body.innerText)`, 15000, 'my position in the header')
    await priya.find('list', 'Suggested payments')
  })

  await step('record a settlement from a suggested payment', async () => {
    const plan = await priya.find('list', 'Suggested payments')
    await priya.click('button', 'Record', { within: plan })
    await priya.click('button', 'Record payment')
    await priya.waitFor(`/Payment of \\$33\\.3[34] recorded\\./.test(document.body.innerText)`, 15000, 'the payment confirmation')
    await priya.waitFor(`/You are owed \\$33\\.3[34]/.test(document.body.innerText)`, 15000, 'the updated position')
  })

  await step('activity shows what happened in the group', async () => {
    await tab(priya, 'Activity')
    await priya.waitForText('added “Groceries”')
    await priya.waitForText('added Sam Lee')
    assert(await priya.hasText('paid'), 'no payment in the activity feed')
  })

  // A member in another browser: realtime, restrictions.
  const sam = await signIn('sam')

  await step('a member opens the group from the dashboard', async () => {
    await sam.click('link', new RegExp(groupName).toString())
    await sam.find('heading', groupName)
    await tab(sam, 'Chat')
    await sam.waitForText('No messages yet')
  })

  await step('send a chat message; another member receives it live', async () => {
    await tab(priya, 'Chat')
    await priya.type('Message', 'Hello flat!', { role: 'textbox' })
    await priya.click('button', 'Send')
    await priya.find('list', 'Messages')
    await sam.waitForText('Hello flat!', 20000)
  })

  await step('Smart Expense detects an expense in a message and proposes it', async () => {
    await priya.type('Message', 'I paid $42 for pizza, split with everyone')
    await priya.click('button', 'Send')
    await priya.find('article', 'Expense proposal: Ready to review', { ms: 20000 })
    await sam.find('article', 'Expense proposal: Ready to review', { ms: 20000 })
  })

  await step('another member sees the proposal but cannot act on it', async () => {
    const card = await sam.find('article', 'Expense proposal: Ready to review')
    assert((await sam.count('button', null, card)) === 0, 'a member who is not the proposer or owner sees actions')
    assert(await sam.hasText('Waiting for Priya Raman or the group owner to review it.'), 'no waiting explanation')
  })

  await step('review, edit and approve the proposal; confirmation guards the money', async () => {
    const card = await priya.find('article', 'Expense proposal: Ready to review')
    await priya.click('link', 'Edit', { within: card })
    await priya.find('heading', 'Edit proposal')
    await priya.type('Amount', '45')
    await priya.click('button', 'Save proposal')
    await priya.waitFor(`location.pathname.endsWith('/chat')`, 15000, 'the chat after saving the proposal')
    await priya.waitFor(`[...document.querySelectorAll('article')].some((a) => a.innerText.includes('$45.00'))`, 15000, 'the edited amount on the card')
    const card2 = await priya.find('article', 'Expense proposal: Ready to review')
    await priya.click('button', 'Review and add', { within: card2 })
    await priya.waitForText('Add this $45.00 expense?')
    const focused = await priya.evaluate('document.activeElement?.textContent?.trim()')
    assert(focused === 'Cancel', `focus should rest on Cancel, not ${focused}`)
    await priya.click('button', 'Add expense')
    await priya.find('article', 'Expense proposal: Expense added', { ms: 20000 })
    await sam.find('article', 'Expense proposal: Expense added', { ms: 20000 })
  })

  await step('the approved expense appears like any other expense', async () => {
    await priya.click('link', 'View expense')
    await priya.waitForText('pizza')
    await priya.waitForText('$45.00')
    await priya.goto(`${app.origin}${groupPath}/expenses`)
    await priya.waitForText('pizza')
    await priya.waitForText('Groceries')
  })

  await step('a member cannot manage membership', async () => {
    await tab(sam, 'Members')
    await sam.find('button', 'Leave group')
    assert((await sam.count('button', '+ Add member')) === 0, 'a member sees "Add member"')
    assert((await sam.count('button', 'Remove')) === 0, 'a member sees "Remove"')
  })

  const oscar = await signIn('oscar')
  await step('an outsider cannot open the group', async () => {
    await oscar.goto(`${app.origin}${groupPath}`)
    await oscar.waitForText('Group unavailable')
    assert(!(await oscar.hasText('Groceries')), 'group data shown to an outsider')
    await oscar.goto(`${app.origin}${groupPath}/chat`)
    await oscar.waitForText('Group unavailable')
    assert(!(await oscar.hasText('Hello flat!')), 'chat shown to an outsider')
  })

  const jo = await signIn('jo', { width: 390, height: 844, mobile: true })
  await step('mobile: chat is reachable and sending works', async () => {
    await jo.goto(`${app.origin}${groupPath}/chat`)
    await jo.find('list', 'Messages')
    const inView = await jo.evaluate(`(() => { const el = document.querySelector('textarea'); const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight })()`)
    assert(inView, 'the composer is not in the first mobile viewport')
    await priya.goto(`${app.origin}${groupPath}/chat`)
    await priya.find('list', 'Messages')
    await jo.type('Message', 'On my way')
    await jo.click('button', 'Send')
    await jo.waitForText('On my way')
    await priya.waitForText('On my way', 20000)
  })

  await step('mobile: section navigation reaches every section', async () => {
    await tab(jo, 'Members')
    await jo.find('heading', 'Members')
    await tab(jo, 'Balances')
    await jo.find('heading', 'Balances')
  })

  await step('no request left localhost and SplitChat-Dev; no uncaught page errors', async () => {
    const violations = pages.flatMap((p) => p.violations)
    const errors = pages.flatMap((p) => p.consoleErrors)
    assert(violations.length === 0, `blocked requests: ${violations.map((u) => new URL(u).origin.replaceAll(PROD_REF, '<production-ref>')).join(', ')}`)
    assert(errors.length === 0, `page errors: ${errors.join(' | ').slice(0, 400)}`)
  })
} catch (error) {
  exitCode = 1
  if (!results.some((r) => !r.ok)) console.log(`FAIL  ${current || 'setup'}\n      ${error.message}`)
} finally {
  for (const p of pages) await p.close().catch(() => {})
  app.stop()
}
const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} journeys passed${exitCode ? ' (stopped at the first failure)' : ''}`)
process.exit(exitCode || passed !== results.length ? 1 : 0)
