#!/usr/bin/env node
// CA-2 proof for M11 on SplitChat-Dev: account deletion through the REAL
// Supabase Auth (GoTrue) admin API, never by direct SQL. Fresh synthetic
// users per run, so the script is re-runnable.
//
//   node scripts/rehearsal/api-ca2.mjs
//
// Proves:
//  - allowed deletion (member with ledger history): the BEFORE DELETE trigger
//    fires, the profile is tombstoned, memberships are marked account_deleted,
//    auth rows are gone, and ledger rows are unchanged;
//  - blocked deletion (owner of a shared group): GoTrue refuses, and the auth
//    user, identities, refresh tokens, profile and memberships are all intact;
//    the user can still sign in;
//  - owner -> transfer -> deletion allowed; operator admin_release_ownership
//    -> deletion allowed; sole-member owner -> allowed, group persists.
// Target: SplitChat-Dev only (ref refusal + sentinel check).

import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadDevTarget, verifySentinel } from './dev.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const t = loadDevTarget()
verifySentinel(t)
const run = Date.now()
const password = crypto.randomBytes(18).toString('base64url') + 'Aa9!'
const email = (key) => `splitchat-rehearsal+ca2-${key}-${run}@example.com`

async function call(method, urlPath, { token, key = t.anonKey, body, prefer } = {}) {
  const headers = { apikey: key, Authorization: `Bearer ${token ?? key}`, 'Content-Type': 'application/json' }
  if (prefer) headers.Prefer = prefer
  const res = await fetch(`${t.url}${urlPath}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text.slice(0, 160) }
  }
  return { status: res.status, ok: res.ok, json }
}
const admin = (method, p, body) => call(method, `/auth/v1/admin${p}`, { key: t.serviceKey, body })
const rest = (method, p, token, body, prefer) => call(method, `/rest/v1${p}`, { token, body, prefer })
const rpc = (fn, token, body) => call('POST', `/rest/v1/rpc/${fn}`, { token, body })

// Read-only SQL through the sentinel-checked dev tool.
function sql(query) {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'rehearsal', 'dev.mjs'), 'sql', `-- ca2\n${query}`], { encoding: 'utf8', env: process.env })
  if (r.status !== 0) throw new Error(`sql failed: ${r.stderr}`)
  return r.stdout
}
function scalarRows(query) {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'rehearsal', 'dev.mjs'), 'sql', query], { encoding: 'utf8', env: process.env })
  if (r.status !== 0) throw new Error(`sql failed: ${r.stderr}`)
  return r.stdout.split('\n').slice(2).filter((l) => l.trim() && !/^\(\d+ rows?\)$/.test(l.trim())).map((l) => l.trim())
}
const one = (query) => scalarRows(query)[0]

async function createUser(key, name) {
  const r = await admin('POST', '/users', { email: email(key), password, email_confirm: true, user_metadata: { full_name: name } })
  if (!r.ok) throw new Error(`create ${key}: ${r.status}`)
  return r.json.id
}
async function signIn(key) {
  const r = await call('POST', '/auth/v1/token?grant_type=password', { body: { email: email(key), password } })
  return r.ok ? r.json.access_token : null
}
async function makeGroup(ownerTok, ownerId, name, memberKeys) {
  await rest('POST', '/groups', ownerTok, { name, description: null, created_by: ownerId }, 'return=minimal')
  const g = (await rest('GET', `/groups?select=id&name=eq.${encodeURIComponent(name)}`, ownerTok)).json[0].id
  for (const k of memberKeys) {
    const r = await rpc('add_group_member_by_email', ownerTok, { target_group_id: g, target_email: email(k) })
    if (r.json?.[0]?.result !== 'added') throw new Error(`add ${k}: ${JSON.stringify(r.json)}`)
  }
  return g
}
async function expense(tok, groupId, description, cents, payer, participants) {
  const r = await rpc('create_equal_split_expense_v2', tok, {
    p_group_id: groupId, p_description: description, p_amount_cents: cents, p_expense_date: '2026-09-25',
    p_paid_by: payer, p_participant_ids: participants, p_notes: null,
  })
  if (!r.ok) throw new Error(`expense: ${r.status} ${JSON.stringify(r.json)}`)
  return r.json
}
const ledgerDigest = () => one(`SELECT md5(coalesce(string_agg(e.id::text || ':' || e.amount::text || ':' || e.paid_by::text || ':' || e.created_by::text, ',' ORDER BY e.id), '')) || '/' ||
  (SELECT md5(coalesce(string_agg(s.expense_id::text || ':' || s.user_id::text || ':' || s.share_amount::text, ',' ORDER BY s.expense_id, s.user_id), '')) FROM public.expense_splits s) FROM public.expenses e`)
const authState = (id) => one(`SELECT (SELECT count(*) FROM auth.users WHERE id = '${id}') || '/' ||
  (SELECT count(*) FROM auth.identities WHERE user_id = '${id}') || '/' ||
  (SELECT count(*) FROM auth.refresh_tokens WHERE user_id = '${id}'::text)`)
const memberState = (id) => one(`SELECT coalesce(string_agg(group_id::text || ':' || role || ':' || coalesce(left_reason, 'active'), ',' ORDER BY group_id), '') FROM public.group_members WHERE user_id = '${id}'`)
const profileState = (id) => one(`SELECT full_name || '/' || coalesce(avatar_url, '-') || '/' || (deleted_at IS NOT NULL) FROM public.profiles WHERE id = '${id}'`)

const results = []
function check(name, pass, detail = '') {
  results.push(pass)
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

async function main() {
  // Scenario: owner O, members M (ledger history) and N, in group G.
  const O = await createUser('owner', 'Olive'), M = await createUser('member', 'Milo'), N = await createUser('other', 'Nora')
  const tokO = await signIn('owner'), tokM = await signIn('member'), tokN = await signIn('other')
  const G = await makeGroup(tokO, O, `CA2 ${run}`, ['member', 'other'])
  await expense(tokM, G, 'CA2 dinner', 3001, M, [O, M, N])
  await expense(tokN, G, 'CA2 taxi', 1000, N, [M, N])
  const ledgerBefore = ledgerDigest()

  // 1. BLOCKED: owner of a shared group, via GoTrue.
  const beforeAuth = authState(O), beforeMembers = memberState(O), beforeProfile = profileState(O)
  let r = await admin('DELETE', `/users/${O}`)
  check('GoTrue refuses to delete the owner of a shared group', !r.ok, `status ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`)
  check('blocked: auth user, identities and refresh tokens unchanged', authState(O) === beforeAuth, `${beforeAuth} -> ${authState(O)}`)
  check('blocked: memberships unchanged', memberState(O) === beforeMembers)
  check('blocked: profile unchanged (not tombstoned)', profileState(O) === beforeProfile, profileState(O))
  check('blocked: ledger unchanged', ledgerDigest() === ledgerBefore)
  check('blocked: the owner can still sign in', Boolean(await signIn('owner')))
  r = await admin('GET', `/users/${O}`)
  check('blocked: GoTrue still returns the user', r.ok)

  // 2. ALLOWED: member with ledger history, via GoTrue.
  r = await admin('DELETE', `/users/${M}`)
  check('GoTrue deletes a member with ledger history', r.ok, `status ${r.status}`)
  check('allowed: auth user, identities and refresh tokens are gone', authState(M) === '0/0/0', authState(M))
  check('allowed: profile tombstoned (trigger fired)', profileState(M) === 'Deleted user/-/true', profileState(M))
  check('allowed: membership marked account_deleted', memberState(M) === `${G}:member:account_deleted`, memberState(M))
  check('allowed: ledger rows unchanged (expenses and splits byte-identical)', ledgerDigest() === ledgerBefore)
  check('allowed: other members untouched', memberState(N) === `${G}:member:active` && memberState(O) === beforeMembers)
  r = await rpc('get_ledger_identities', tokO, { p_group_id: G })
  check('allowed: history shows the tombstone name only', r.ok && r.json.length === 1 && r.json[0].user_id === M && r.json[0].display_name === 'Deleted user', JSON.stringify(r.json))
  r = await rest('GET', `/expense_splits?select=user_id&expense_id=eq.${(await rest('GET', `/expenses?select=id&group_id=eq.${G}&description=eq.CA2%20dinner`, tokO)).json[0].id}`, tokO)
  check('allowed: the deleted member\'s splits remain visible to the group', r.ok && r.json.length === 3)
  check('allowed: the deleted member can no longer sign in', !(await signIn('member')))

  // 3. Owner transfers, then deletion is allowed; the group keeps its creator audit.
  r = await rpc('transfer_group_ownership', tokO, { p_group_id: G, p_new_owner_id: N })
  check('owner transfers to a remaining member', r.ok, `status ${r.status}`)
  r = await admin('DELETE', `/users/${O}`)
  check('GoTrue deletes the former owner after transfer', r.ok, `status ${r.status}`)
  check('former owner tombstoned; group still exists with its creator audit',
    profileState(O) === 'Deleted user/-/true' && one(`SELECT created_by::text FROM public.groups WHERE id = '${G}'`) === O)
  check('exactly one active owner remains', one(`SELECT count(*) FROM public.group_members WHERE group_id = '${G}' AND role = 'owner' AND left_at IS NULL`) === '1')
  check('ledger still unchanged after both deletions', ledgerDigest() === ledgerBefore)

  // 4. Operator release (postgres only), then deletion is allowed.
  const P = await createUser('opowner', 'Pia'), Q = await createUser('opmember', 'Quin')
  const tokP = await signIn('opowner')
  const H = await makeGroup(tokP, P, `CA2 op ${run}`, ['opmember'])
  r = await admin('DELETE', `/users/${P}`)
  check('GoTrue refuses the second owner before release', !r.ok, `status ${r.status}`)
  const released = one(`SELECT string_agg(group_id::text || '>' || new_owner_id::text, ',') FROM private.admin_release_ownership('${P}')`)
  check('operator release hands the group to the remaining member', released === `${H}>${Q}`, released)
  r = await admin('DELETE', `/users/${P}`)
  check('GoTrue deletes the owner after operator release', r.ok, `status ${r.status}`)

  // 5. Sole-member owner: allowed; the group persists with no active members.
  const S = await createUser('solo', 'Sol')
  const tokS = await signIn('solo')
  const J = await makeGroup(tokS, S, `CA2 solo ${run}`, [])
  r = await admin('DELETE', `/users/${S}`)
  check('GoTrue deletes the sole owner of a sole-member group', r.ok, `status ${r.status}`)
  check('the sole-member group persists, orphaned', one(`SELECT count(*) FROM public.groups WHERE id = '${J}'`) === '1'
    && memberState(S) === `${J}:member:account_deleted`, memberState(S))

  const failed = results.filter((ok) => !ok).length
  console.log(`\n${results.length - failed}/${results.length} CA-2 checks passed`)
  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error(`ERROR: ${String(error.message).replace(/eyJ[A-Za-z0-9_.-]+/g, '<redacted-jwt>')}`)
  process.exit(1)
})
