#!/usr/bin/env node
// SplitChat-Dev check of the M16 activity event log through the real APIs
// (supabase-js as the frontend uses it, real GoTrue for account deletion).
// Fresh synthetic users per run. Target guard: loadDevTarget + sentinel.
//
//   node scripts/rehearsal/api-activity.mjs

import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { loadDevTarget, verifySentinel } from './dev.mjs'

const t = loadDevTarget()
verifySentinel(t)
const run = Date.now()
const password = crypto.randomBytes(18).toString('base64url') + 'Aa9!'
const email = (k) => `splitchat-rehearsal+act-${k}-${run}@example.com`
const admin = createClient(t.url, t.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
const results = []
const check = (name, pass, detail = '') => {
  results.push(Boolean(pass))
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

async function user(key, name) {
  const { data, error } = await admin.auth.admin.createUser({ email: email(key), password, email_confirm: true, user_metadata: { full_name: name } })
  if (error) throw new Error(`create ${key}: ${error.message}`)
  const client = createClient(t.url, t.anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const s = await client.auth.signInWithPassword({ email: email(key), password })
  if (s.error) throw new Error(`sign in ${key}: ${s.error.message}`)
  return { id: data.user.id, key, client }
}
const events = async (u, groupId) => {
  const r = await u.client.from('group_events')
    .select('id, kind, actor_id, subject_id, subject_user_id, payload, backfilled')
    .eq('group_id', groupId).order('created_at', { ascending: true }).order('id', { ascending: true })
  return r
}

const owner = await user('owner', 'Olive Owner')
const bob = await user('bob', 'Bob Member')
const cara = await user('cara', 'Cara Member')
const outsider = await user('out', 'Xan Outsider')

const name = `Activity ${run}`
await owner.client.from('groups').insert({ name, description: null, created_by: owner.id })
const groupId = (await owner.client.from('groups').select('id').eq('name', name).limit(1)).data[0].id
for (const m of [bob, cara]) await owner.client.rpc('add_group_member_by_email', { target_group_id: groupId, target_email: email(m.key) })

const created = await bob.client.rpc('create_equal_split_expense_v2', {
  p_group_id: groupId, p_description: 'Secret dinner', p_amount_cents: 1001, p_expense_date: '2026-09-27',
  p_paid_by: bob.id, p_participant_ids: [bob.id, owner.id, cara.id], p_notes: 'private note',
})
const exp = (await bob.client.from('expenses').select('updated_at').eq('id', created.data).limit(1)).data[0]
await bob.client.rpc('update_equal_split_expense', {
  p_expense_id: created.data, p_expected_updated_at: exp.updated_at, p_description: 'Renamed', p_amount_cents: 1500,
  p_expense_date: '2026-09-27', p_paid_by: bob.id, p_participant_ids: [bob.id, owner.id], p_notes: 'private note',
})
const exp2 = (await bob.client.from('expenses').select('updated_at').eq('id', created.data).limit(1)).data[0]
await owner.client.rpc('delete_expense', { p_expense_id: created.data, p_expected_updated_at: exp2.updated_at })
await owner.client.rpc('remove_group_member', { p_group_id: groupId, p_user_id: cara.id })
await owner.client.rpc('transfer_group_ownership', { p_group_id: groupId, p_new_owner_id: bob.id })

let r = await events(owner, groupId)
const kinds = (r.data ?? []).map((e) => e.kind)
check('each action recorded exactly one event, in order', JSON.stringify(kinds) === JSON.stringify([
  'group_created', 'member_added', 'member_added', 'expense_created', 'expense_updated', 'expense_deleted',
  'member_removed', 'ownership_transferred',
]), kinds.join(','))
check('no description or notes text in any payload', !(r.data ?? []).some((e) => /Secret|Renamed|private note/.test(JSON.stringify(e.payload))))
const upd = (r.data ?? []).find((e) => e.kind === 'expense_updated')
check('the edit event records what changed', upd?.payload?.changes?.amount_cents?.from === 1001 && upd?.payload?.changes?.amount_cents?.to === 1500 && upd?.payload?.description_changed === true)

r = await events(outsider, groupId)
check('an outsider reads no events', !r.error && r.data.length === 0, `${r.data?.length}`)
r = await events(cara, groupId)
check('a removed (former) member reads no events', !r.error && r.data.length === 0, `${r.data?.length}`)
const anon = createClient(t.url, t.anonKey, { auth: { persistSession: false } })
r = await anon.from('group_events').select('id').eq('group_id', groupId)
check('anon cannot read events', Boolean(r.error) || (r.data ?? []).length === 0, `${r.error?.code ?? r.data?.length}`)

const ins = await owner.client.from('group_events').insert({ group_id: groupId, kind: 'group_created', payload: { v: 1 } })
check('a client cannot insert events', ins.error?.code === '42501', `${ins.error?.code}`)
const del = await owner.client.from('group_events').delete().eq('group_id', groupId).select()
check('a client cannot delete events', Boolean(del.error) || (del.data ?? []).length === 0, `${del.error?.code ?? del.data?.length}`)

const ids = await bob.client.rpc('get_ledger_identities', { p_group_id: groupId })
check('the removed member is still named for the feed', (ids.data ?? []).some((x) => x.user_id === cara.id && x.display_name === 'Cara Member'))

// Real GoTrue account deletion of a member (not the owner any more: owner transferred).
const gone = await admin.auth.admin.deleteUser(owner.id)
check('real account deletion succeeds for a non-owner', !gone.error, gone.error?.message ?? '')
r = await events(bob, groupId)
const last = (r.data ?? []).at(-1)
check('it records member_account_deleted with no actor', last?.kind === 'member_account_deleted' && last.actor_id === null && last.subject_user_id === owner.id)

const failed = results.filter((x) => !x).length
console.log(`\n${results.length - failed}/${results.length} activity checks passed`)
process.exit(failed ? 1 : 0)
