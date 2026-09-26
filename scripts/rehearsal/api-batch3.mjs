#!/usr/bin/env node
// SplitChat-Dev rehearsal of production batch 3 (3a: M11, M12, M13, M15;
// 3b: M14) through the real Supabase APIs. User calls go through
// @supabase/supabase-js, the frontend's own client, with exactly the RPC
// names, argument shapes and column selections of src/lib/expenseApi.ts,
// src/lib/membershipApi.ts and the expense pages. Fresh synthetic users per
// run; Auth admin calls use the dev service key.
//
//   node scripts/rehearsal/api-batch3.mjs prepare    BEFORE 3a (pre-M12 API)
//   node scripts/rehearsal/api-batch3.mjs verify3a   AFTER 3a
//   node scripts/rehearsal/api-batch3.mjs verify3b   AFTER 3b
//
// Target: SplitChat-Dev only (loadDevTarget refuses production; the DB
// sentinel is verified first). Ids live in the git-ignored state file.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { loadDevTarget, verifySentinel } from './dev.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const STATE_FILE = path.join(root, '.splitchat-dev-batch3.json.local')
const t = loadDevTarget()
verifySentinel(t)

const run = Date.now()
const password = crypto.randomBytes(18).toString('base64url') + 'Aa9!'
const email = (key) => `splitchat-rehearsal+b3-${key}-${run}@example.com`
const NIL = '10000000-0000-4000-8000-0000000000ff'

const adminClient = createClient(t.url, t.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
const anon = createClient(t.url, t.anonKey, { auth: { persistSession: false, autoRefreshToken: false } })

async function user(key, name) {
  const { data, error } = await adminClient.auth.admin.createUser({
    email: email(key), password, email_confirm: true, user_metadata: { full_name: name },
  })
  if (error) throw new Error(`create ${key}: ${error.message}`)
  const client = createClient(t.url, t.anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const signIn = await client.auth.signInWithPassword({ email: email(key), password })
  if (signIn.error) throw new Error(`sign in ${key}: ${signIn.error.message}`)
  return { id: data.user.id, key, client }
}

const results = []
function check(name, pass, detail = '') {
  results.push(Boolean(pass))
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
const errCode = (r) => r.error?.message ?? null

// The canonical rule (ADR-0006), restated independently of the code under test.
function canonical(totalCents, ids) {
  const sorted = [...new Set(ids.map((id) => id.toLowerCase()))].sort()
  const rem = totalCents % sorted.length
  const base = (totalCents - rem) / sorted.length
  return sorted.map((id, i) => `${id}=${base + (i < rem ? 1 : 0)}`)
}

async function makeGroup(owner, name, members = []) {
  // GroupsPage: direct INSERT of name/description/created_by, no read-back.
  const ins = await owner.client.from('groups').insert({ name, description: null, created_by: owner.id })
  if (ins.error) throw new Error(`group insert: ${ins.error.message}`)
  const sel = await owner.client.from('groups').select('id').eq('name', name).limit(1)
  const groupId = sel.data[0].id
  for (const m of members) {
    const r = await owner.client.rpc('add_group_member_by_email', { target_group_id: groupId, target_email: email(m.key) })
    if (r.data?.[0]?.result !== 'added') throw new Error(`add ${m.key}: ${JSON.stringify(r.data ?? r.error)}`)
  }
  return groupId
}

// expenseApi.createEqualSplitExpense
const createV2 = (u, groupId, e) => u.client.rpc('create_equal_split_expense_v2', {
  p_group_id: groupId, p_description: e.description, p_amount_cents: e.amountCents,
  p_expense_date: e.expenseDate ?? '2026-09-26', p_paid_by: e.paidBy, p_participant_ids: e.participantIds, p_notes: e.notes ?? null,
})
// expenseApi.updateEqualSplitExpense
const updateExpense = (u, expenseId, expectedUpdatedAt, e) => u.client.rpc('update_equal_split_expense', {
  p_expense_id: expenseId, p_expected_updated_at: expectedUpdatedAt, p_description: e.description,
  p_amount_cents: e.amountCents, p_expense_date: e.expenseDate ?? '2026-09-26', p_paid_by: e.paidBy,
  p_participant_ids: e.participantIds, p_notes: e.notes ?? null,
})
// expenseApi.deleteExpense / membershipApi.deleteGroup
const deleteExpense = (u, expenseId, expectedUpdatedAt) =>
  u.client.rpc('delete_expense', { p_expense_id: expenseId, p_expected_updated_at: expectedUpdatedAt })
const deleteGroup = (u, groupId) => u.client.rpc('delete_group', { p_group_id: groupId })

// ExpenseDetailsPage selections.
async function readExpense(u, expenseId) {
  const e = await u.client.from('expenses')
    .select('id, group_id, description, amount_cents, expense_date, paid_by, created_by, split_type, notes, created_at, updated_at')
    .eq('id', expenseId).limit(1)
  const s = await u.client.from('expense_splits')
    .select('expense_id, user_id, share_cents, percentage, created_at').eq('expense_id', expenseId)
  return { expense: e.data?.[0] ?? null, splits: s.data ?? [], error: e.error ?? s.error }
}
const splitList = (splits) => splits.map((s) => `${s.user_id}=${s.share_cents}`).sort()

async function prepare() {
  // Pre-M12 production API: the numeric legacy RPC allocates the remainder
  // cent to the first participant in INPUT order.
  const o = await user('prep-owner', 'Prep Owner')
  const a = await user('prep-a', 'Prep A')
  const b = await user('prep-b', 'Prep B')
  const groupId = await makeGroup(o, `B3 pre-M12 ${run}`, [a, b])
  const ids = [o.id, a.id, b.id]
  const last = [...ids].sort().at(-1)
  const order = [last, ...ids.filter((id) => id !== last)]  // highest UUID listed first
  const r = await o.client.rpc('create_equal_split_expense', {
    p_group_id: groupId, p_description: 'Pre-M12 dinner', p_amount: 10.0, p_expense_date: '2026-09-20',
    p_paid_by: o.id, p_participant_ids: order, p_notes: null,
  })
  if (r.error) throw new Error(`legacy create: ${r.error.message}`)
  const s = await o.client.from('expense_splits').select('user_id, share_amount').eq('expense_id', r.data)
  const historical = s.data.map((x) => `${x.user_id}=${Math.round(Number(x.share_amount) * 100)}`).sort()
  check('prepare: legacy RPC gave the extra cent to the first-listed (highest) UUID', historical.includes(`${last}=334`), historical.join(' '))
  fs.writeFileSync(STATE_FILE, JSON.stringify({ groupId, expenseId: r.data, ownerKey: o.key, run, historical }, null, 2))
  console.log(`state written (${path.basename(STATE_FILE)})`)
}

async function verifyCommon(stage) {
  const o = await user(`${stage}-owner`, 'Olive Owner')
  const m = await user(`${stage}-member`, 'Mia Member')
  const n = await user(`${stage}-other`, 'Noah Other')
  const x = await user(`${stage}-outsider`, 'Xan Outsider')
  const g = await makeGroup(o, `B3 ${stage} shared ${run}`, [m, n])
  await makeGroup(x, `B3 ${stage} outsider ${run}`)

  // M12: v2 through supabase-js, canonical allocation, integer cents on read.
  const participants = [n.id, m.id, o.id]
  const c = await createV2(m, g, { description: 'Dinner', amountCents: 1001, paidBy: m.id, participantIds: participants })
  check(`${stage} M12: member creates via create_equal_split_expense_v2`, !c.error && typeof c.data === 'string', errCode(c) ?? '')
  const read = await readExpense(m, c.data)
  check(`${stage} M12: amount_cents read back as the integer 1001`, read.expense?.amount_cents === 1001, JSON.stringify(read.expense?.amount_cents))
  check(`${stage} M12: shares are canonical (lowest UUID gets the extra cent) and integers`,
    JSON.stringify(splitList(read.splits)) === JSON.stringify(canonical(1001, participants).sort())
    && read.splits.every((s) => Number.isSafeInteger(s.share_cents)), splitList(read.splits).join(' '))
  for (const [label, e, code] of [
    ['zero amount', { description: 'x', amountCents: 0, paidBy: m.id, participantIds: [m.id] }, 'invalid_amount'],
    ['too small to split', { description: 'x', amountCents: 2, paidBy: m.id, participantIds: participants }, 'amount_too_small_to_split'],
    ['outsider participant', { description: 'x', amountCents: 100, paidBy: m.id, participantIds: [m.id, x.id] }, 'invalid_participants'],
    ['blank description', { description: '  ', amountCents: 100, paidBy: m.id, participantIds: [m.id] }, 'invalid_description'],
  ]) {
    const r = await createV2(m, g, e)
    check(`${stage} M12: ${label} -> ${code}`, errCode(r) === code && r.error?.code === 'P0001', `${r.error?.code} ${errCode(r)}`)
  }
  let r = await createV2(x, g, { description: 'x', amountCents: 100, paidBy: x.id, participantIds: [x.id] })
  const r2 = await createV2(x, NIL, { description: 'x', amountCents: 100, paidBy: x.id, participantIds: [x.id] })
  check(`${stage} M12/S9: outsider gets identical not_found_or_forbidden for real and nonexistent groups`,
    errCode(r) === 'not_found_or_forbidden' && errCode(r2) === 'not_found_or_forbidden' && r.error?.code === r2.error?.code)
  r = await anon.rpc('create_equal_split_expense_v2', { p_group_id: g, p_description: 'x', p_amount_cents: 100,
    p_expense_date: '2026-09-26', p_paid_by: m.id, p_participant_ids: [m.id], p_notes: null })
  check(`${stage} M12: anon cannot call v2`, Boolean(r.error) && r.error.code === '42501', `${r.error?.code}`)

  // M13: edit/delete authorization, concurrency, audit.
  const t0 = read.expense.updated_at
  r = await updateExpense(n, c.data, t0, { description: 'x', amountCents: 500, paidBy: m.id, participantIds: [m.id] })
  check(`${stage} M13: another member cannot edit -> forbidden`, errCode(r) === 'forbidden', errCode(r) ?? 'ok')
  r = await updateExpense(x, c.data, t0, { description: 'x', amountCents: 500, paidBy: x.id, participantIds: [x.id] })
  const rNil = await updateExpense(x, '20000000-0000-4000-8000-0000000000ff', t0, { description: 'x', amountCents: 500, paidBy: x.id, participantIds: [x.id] })
  check(`${stage} M13/S9: outsider gets identical not_found_or_forbidden for real and nonexistent expenses`,
    errCode(r) === 'not_found_or_forbidden' && errCode(rNil) === 'not_found_or_forbidden')
  r = await updateExpense(m, c.data, t0, { description: 'Dinner (fixed)', amountCents: 1000, paidBy: o.id, participantIds: [o.id, m.id] })
  check(`${stage} M13: creator edits amount, payer and participants with the loaded updated_at`, !r.error && typeof r.data === 'string', errCode(r) ?? '')
  const t1 = r.data
  const after = await readExpense(m, c.data)
  check(`${stage} M13: edit recomputed canonical shares`, JSON.stringify(splitList(after.splits)) === JSON.stringify(canonical(1000, [o.id, m.id]).sort()), splitList(after.splits).join(' '))
  check(`${stage} M13: returned updated_at round-trips exactly`, after.expense?.updated_at === t1, `${after.expense?.updated_at} vs ${t1}`)
  r = await updateExpense(m, c.data, t0, { description: 'lost', amountCents: 900, paidBy: m.id, participantIds: [m.id] })
  check(`${stage} M13: a stale timestamp is refused (no lost update)`, errCode(r) === 'stale_expense', errCode(r) ?? 'ok')
  r = await updateExpense(o, c.data, t1, { description: 'Owner fix', amountCents: 1000, paidBy: o.id, participantIds: [o.id, m.id, n.id] })
  check(`${stage} M13: owner edits a member's expense`, !r.error, errCode(r) ?? '')
  const t2 = r.data
  r = await deleteExpense(n, c.data, t2)
  check(`${stage} M13: another member cannot delete -> forbidden`, errCode(r) === 'forbidden', errCode(r) ?? 'ok')
  const direct = await m.client.from('expenses').update({ updated_by: m.id }).eq('id', c.data).select()
  check(`${stage} M13: direct expense UPDATE is still denied`, direct.error?.code === '42501', `${direct.error?.code}`)
  r = await deleteExpense(m, c.data, t2)
  check(`${stage} M13: creator deletes with the current updated_at`, !r.error, errCode(r) ?? '')
  const gone = await readExpense(o, c.data)
  check(`${stage} M13: the expense and its splits are gone`, gone.expense === null && gone.splits.length === 0)

  // M15: solo group deletable; any other (current or former) member blocks.
  const solo = await makeGroup(o, `B3 ${stage} solo ${run}`)
  r = await createV2(o, solo, { description: 'Private', amountCents: 4200, paidBy: o.id, participantIds: [o.id] })
  check(`${stage} M15: owner records a private expense in a solo group`, !r.error, errCode(r) ?? '')
  r = await deleteGroup(o, g)
  check(`${stage} M15: group with other members -> group_has_other_members`, errCode(r) === 'group_has_other_members', errCode(r) ?? 'ok')
  const former = await makeGroup(o, `B3 ${stage} former ${run}`, [n])
  const leave = await n.client.rpc('leave_group', { p_group_id: former })
  r = await deleteGroup(o, former)
  check(`${stage} M15: a member who left still blocks deletion`, !leave.error && errCode(r) === 'group_has_other_members', `${errCode(leave)} / ${errCode(r)}`)
  r = await deleteGroup(m, solo)
  const rn = await deleteGroup(m, NIL)
  check(`${stage} M15/S9: non-owner gets identical not_found_or_forbidden`, errCode(r) === 'not_found_or_forbidden' && errCode(rn) === 'not_found_or_forbidden')
  r = await anon.rpc('delete_group', { p_group_id: solo })
  check(`${stage} M15: anon cannot call delete_group`, r.error?.code === '42501', `${r.error?.code}`)
  r = await deleteGroup(o, solo)
  const soloAfter = await o.client.from('groups').select('id').eq('id', solo)
  check(`${stage} M15: owner deletes the solo group with its private ledger`, !r.error && soloAfter.data?.length === 0, errCode(r) ?? '')
  const sharedAfter = await o.client.from('groups').select('id').in('id', [g, former])
  check(`${stage} M15: refused groups are intact`, sharedAfter.data?.length === 2)

  return { o, m, n, x, g }
}

async function verify3a() {
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  // Existing ledger is not rewritten by M12.
  const s = await adminClient.from('expense_splits').select('user_id, share_amount, share_cents').eq('expense_id', state.expenseId)
  const now = (s.data ?? []).map((x) => `${x.user_id}=${x.share_cents}`).sort()
  check('3a M12: the pre-M12 historical allocation is unchanged (not re-allocated)', JSON.stringify(now) === JSON.stringify(state.historical), now.join(' '))
  check('3a M12: share_cents equals share_amount*100 for the historical rows',
    (s.data ?? []).every((x) => Math.round(Number(x.share_amount) * 100) === x.share_cents))

  const { o, m, n, g } = await verifyCommon('3a')

  // Legacy wrapper still serves a pre-M12 frontend until batch 3b.
  const legacy = await m.client.rpc('create_equal_split_expense', {
    p_group_id: g, p_description: 'Legacy client', p_amount: 10.01, p_expense_date: '2026-09-26',
    p_paid_by: m.id, p_participant_ids: [n.id, m.id, o.id, m.id], p_notes: null,
  })
  check('3a M12: legacy numeric RPC still works as the v2 wrapper', !legacy.error, errCode(legacy) ?? '')
  const lr = await readExpense(m, legacy.data)
  check('3a M12: legacy wrapper allocates canonically and removes duplicates', JSON.stringify(splitList(lr.splits)) === JSON.stringify(canonical(1001, [n.id, m.id, o.id]).sort()))
  const lbad = await m.client.rpc('create_equal_split_expense', {
    p_group_id: g, p_description: 'x', p_amount: 1.005, p_expense_date: '2026-09-26', p_paid_by: m.id, p_participant_ids: [m.id], p_notes: null,
  })
  check('3a M12: legacy wrapper returns stable codes', errCode(lbad) === 'invalid_amount', errCode(lbad) ?? 'ok')

  // M11 still holds after M13 (updated_by references profiles): a member who
  // last edited an expense can delete their account through real Auth.
  const e = await createV2(n, g, { description: 'Taxi', amountCents: 3000, paidBy: n.id, participantIds: [n.id, m.id] })
  const er = await readExpense(n, e.data)
  const edit = await updateExpense(n, e.data, er.expense.updated_at, { description: 'Taxi home', amountCents: 3001, paidBy: n.id, participantIds: [n.id, m.id] })
  const del = await adminClient.auth.admin.deleteUser(n.id)
  check('3a M11+M13: real Auth deletion of a member who created and edited an expense succeeds', !edit.error && !del.error, del.error?.message ?? '')
  const after = await readExpense(o, e.data)
  const prof = await adminClient.from('profiles').select('full_name, deleted_at').eq('id', n.id)
  check('3a M11+M13: the expense and splits survive; the profile is tombstoned',
    after.expense?.amount_cents === 3001 && after.splits.length === 2 && prof.data?.[0]?.full_name === 'Deleted user' && prof.data?.[0]?.deleted_at)
  const ownerFix = await updateExpense(o, e.data, after.expense.updated_at, { description: 'Taxi home', amountCents: 3001, paidBy: n.id, participantIds: [n.id, m.id] })
  check('3a M13: owner can still edit it, keeping the deleted user as payer and participant', !ownerFix.error, errCode(ownerFix) ?? '')
  const blocked = await adminClient.auth.admin.deleteUser(o.id)
  check('3a M11: owner of a shared group is still refused by real Auth', Boolean(blocked.error), blocked.error?.message ?? 'deleted!')
}

async function verify3b() {
  const { m, g } = await verifyCommon('3b')
  const legacy = await m.client.rpc('create_equal_split_expense', {
    p_group_id: g, p_description: 'Legacy client', p_amount: 10.01, p_expense_date: '2026-09-26',
    p_paid_by: m.id, p_participant_ids: [m.id], p_notes: null,
  })
  check('3b M14: the legacy numeric RPC no longer exists (PostgREST PGRST202)', legacy.error?.code === 'PGRST202', `${legacy.error?.code}`)
}

const cmd = process.argv[2]
const steps = { prepare, verify3a, verify3b }
if (!steps[cmd]) {
  console.error('usage: api-batch3.mjs prepare|verify3a|verify3b')
  process.exit(2)
}
try {
  await steps[cmd]()
  const failed = results.filter((ok) => !ok).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
} catch (error) {
  console.error(`ERROR: ${error.message}`)
  process.exit(1)
}
