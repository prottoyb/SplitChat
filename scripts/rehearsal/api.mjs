#!/usr/bin/env node
// SplitChat-Dev rehearsal through the real Supabase APIs (GoTrue + PostgREST),
// exactly as the frontend and GoTrue use them. Synthetic users only.
//
//   node scripts/rehearsal/api.mjs seed     create users, groups, members, expenses
//   node scripts/rehearsal/api.mjs verify   post-migration behaviour checks
//
// Target: SplitChat-Dev only (loadDevTarget refuses production; the DB
// sentinel is verified first). Run state (synthetic ids and passwords) is kept
// in the git-ignored .splitchat-dev-rehearsal.json.local.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadDevTarget, verifySentinel } from './dev.mjs'

// HISTORICAL (Phase 8): this script exercises the schema before M14 dropped
// the legacy numeric expense RPC; against the current schema it fails by
// design. It is kept as the evidence cited by the Phase 1 rehearsal records
// and only runs when explicitly asked to (e.g. while replaying production's
// path from a reset SplitChat-Dev). Current checks: api-chat, api-settlements,
// api-activity, api-smart-expense, api-security-audit, and the E2E suite.
if (!process.argv.includes('--historical-pre-m14')) {
  console.error('HISTORICAL script for a pre-M14 schema (it calls the dropped legacy expense RPC).')
  console.error('Pass --historical-pre-m14 to run it deliberately against such a schema; see scripts/rehearsal/README.md.')
  process.exit(2)
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const STATE_FILE = path.join(root, '.splitchat-dev-rehearsal.json.local')
const t = loadDevTarget()
verifySentinel(t)

const PEOPLE = {
  alice: { name: 'Alice', confirmed: true },
  bob: { name: 'Bob', confirmed: true },
  cara: { name: 'Cara', confirmed: true },
  dan: { name: 'Dan', confirmed: true },
  eve: { name: 'Eve', confirmed: true },
  uma: { name: 'Uma', confirmed: false },
  zed: { name: 'Zed', confirmed: true },
}
const email = (key) => `splitchat-rehearsal+${key}@example.com`

async function call(method, urlPath, { token, key = t.anonKey, body, prefer } = {}) {
  const headers = { apikey: key, Authorization: `Bearer ${token ?? key}`, 'Content-Type': 'application/json' }
  if (prefer) headers.Prefer = prefer
  const res = await fetch(`${t.url}${urlPath}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text.slice(0, 200) }
  }
  return { status: res.status, ok: res.ok, json }
}

const admin = (method, p, body) => call(method, `/auth/v1/admin${p}`, { key: t.serviceKey, body })
const rest = (method, p, token, body, prefer) => call(method, `/rest/v1${p}`, { token, body, prefer })
const rpc = (fn, token, body) => call('POST', `/rest/v1/rpc/${fn}`, { token, body })

async function signIn(state, who) {
  const r = await call('POST', '/auth/v1/token?grant_type=password', { body: { email: email(who), password: state.password } })
  if (!r.ok) throw new Error(`sign-in failed for ${who}: ${r.status} ${JSON.stringify(r.json)}`)
  return r.json.access_token
}

function must(r, what) {
  if (!r.ok) throw new Error(`${what} failed: ${r.status} ${JSON.stringify(r.json)}`)
  return r.json
}

async function seed() {
  if (fs.existsSync(STATE_FILE)) throw new Error('rehearsal state exists; seed already ran')
  const state = { password: crypto.randomBytes(18).toString('base64url') + 'Aa9!', users: {}, groups: {}, expenses: {} }
  for (const [key, p] of Object.entries(PEOPLE)) {
    const u = must(await admin('POST', '/users', {
      email: email(key), password: state.password, email_confirm: p.confirmed, user_metadata: { full_name: p.name },
    }), `create user ${key}`)
    state.users[key] = u.id
  }
  const tok = {}
  for (const key of ['alice', 'bob', 'cara', 'dan', 'eve']) tok[key] = await signIn(state, key)

  // Frontend path: GroupsPage inserts the group; the trigger adds the owner.
  must(await rest('POST', '/groups', tok.alice, { name: 'Flat', description: null, created_by: state.users.alice }, 'return=minimal'), 'create G1')
  must(await rest('POST', '/groups', tok.dan, { name: 'Trip', description: null, created_by: state.users.dan }, 'return=minimal'), 'create G2')
  state.groups.g1 = must(await rest('GET', '/groups?select=id&name=eq.Flat', tok.alice), 'read G1')[0].id
  state.groups.g2 = must(await rest('GET', '/groups?select=id&name=eq.Trip', tok.dan), 'read G2')[0].id

  // Frontend path: GroupDetailsPage adds members by email.
  for (const who of ['bob', 'eve']) must(await rpc('add_group_member_by_email', tok.alice, { target_group_id: state.groups.g1, target_email: email(who) }), `add ${who} to G1`)
  for (const who of ['cara', 'alice']) must(await rpc('add_group_member_by_email', tok.dan, { target_group_id: state.groups.g2, target_email: email(who) }), `add ${who} to G2`)

  // Frontend path: AddExpensePage calls the RPC.
  const expense = (token, group, description, amount, payer, participants) => rpc('create_equal_split_expense', token, {
    p_group_id: state.groups[group], p_description: description, p_amount: amount, p_expense_date: '2026-09-20',
    p_paid_by: state.users[payer], p_participant_ids: participants.map((p) => state.users[p]), p_notes: null,
  })
  state.expenses.x1 = must(await expense(tok.alice, 'g1', 'Groceries', 100.0, 'alice', ['alice', 'bob']), 'X1')
  state.expenses.x2 = must(await expense(tok.bob, 'g1', 'Snacks', 10.0, 'bob', ['alice', 'bob', 'eve']), 'X2')
  state.expenses.x3 = must(await expense(tok.cara, 'g2', 'Fuel', 30.0, 'cara', ['cara', 'alice']), 'X3')

  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  console.log(`seeded: ${Object.keys(state.users).length} users, 2 groups, 3 expenses (ids in ${path.basename(STATE_FILE)})`)
}

const results = []
function check(name, pass, detail = '') {
  results.push(pass)
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
const code = (r) => r.json?.code ?? r.status

async function verify() {
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  const U = state.users
  const G = state.groups
  const X = state.expenses
  const tok = {}
  for (const key of ['alice', 'bob', 'cara', 'dan', 'eve']) tok[key] = await signIn(state, key)

  // --- M1: no cross-group move (via the API a member would use).
  let r = await rest('PATCH', `/expenses?id=eq.${X.x1}`, tok.alice, { group_id: G.g2 })
  check('M1/M3 creator cannot move an expense to another group via PostgREST', code(r) === '42501', `status ${r.status} code ${code(r)}`)

  // --- M2: anonymous callers lose the oracle and the expense RPC.
  r = await rpc('split_chat_is_group_member', undefined, { target_group_id: G.g1, target_user_id: U.bob })
  check('M2 anon cannot call split_chat_is_group_member', code(r) === '42501', `status ${r.status} code ${code(r)}`)
  r = await rpc('create_equal_split_expense', undefined, {
    p_group_id: G.g1, p_description: 'x', p_amount: 1, p_expense_date: '2026-09-20', p_paid_by: U.alice, p_participant_ids: [U.alice], p_notes: null,
  })
  check('M2 anon cannot call create_equal_split_expense', code(r) === '42501', `status ${r.status} code ${code(r)}`)

  // --- M3: no direct ledger writes; the RPC path works.
  r = await rest('POST', '/expenses', tok.alice, { group_id: G.g1, description: 'direct', amount: 5, paid_by: U.alice }, 'return=minimal')
  check('M3 member cannot insert an expense directly', code(r) === '42501', `code ${code(r)}`)
  r = await rest('PATCH', `/expense_splits?expense_id=eq.${X.x1}&user_id=eq.${U.bob}`, tok.alice, { share_amount: 1 })
  check('M3 creator cannot rewrite a split directly', code(r) === '42501', `code ${code(r)}`)
  r = await rest('DELETE', `/expenses?id=eq.${X.x1}`, tok.alice)
  check('M3 creator cannot delete an expense directly', code(r) === '42501', `code ${code(r)}`)
  r = await rpc('create_equal_split_expense', tok.bob, {
    p_group_id: G.g1, p_description: 'Taxi', p_amount: 12.5, p_expense_date: '2026-09-21', p_paid_by: U.bob,
    p_participant_ids: [U.alice, U.bob, U.eve], p_notes: 'rehearsal',
  })
  check('RPC expense creation still works for a member', r.ok && typeof r.json === 'string', `status ${r.status}`)
  const taxi = r.json
  r = await rest('GET', `/expense_splits?select=share_amount&expense_id=eq.${taxi}`, tok.bob)
  const taxiTotal = (r.json ?? []).reduce((n, s) => n + Math.round(Number(s.share_amount) * 100), 0)
  check('RPC expense committed (deferred balance check passed at COMMIT as authenticated)', r.ok && r.json.length === 3 && taxiTotal === 1250, `${r.json?.length} splits, ${taxiTotal} cents`)

  // --- Expected app reads and membership writes still work.
  r = await rest('GET', '/groups?select=id', tok.bob)
  check('member lists own groups', r.ok && r.json.length === 1)
  r = await rest('GET', `/group_members?select=user_id&group_id=eq.${G.g1}`, tok.bob)
  check('member lists group members', r.ok && r.json.length === 3)
  r = await rest('GET', `/expenses?select=id&group_id=eq.${G.g1}`, tok.bob)
  check('member lists group expenses', r.ok && r.json.length === 3)
  r = await rest('GET', `/profiles?select=id,full_name&id=eq.${U.alice}`, tok.bob)
  check('member reads a co-member profile', r.ok && r.json.length === 1 && r.json[0].full_name === 'Alice')
  r = await rest('GET', `/expenses?select=id&group_id=eq.${G.g1}`, tok.cara)
  check('outsider cannot see another group’s expenses', r.ok && r.json.length === 0)
  r = await rest('GET', `/expense_splits?select=user_id&expense_id=eq.${X.x1}`, tok.cara)
  check('outsider cannot see another group’s splits', r.ok && r.json.length === 0)
  r = await rest('POST', '/groups', tok.cara, { name: 'Cara club', description: null, created_by: U.cara }, 'return=minimal')
  check('any user can still create a group', r.ok, `status ${r.status}`)
  r = await rest('GET', '/expenses?select=id', undefined)
  check('anon cannot read expenses', code(r) === '42501', `code ${code(r)}`)

  // --- M5 + GoTrue: account deletion behaviour through the real Auth admin API.
  r = await admin('DELETE', `/users/${U.dan}`)
  const danStill = await admin('GET', `/users/${U.dan}`)
  check('M5 deleting a group owner through GoTrue is refused', !r.ok && danStill.ok, `delete status ${r.status}`)
  const danTok = await signIn(state, 'dan').catch(() => null)
  check('refused deletion left the owner account usable (sign-in works)', Boolean(danTok))
  r = await rest('GET', `/expenses?select=id&group_id=eq.${G.g2}`, tok.cara)
  check('refused deletion kept the group ledger intact', r.ok && r.json.length === 1)
  r = await admin('DELETE', `/users/${U.bob}`)
  check('member with ledger history cannot yet be deleted (M11 pending)', !r.ok, `status ${r.status}`)
  r = await admin('DELETE', `/users/${U.zed}`)
  check('account with no groups or ledger rows can be deleted', r.ok, `status ${r.status}`)

  // --- Membership deletes as the frontend does them (pre-M7 behaviour).
  r = await rest('DELETE', `/group_members?group_id=eq.${G.g1}&user_id=eq.${U.alice}`, tok.alice, undefined, 'return=representation')
  check('owner cannot remove their own membership', r.ok && r.json.length === 0)
  r = await rest('DELETE', `/group_members?group_id=eq.${G.g1}&user_id=eq.${U.eve}`, tok.eve, undefined, 'return=representation')
  check('member can leave a group (frontend leave path)', r.ok && r.json.length === 1)
  r = await rest('GET', `/expense_splits?select=user_id&expense_id=eq.${X.x2}`, tok.bob)
  check('historical splits of a member who left are kept', r.ok && r.json.length === 3)

  const failed = results.filter((ok) => !ok).length
  console.log(`\n${results.length - failed}/${results.length} API checks passed`)
  process.exit(failed ? 1 : 0)
}

const cmd = process.argv[2]
;(cmd === 'seed' ? seed() : cmd === 'verify' ? verify() : Promise.reject(new Error('usage: seed|verify')))
  .catch((error) => {
    console.error(`ERROR: ${String(error.message).replace(/eyJ[A-Za-z0-9_.-]+/g, '<redacted-jwt>')}`)
    process.exit(1)
  })
