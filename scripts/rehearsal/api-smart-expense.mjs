#!/usr/bin/env node
// SplitChat-Dev check of M19 (Smart Expense candidates, ADR-0012 condition
// 15) through the real APIs: supabase-js as the frontend uses it, PostgREST,
// RLS and Realtime with each user's own JWT. Fresh synthetic users per run.
// Target guard: loadDevTarget + sentinel.
//
//   node scripts/rehearsal/api-smart-expense.mjs

import crypto from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { createClient } from '@supabase/supabase-js'
import { loadDevTarget, verifySentinel } from './dev.mjs'

const t = loadDevTarget()
verifySentinel(t)
const run = Date.now()
const password = crypto.randomBytes(18).toString('base64url') + 'Aa9!'
const email = (k) => `splitchat-rehearsal+se-${k}-${run}@example.com`
const admin = createClient(t.url, t.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
const results = []
const check = (name, pass, detail = '') => {
  results.push(Boolean(pass))
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
const newClient = () => createClient(t.url, t.anonKey, { auth: { persistSession: false, autoRefreshToken: false } })

async function user(key, name) {
  const { data, error } = await admin.auth.admin.createUser({ email: email(key), password, email_confirm: true, user_metadata: { full_name: name } })
  if (error) throw new Error(`create ${key}: ${error.message}`)
  const client = newClient()
  const s = await client.auth.signInWithPassword({ email: email(key), password })
  if (s.error) throw new Error(`sign in ${key}: ${s.error.message}`)
  client.realtime.setAuth(s.data.session.access_token)
  return { id: data.user.id, key, client }
}

async function listen(client, label, groupId) {
  const events = []
  const channel = client
    .channel(`cand-${label}-${run}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'expense_candidates', filter: `group_id=eq.${groupId}` },
      (payload) => events.push({ type: payload.eventType, row: payload.new }))
  const status = await new Promise((resolve) => {
    channel.subscribe((s) => (s === 'SUBSCRIBED' || s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') && resolve(s))
    setTimeout(() => resolve('NO_STATUS'), 15000)
  })
  return { channel, events, status }
}

async function waitFor(predicate, ms = 8000) {
  for (let waited = 0; waited < ms; waited += 200) {
    if (predicate()) return true
    await sleep(200)
  }
  return predicate()
}

const send = async (u, groupId, body) =>
  (await u.client.rpc('send_group_message', { p_group_id: groupId, p_body: body, p_client_request_id: crypto.randomUUID() })).data
const propose = (u, messageId, draft) =>
  u.client.rpc('propose_expense_candidate', {
    p_message_id: messageId, p_source: 'natural', p_interpreter_version: 'deterministic-1',
    p_description: draft.description ?? null, p_amount_cents: draft.amountCents ?? null, p_expense_date: draft.date ?? null,
    p_paid_by: draft.paidBy ?? null, p_participant_ids: draft.participants ?? null, p_notes: null,
  })
const today = new Date().toISOString().slice(0, 10)

const owner = await user('owner', 'Olive Owner')
const bob = await user('bob', 'Bob Member')
const eve = await user('eve', 'Eve Member')
const cara = await user('cara', 'Cara Outsider')
const dan = await user('dan', 'Dan Former')

const name = `Smart ${run}`
await owner.client.from('groups').insert({ name, description: null, created_by: owner.id })
const groupId = (await owner.client.from('groups').select('id').eq('name', name).limit(1)).data[0].id
for (const m of [bob, eve, dan]) await owner.client.rpc('add_group_member_by_email', { target_group_id: groupId, target_email: email(m.key) })
await owner.client.rpc('remove_group_member', { p_group_id: groupId, p_user_id: dan.id })

const anon = newClient()
const l = {
  eve: await listen(eve.client, 'eve', groupId),
  cara: await listen(cara.client, 'cara', groupId),
  dan: await listen(dan.client, 'dan', groupId),
  anon: await listen(anon, 'anon', groupId),
}
check('a member subscribes to candidates', l.eve.status === 'SUBSCRIBED', l.eve.status)
await sleep(1500)

// 1. Propose -> INSERT to members only.
const everyone = [owner.id, bob.id, eve.id]
const m1 = await send(bob, groupId, 'I paid $84.50 for dinner, split with everyone')
const p1 = await propose(bob, m1.id, { description: 'dinner', amountCents: 8450, date: today, paidBy: bob.id, participants: everyone })
check('the sender proposes a candidate', !p1.error && p1.data?.status === 'proposed', p1.error?.message)
check('another member receives the proposal in realtime',
  await waitFor(() => l.eve.events.some((e) => e.type === 'INSERT' && e.row.id === p1.data?.id)))
const again = await propose(bob, m1.id, { description: 'changed', amountCents: 1 })
check('proposing again returns the same candidate', again.data?.id === p1.data?.id && again.data?.amount_cents === 8450)
const notMine = await propose(owner, m1.id, {})
check('nobody else can propose on the message', notMine.error?.message === 'forbidden', notMine.error?.message)

// 2. Approve -> the canonical expense and balances; UPDATE delivered.
const before = (await eve.client.rpc('get_group_balances', { p_group_id: groupId })).data ?? []
const ap = await bob.client.rpc('approve_expense_candidate', { p_id: p1.data.id, p_expected_version: 1 })
check('the proposer approves it', !ap.error && typeof ap.data === 'string', ap.error?.message)
check('others receive the approval in realtime',
  await waitFor(() => l.eve.events.some((e) => e.type === 'UPDATE' && e.row.id === p1.data.id && e.row.status === 'approved')))
const expense = await eve.client.from('expenses').select('id, amount_cents, created_by, paid_by').eq('id', ap.data).limit(1)
check('the expense is visible to members', expense.data?.[0]?.amount_cents === 8450 && expense.data[0].created_by === bob.id)
const splits = await eve.client.from('expense_splits').select('user_id, share_cents').eq('expense_id', ap.data)
check('its canonical shares sum to the amount', (splits.data ?? []).reduce((s, r) => s + r.share_cents, 0) === 8450, JSON.stringify(splits.data))
const after = (await eve.client.rpc('get_group_balances', { p_group_id: groupId })).data ?? []
const net = (rows, id) => rows.find((r) => r.user_id === id)?.net_cents ?? 0
const bobShare = (splits.data ?? []).find((r) => r.user_id === bob.id)?.share_cents
check('balances reflect it for everyone', net(after, bob.id) - net(before, bob.id) === 8450 - bobShare && after.reduce((s, r) => s + r.net_cents, 0) === 0,
  `bob ${net(before, bob.id)} -> ${net(after, bob.id)}`)
const ev = await eve.client.from('group_events').select('kind, payload').eq('subject_id', ap.data)
check('the activity event carries the candidate provenance',
  ev.data?.length === 1 && ev.data[0].kind === 'expense_created' && ev.data[0].payload.candidate_id === p1.data.id && ev.data[0].payload.proposed_by === bob.id)
const ap2 = await bob.client.rpc('approve_expense_candidate', { p_id: p1.data.id, p_expected_version: 1 })
check('approving again returns the same expense', ap2.data === ap.data)

// 3. Outsiders, former members and anon see nothing.
await sleep(4000)
check('an outsider receives nothing in realtime', l.cara.events.length === 0)
check('a former member receives nothing', l.dan.events.length === 0)
check('anon receives nothing', l.anon.events.length === 0)
const caraRead = await cara.client.from('expense_candidates').select('id').eq('group_id', groupId)
check('an outsider reads no candidates', !caraRead.error && caraRead.data.length === 0)
const danRead = await dan.client.from('expense_candidates').select('id').eq('group_id', groupId)
check('a former member reads no candidates', !danRead.error && danRead.data.length === 0)
const caraApprove = await cara.client.rpc('approve_expense_candidate', { p_id: p1.data.id, p_expected_version: 2 })
check('an outsider cannot approve', caraApprove.error?.message === 'not_found_or_forbidden', caraApprove.error?.message)
const direct = await bob.client.from('expense_candidates').update({ amount_cents: 1 }).eq('id', p1.data.id).select()
check('no direct writes', Boolean(direct.error) || direct.data.length === 0, direct.error?.code)

// 4. The owner approves a departed proposer's candidate.
const m2 = await send(eve, groupId, 'Eve paid 30 for taxi split with Olive')
const p2 = await propose(eve, m2.id, { description: 'taxi', amountCents: 3000, date: today, paidBy: owner.id, participants: [owner.id, bob.id] })
await eve.client.rpc('leave_group', { p_group_id: groupId })
const eveApprove = await eve.client.rpc('approve_expense_candidate', { p_id: p2.data.id, p_expected_version: 1 })
check('a proposer who left cannot approve', eveApprove.error?.message === 'not_found_or_forbidden', eveApprove.error?.message)
const ownerApprove = await owner.client.rpc('approve_expense_candidate', { p_id: p2.data.id, p_expected_version: 1 })
check('the owner approves a departed proposer\'s candidate', !ownerApprove.error && typeof ownerApprove.data === 'string', ownerApprove.error?.message)

// 5. Incomplete drafts and rejections.
const m3 = await send(bob, groupId, '/expense 12 coffee')
const p3 = await propose(bob, m3.id, { description: 'coffee', amountCents: 1200, date: today })
const inc = await bob.client.rpc('approve_expense_candidate', { p_id: p3.data.id, p_expected_version: 1 })
check('an incomplete draft cannot be approved', inc.error?.message === 'candidate_incomplete', inc.error?.message)
const rej = await bob.client.rpc('reject_expense_candidate', { p_id: p3.data.id, p_expected_version: 1 })
const afterRej = await bob.client.rpc('approve_expense_candidate', { p_id: p3.data.id, p_expected_version: 2 })
check('a rejected candidate cannot be approved', !rej.error && afterRej.error?.message === 'candidate_rejected', afterRej.error?.message)

for (const x of Object.values(l)) await x.channel.unsubscribe()
for (const c of [owner, bob, eve, cara, dan]) c.client.realtime.disconnect()
anon.realtime.disconnect()

const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} checks passed`)
process.exit(passed === results.length ? 0 : 1)
