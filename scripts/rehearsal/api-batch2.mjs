#!/usr/bin/env node
// SplitChat-Dev rehearsal of production batch 2 (M6-M10) through the real
// Supabase APIs, exactly as the frontend calls them. Synthetic users only
// (created by api.mjs seed; ids/passwords in the git-ignored state file).
//
//   node scripts/rehearsal/api-batch2.mjs prepare   (BEFORE the push: builds a
//        fresh group with the pre-batch API, like today's production)
//   node scripts/rehearsal/api-batch2.mjs verify    (AFTER the push)
//
// Target: SplitChat-Dev only (loadDevTarget refuses production; the DB
// sentinel is verified first).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadDevTarget, verifySentinel } from './dev.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const STATE_FILE = path.join(root, '.splitchat-dev-rehearsal.json.local')
const t = loadDevTarget()
verifySentinel(t)

const email = (key) => `splitchat-rehearsal+${key}@example.com`
const NIL_GROUP = '10000000-0000-4000-8000-0000000000ff'
const NIL_USER = '00000000-0000-4000-8000-0000000000ff'

async function call(method, urlPath, { token, key = t.anonKey, body, prefer, profile } = {}) {
  const headers = { apikey: key, Authorization: `Bearer ${token ?? key}`, 'Content-Type': 'application/json' }
  if (prefer) headers.Prefer = prefer
  if (profile) headers['Accept-Profile'] = profile
  const res = await fetch(`${t.url}${urlPath}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text.slice(0, 120) }
  }
  return { status: res.status, ok: res.ok, json }
}
const rest = (method, p, token, body, prefer) => call(method, `/rest/v1${p}`, { token, body, prefer })
const rpc = (fn, token, body) => call('POST', `/rest/v1/rpc/${fn}`, { token, body })
const code = (r) => r.json?.code ?? r.status
const msg = (r) => r.json?.message

async function signIn(state, who) {
  const r = await call('POST', '/auth/v1/token?grant_type=password', { body: { email: email(who), password: state.password } })
  if (!r.ok) throw new Error(`sign-in failed for ${who}: ${r.status}`)
  return r.json.access_token
}

const results = []
function check(name, pass, detail = '') {
  results.push(pass)
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

async function prepare() {
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  const tok = {}
  for (const who of ['alice', 'bob', 'eve']) tok[who] = await signIn(state, who)
  // Pre-batch API, as production has it today: direct group insert, the old
  // add-by-email RPC, and the expense RPC.
  const name = `Batch2 Flat ${Date.now()}`
  let r = await rest('POST', '/groups', tok.alice, { name, description: null, created_by: state.users.alice }, 'return=minimal')
  if (!r.ok) throw new Error(`group insert failed: ${r.status}`)
  r = await rest('GET', `/groups?select=id&name=eq.${encodeURIComponent(name)}`, tok.alice)
  const groupId = r.json[0].id
  for (const who of ['bob', 'eve']) {
    r = await rpc('add_group_member_by_email', tok.alice, { target_group_id: groupId, target_email: email(who) })
    if (!r.ok) throw new Error(`legacy add ${who} failed: ${r.status} ${msg(r)}`)
  }
  r = await rpc('create_equal_split_expense', tok.bob, {
    p_group_id: groupId, p_description: 'Batch2 groceries', p_amount: 10.0, p_expense_date: '2026-09-22',
    p_paid_by: state.users.bob, p_participant_ids: [state.users.alice, state.users.bob, state.users.eve], p_notes: null,
  })
  if (!r.ok) throw new Error(`expense failed: ${r.status} ${msg(r)}`)
  state.batch2 = { groupId, expenseId: r.json }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  console.log(`prepared batch 2 scenario: group with owner Alice, members Bob and Eve, one 10.00 expense`)
}

async function verify() {
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  const U = state.users
  const G = state.batch2.groupId
  const X = state.batch2.expenseId
  const tok = {}
  for (const who of ['alice', 'bob', 'cara', 'dan', 'eve']) tok[who] = await signIn(state, who)

  // Anonymous callers.
  let r = await rest('GET', '/profiles?select=id', undefined)
  check('anon cannot read profiles', code(r) === '42501', `code ${code(r)}`)
  r = await rest('GET', '/groups?select=id', undefined)
  check('anon cannot read groups', code(r) === '42501', `code ${code(r)}`)
  r = await rpc('add_group_member_by_email', undefined, { target_group_id: G, target_email: email('cara') })
  check('anon cannot call add_group_member_by_email', code(r) === '42501', `code ${code(r)}`)
  r = await rpc('get_ledger_identities', undefined, { p_group_id: G })
  check('anon cannot call get_ledger_identities', code(r) === '42501', `code ${code(r)}`)
  r = await rpc('split_chat_is_group_member', undefined, { target_group_id: G, target_user_id: U.bob })
  check('old membership oracle no longer exists (anon)', !r.ok && r.status === 404, `status ${r.status}`)
  r = await rpc('split_chat_is_group_member', tok.dan, { target_group_id: G, target_user_id: U.bob })
  check('old membership oracle no longer exists (signed-in)', !r.ok && r.status === 404, `status ${r.status}`)
  r = await call('POST', '/rest/v1/rpc/my_active_group_ids', { token: tok.dan, profile: 'private', body: {} })
  check('private helpers are not reachable through the Data API', !r.ok, `status ${r.status} ${code(r)}`)

  // Outsider (Dan) vs nonexistent targets: identical errors (S9).
  const same = async (label, a, b) => {
    const [ra, rb] = [await a(), await b()]
    check(label, !ra.ok && !rb.ok && msg(ra) === 'not_found_or_forbidden' && msg(rb) === msg(ra) && ra.status === rb.status,
      `${ra.status}/${msg(ra)} vs ${rb.status}/${msg(rb)}`)
  }
  await same('outsider add-by-email: existing vs nonexistent group identical',
    () => rpc('add_group_member_by_email', tok.dan, { target_group_id: G, target_email: email('cara') }),
    () => rpc('add_group_member_by_email', tok.dan, { target_group_id: NIL_GROUP, target_email: email('cara') }))
  await same('outsider get_ledger_identities: existing vs nonexistent group identical',
    () => rpc('get_ledger_identities', tok.dan, { p_group_id: G }),
    () => rpc('get_ledger_identities', tok.dan, { p_group_id: NIL_GROUP }))
  await same('member remove: existing vs nonexistent target identical',
    () => rpc('remove_group_member', tok.bob, { p_group_id: G, p_user_id: U.eve }),
    () => rpc('remove_group_member', tok.bob, { p_group_id: G, p_user_id: NIL_USER }))
  await same('member transfer: existing vs nonexistent target identical',
    () => rpc('transfer_group_ownership', tok.bob, { p_group_id: G, p_new_owner_id: U.eve }),
    () => rpc('transfer_group_ownership', tok.bob, { p_group_id: G, p_new_owner_id: NIL_USER }))
  await same('member add-by-email: existing vs nonexistent email identical',
    () => rpc('add_group_member_by_email', tok.bob, { target_group_id: G, target_email: email('cara') }),
    () => rpc('add_group_member_by_email', tok.bob, { target_group_id: G, target_email: 'nobody-here@example.com' }))
  r = await rest('GET', `/groups?select=id&id=eq.${G}`, tok.dan)
  check('outsider cannot see the group', r.ok && r.json.length === 0)

  // Owner add-by-email outcomes (no enumeration, identity only when added).
  const add = async (who) => (await rpc('add_group_member_by_email', tok.alice, { target_group_id: G, target_email: who })).json?.[0]
  let row = await add(email('cara').toUpperCase())
  check('owner adds a confirmed account (case-insensitive) and gets its name', row?.result === 'added' && row.added_user_id === U.cara && row.added_full_name === 'Cara', JSON.stringify(row))
  row = await add(email('cara'))
  check('already_member discloses no identity', row?.result === 'already_member' && row.added_user_id === null && row.added_full_name === null)
  const noAccount = await add('nobody-at-all@example.com')
  const unconfirmed = await add(email('uma'))
  check('no account and unconfirmed account are indistinguishable',
    noAccount?.result === 'member_not_added' && JSON.stringify(noAccount) === JSON.stringify(unconfirmed), `${JSON.stringify(noAccount)} / ${JSON.stringify(unconfirmed)}`)
  r = await rpc('add_group_member_by_email', tok.alice, { target_group_id: G, target_email: 'not-an-email' })
  check('malformed email -> invalid_email', msg(r) === 'invalid_email', msg(r))

  // Direct Data API writes are all refused.
  r = await rest('POST', '/group_members', tok.alice, { group_id: G, user_id: U.dan }, 'return=minimal')
  check('owner cannot insert a membership directly', code(r) === '42501', `code ${code(r)}`)
  r = await rest('DELETE', `/group_members?group_id=eq.${G}&user_id=eq.${U.bob}`, tok.alice)
  check('owner cannot delete a membership directly', code(r) === '42501', `code ${code(r)}`)
  r = await rest('DELETE', `/group_members?group_id=eq.${G}&user_id=eq.${U.bob}`, tok.bob)
  check('member cannot hard-delete their membership', code(r) === '42501', `code ${code(r)}`)
  r = await rest('PATCH', `/groups?id=eq.${G}`, tok.alice, { name: 'Renamed' })
  check('owner cannot update the group directly', code(r) === '42501', `code ${code(r)}`)
  r = await rest('DELETE', `/groups?id=eq.${G}`, tok.alice)
  check('owner cannot delete the group directly (no ledger cascade)', code(r) === '42501', `code ${code(r)}`)
  r = await rest('PATCH', `/profiles?id=eq.${U.alice}`, tok.alice, { created_at: '2000-01-01T00:00:00Z' })
  check('user cannot change protected profile columns', code(r) === '42501', `code ${code(r)}`)
  r = await rest('PATCH', `/profiles?id=eq.${U.alice}`, tok.alice, { full_name: 'Alice' }, 'return=representation')
  check('user can still update their own display name', r.ok && r.json.length === 1, `status ${r.status}`)
  r = await rest('POST', '/groups', tok.dan, { name: `Dan solo ${Date.now()}`, description: null, created_by: U.dan }, 'return=minimal')
  check('frontend group creation still works', r.ok, `status ${r.status}`)

  // Remove, leave, former member, ledger identities.
  r = await rpc('remove_group_member', tok.alice, { p_group_id: G, p_user_id: U.cara })
  check('owner removes a member', r.ok, `status ${r.status} ${msg(r) ?? ''}`)
  r = await rest('GET', `/groups?select=id&id=eq.${G}`, tok.cara)
  check('removed member loses access', r.ok && r.json.length === 0)
  r = await rpc('leave_group', tok.eve, { p_group_id: G })
  check('member leaves', r.ok, `status ${r.status} ${msg(r) ?? ''}`)
  r = await rest('GET', `/expenses?select=id&group_id=eq.${G}`, tok.eve)
  check('former member sees no expenses', r.ok && r.json.length === 0)
  r = await rpc('get_ledger_identities', tok.eve, { p_group_id: G })
  check('former member cannot read ledger identities', msg(r) === 'not_found_or_forbidden', msg(r))
  r = await rest('GET', `/expense_splits?select=user_id&expense_id=eq.${X}`, tok.bob)
  check('historical splits of the former member remain visible to members', r.ok && r.json.length === 3)
  r = await rest('GET', `/profiles?select=id&id=eq.${U.eve}`, tok.bob)
  check('no former-member directory (profile not browsable)', r.ok && r.json.length === 0)
  r = await rpc('get_ledger_identities', tok.bob, { p_group_id: G })
  check('ledger identities give the former member name only', r.ok && r.json.length === 1 && r.json[0].user_id === U.eve
    && r.json[0].display_name === 'Eve' && Object.keys(r.json[0]).length === 2, JSON.stringify(r.json))
  r = await rest('GET', `/group_members?select=user_id&group_id=eq.${G}`, tok.bob)
  check('member list shows active members only', r.ok && r.json.length === 2, `${r.json?.length}`)
  r = await rpc('create_equal_split_expense', tok.bob, {
    p_group_id: G, p_description: 'After leave', p_amount: 4.0, p_expense_date: '2026-09-23', p_paid_by: U.bob,
    p_participant_ids: [U.bob, U.eve], p_notes: null,
  })
  check('former member cannot be a new participant', !r.ok, `status ${r.status}`)

  // Ownership transfer and owner leave.
  r = await rpc('leave_group', tok.alice, { p_group_id: G })
  check('owner cannot leave without transferring', msg(r) === 'owner_must_transfer', msg(r))
  r = await rpc('transfer_group_ownership', tok.alice, { p_group_id: G, p_new_owner_id: U.eve })
  check('transfer to a former member is refused', msg(r) === 'invalid_new_owner', msg(r))
  r = await rpc('transfer_group_ownership', tok.alice, { p_group_id: G, p_new_owner_id: U.bob })
  check('owner transfers to an active member', r.ok, `status ${r.status} ${msg(r) ?? ''}`)
  r = await rpc('leave_group', tok.alice, { p_group_id: G })
  check('previous owner can now leave', r.ok, `status ${r.status} ${msg(r) ?? ''}`)
  r = await rest('GET', `/group_members?select=user_id,role&group_id=eq.${G}`, tok.bob)
  check('exactly one active owner remains', r.ok && r.json.length === 1 && r.json[0].user_id === U.bob && r.json[0].role === 'owner', JSON.stringify(r.json))

  // Re-adding a former member.
  row = (await rpc('add_group_member_by_email', tok.bob, { target_group_id: G, target_email: email('eve') })).json?.[0]
  check('new owner re-adds the former member', row?.result === 'added')
  r = await rest('GET', `/expenses?select=id&group_id=eq.${G}`, tok.eve)
  check('re-added member regains access', r.ok && r.json.length === 1)
  r = await rpc('create_equal_split_expense', tok.eve, {
    p_group_id: G, p_description: 'Welcome back', p_amount: 6.0, p_expense_date: '2026-09-24', p_paid_by: U.eve,
    p_participant_ids: [U.bob, U.eve], p_notes: null,
  })
  check('expense creation works for the re-added member', r.ok, `status ${r.status} ${msg(r) ?? ''}`)

  const failed = results.filter((ok) => !ok).length
  console.log(`\n${results.length - failed}/${results.length} batch 2 API checks passed`)
  process.exit(failed ? 1 : 0)
}

const cmd = process.argv[2]
;(cmd === 'prepare' ? prepare() : cmd === 'verify' ? verify() : Promise.reject(new Error('usage: prepare|verify')))
  .catch((error) => {
    console.error(`ERROR: ${String(error.message).replace(/eyJ[A-Za-z0-9_.-]+/g, '<redacted-jwt>')}`)
    process.exit(1)
  })
