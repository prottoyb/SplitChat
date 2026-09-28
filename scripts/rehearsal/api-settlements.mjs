#!/usr/bin/env node
// SplitChat-Dev check of M17 (settlements, balances) through the real APIs:
// supabase-js as the frontend uses it, PostgREST serialisation and RLS.
// Fresh synthetic users per run. Target guard: loadDevTarget + sentinel.
//
//   node scripts/rehearsal/api-settlements.mjs

import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { loadDevTarget, verifySentinel } from './dev.mjs'

const t = loadDevTarget()
verifySentinel(t)
const run = Date.now()
const password = crypto.randomBytes(18).toString('base64url') + 'Aa9!'
const email = (k) => `splitchat-rehearsal+set-${k}-${run}@example.com`
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

const owner = await user('owner', 'Olive Owner')
const bob = await user('bob', 'Bob Member')
const cara = await user('cara', 'Cara Member')
const outsider = await user('out', 'Xan Outsider')

const name = `Settle ${run}`
await owner.client.from('groups').insert({ name, description: null, created_by: owner.id })
const groupId = (await owner.client.from('groups').select('id').eq('name', name).limit(1)).data[0].id
for (const m of [bob, cara]) await owner.client.rpc('add_group_member_by_email', { target_group_id: groupId, target_email: email(m.key) })
await bob.client.rpc('create_equal_split_expense_v2', {
  p_group_id: groupId, p_description: 'Groceries', p_amount_cents: 3000, p_expense_date: '2026-09-27',
  p_paid_by: bob.id, p_participant_ids: [bob.id, owner.id, cara.id], p_notes: null,
})

const net = async (u = owner) => {
  const r = await u.client.rpc('get_group_balances', { p_group_id: groupId })
  return { r, by: new Map((r.data ?? []).map((row) => [row.user_id, row.net_cents])) }
}
const settle = (u, from, to, cents, extra = {}) =>
  u.client.rpc('record_settlement', {
    p_group_id: groupId, p_from_user: from.id, p_to_user: to.id, p_amount_cents: cents,
    p_settled_on: '2026-09-28', p_note: extra.note ?? null, p_client_request_id: extra.requestId ?? null,
  })

let b = await net()
check('balances come from the ledger (bob +20.00, others -10.00)',
  b.by.get(bob.id) === 2000 && b.by.get(owner.id) === -1000 && b.by.get(cara.id) === -1000)
check('amounts arrive as JSON integers', (b.r.data ?? []).every((row) => Number.isSafeInteger(row.net_cents) && Number.isSafeInteger(row.paid_cents)))
const outside = await outsider.client.rpc('get_group_balances', { p_group_id: groupId })
check('an outsider cannot read balances', outside.error?.message === 'not_found_or_forbidden', outside.error?.message)

const partial = await settle(cara, cara, bob, 400, { note: 'Secret transfer note' })
b = await net()
check('a partial payment is recorded', !partial.error && b.by.get(cara.id) === -600 && b.by.get(bob.id) === 1600)
const over = await settle(cara, cara, bob, 700)
check('over-settlement is refused', over.error?.message === 'exceeds_balance', over.error?.message)
const reversal = await settle(owner, bob, owner, 100)
check('a debt reversal is refused', reversal.error?.message === 'nothing_to_settle', reversal.error?.message)
const notParty = await settle(cara, owner, bob, 100)
check('a member cannot record a payment between others', notParty.error?.message === 'forbidden', notParty.error?.message)

const requestId = crypto.randomUUID()
const first = await settle(owner, owner, bob, 1000, { requestId })
const retry = await settle(owner, owner, bob, 1000, { requestId })
b = await net()
check('a retried request records once', !first.error && first.data === retry.data && b.by.get(owner.id) === 0, `${first.data} ${retry.data}`)

const direct = await owner.client.from('settlements').insert({
  group_id: groupId, from_user: cara.id, to_user: bob.id, amount_cents: 1, settled_on: '2026-09-28', created_by: owner.id,
})
check('a client cannot insert settlements directly', direct.error?.code === '42501', direct.error?.code)
const upd = await owner.client.from('settlements').update({ amount_cents: 1 }).eq('group_id', groupId).select()
check('a client cannot update settlements directly', Boolean(upd.error) || (upd.data ?? []).length === 0, upd.error?.code ?? `${upd.data?.length}`)
const outRead = await outsider.client.from('settlements').select('id').eq('group_id', groupId)
check('an outsider reads no settlements', !outRead.error && outRead.data.length === 0, `${outRead.data?.length}`)
const anon = createClient(t.url, t.anonKey, { auth: { persistSession: false } })
const anonRead = await anon.from('settlements').select('id').eq('group_id', groupId)
check('anon reads no settlements', Boolean(anonRead.error) || (anonRead.data ?? []).length === 0, anonRead.error?.code ?? `${anonRead.data?.length}`)

const caraVoid = await cara.client.rpc('void_settlement', { p_settlement_id: first.data, p_reason: 'Not mine' })
check('a non-party member cannot void', caraVoid.error?.message === 'forbidden', caraVoid.error?.message)
const bobVoid = await bob.client.rpc('void_settlement', { p_settlement_id: first.data, p_reason: 'Never arrived' })
b = await net()
check('a party voids; the debt comes back', !bobVoid.error && b.by.get(owner.id) === -1000, bobVoid.error?.message ?? '')
const again = await bob.client.rpc('void_settlement', { p_settlement_id: first.data, p_reason: 'again' })
check('a payment is voided only once', again.error?.message === 'already_voided', again.error?.message)
const history = await bob.client.from('settlements').select('id, voided_at, void_reason').eq('group_id', groupId)
check('the voided payment stays in the history', (history.data ?? []).some((s) => s.id === first.data && s.voided_at && s.void_reason === 'Never arrived'))

await owner.client.rpc('remove_group_member', { p_group_id: groupId, p_user_id: cara.id })
const former = await settle(owner, cara, bob, 600)
b = await net()
check('the owner can settle a former member’s debt', !former.error && b.by.get(cara.id) === 0, former.error?.message ?? '')

const ev = await bob.client.from('group_events').select('kind, payload').eq('group_id', groupId).like('kind', 'settlement%').order('id')
const kinds = (ev.data ?? []).map((e) => e.kind)
check('settlement events recorded in order', JSON.stringify(kinds) === JSON.stringify(['settlement_recorded', 'settlement_recorded', 'settlement_voided', 'settlement_recorded']), kinds.join(','))
check('no note or reason text in any event', !(ev.data ?? []).some((e) => /Secret|Never arrived/.test(JSON.stringify(e.payload))))

const failed = results.filter((x) => !x).length
console.log(`\n${results.length - failed}/${results.length} settlement checks passed`)
process.exit(failed ? 1 : 0)
