#!/usr/bin/env node
// Phase 8 behavioural security audit on SplitChat-Dev: what anonymous
// callers, outsiders and former members can actually read, write, call and
// receive — through the real Supabase APIs (PostgREST, RPC, Realtime) with
// each user's own JWT. Fresh synthetic users per run. Complements the
// read-only catalog audit (supabase/ops/security_audit.sql).
//
//   node scripts/rehearsal/api-security-audit.mjs

import crypto from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { createClient } from '@supabase/supabase-js'
import { loadDevTarget, verifySentinel } from './dev.mjs'

const t = loadDevTarget()
verifySentinel(t)
const run = Date.now()
const password = crypto.randomBytes(18).toString('base64url') + 'Aa9!'
const email = (k) => `splitchat-rehearsal+sec-${k}-${run}@example.com`
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
const must = (r, what) => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`)
  return r.data
}

// ---- A group with one of everything -------------------------------------------
const owner = await user('owner', 'Olive Owner')
const member = await user('member', 'Mia Member')
const former = await user('former', 'Fred Former')
const outsider = await user('out', 'Oscar Outsider')
const anon = newClient()

const name = `Audit ${run}`
must(await owner.client.from('groups').insert({ name, description: 'private', created_by: owner.id }), 'group')
const groupId = must(await owner.client.from('groups').select('id').eq('name', name).limit(1), 'group id')[0].id
for (const m of [member, former]) must(await owner.client.rpc('add_group_member_by_email', { target_group_id: groupId, target_email: email(m.key) }), 'add')
const today = new Date().toISOString().slice(0, 10)
const expenseId = must(await owner.client.rpc('create_equal_split_expense_v2', {
  p_group_id: groupId, p_description: 'Secret dinner', p_amount_cents: 9000, p_expense_date: today,
  p_paid_by: owner.id, p_participant_ids: [owner.id, member.id, former.id], p_notes: 'private note',
}), 'expense')
const settlementId = must(await member.client.rpc('record_settlement', {
  p_group_id: groupId, p_from_user: member.id, p_to_user: owner.id, p_amount_cents: 1000, p_settled_on: today,
  p_note: 'private transfer', p_client_request_id: crypto.randomUUID(),
}), 'settlement')
const message = must(await member.client.rpc('send_group_message', { p_group_id: groupId, p_body: 'private message', p_client_request_id: crypto.randomUUID() }), 'message')
const candidate = must(await member.client.rpc('propose_expense_candidate', {
  p_message_id: message.id, p_source: 'manual', p_interpreter_version: 'audit', p_description: 'private proposal',
  p_amount_cents: 500, p_expense_date: today, p_paid_by: member.id, p_participant_ids: [member.id, owner.id], p_notes: null,
}), 'candidate')
must(await owner.client.rpc('remove_group_member', { p_group_id: groupId, p_user_id: former.id }), 'remove former')

// ---- Reads -------------------------------------------------------------------
const TABLES = {
  groups: ['id', groupId],
  group_members: ['group_id', groupId],
  expenses: ['group_id', groupId],
  expense_splits: ['expense_id', expenseId],
  group_events: ['group_id', groupId],
  settlements: ['group_id', groupId],
  group_messages: ['group_id', groupId],
  expense_candidates: ['group_id', groupId],
}
for (const [role, u] of [['anon', { client: anon }], ['outsider', outsider], ['former member', former]]) {
  for (const [table, [col, val]] of Object.entries(TABLES)) {
    const r = await u.client.from(table).select('*').eq(col, val)
    check(`${role} reads nothing from ${table}`, Boolean(r.error) || r.data.length === 0, r.error ? r.error.code : `${r.data.length} rows`)
  }
}
for (const [table, [col, val]] of Object.entries(TABLES)) {
  const r = await member.client.from(table).select('*').eq(col, val)
  check(`an active member reads ${table}`, !r.error && r.data.length > 0, r.error?.message ?? `${r.data.length} rows`)
}
const events = must(await member.client.from('group_events').select('kind, payload').eq('group_id', groupId), 'events')
const leaked = JSON.stringify(events).match(/private (note|transfer|message|proposal)|Secret dinner/g)
check('activity events carry no free text (notes, messages, proposals)', !leaked, leaked?.join(', '))
const outsiderProfiles = await outsider.client.from('profiles').select('id').in('id', [owner.id, member.id])
check('an outsider cannot read members\' profiles', !outsiderProfiles.error && outsiderProfiles.data.length === 0)

// ---- Direct writes (as an active member, and anon) ---------------------------------
const writes = [
  ['insert expenses', (c) => c.from('expenses').insert({ group_id: groupId, description: 'x', amount: 1, paid_by: member.id, created_by: member.id })],
  ['update expenses', (c) => c.from('expenses').update({ description: 'hijacked' }).eq('id', expenseId).select()],
  ['delete expenses', (c) => c.from('expenses').delete().eq('id', expenseId).select()],
  ['insert expense_splits', (c) => c.from('expense_splits').insert({ expense_id: expenseId, user_id: member.id, share_amount: 1 })],
  ['update expense_splits', (c) => c.from('expense_splits').update({ share_amount: 0.01 }).eq('expense_id', expenseId).select()],
  ['insert group_members', (c) => c.from('group_members').insert({ group_id: groupId, user_id: outsider.id, role: 'owner' })],
  ['update group_members', (c) => c.from('group_members').update({ role: 'owner' }).eq('group_id', groupId).select()],
  ['delete group_members', (c) => c.from('group_members').delete().eq('group_id', groupId).select()],
  ['update groups', (c) => c.from('groups').update({ name: 'hijacked' }).eq('id', groupId).select()],
  ['delete groups', (c) => c.from('groups').delete().eq('id', groupId).select()],
  ['insert group_events', (c) => c.from('group_events').insert({ group_id: groupId, kind: 'expense_created', people: [] })],
  ['update group_events', (c) => c.from('group_events').update({ payload: {} }).eq('group_id', groupId).select()],
  ['insert settlements', (c) => c.from('settlements').insert({ group_id: groupId, from_user: owner.id, to_user: member.id, amount_cents: 1, settled_on: today, created_by: member.id })],
  ['update settlements', (c) => c.from('settlements').update({ amount_cents: 1 }).eq('id', settlementId).select()],
  ['delete settlements', (c) => c.from('settlements').delete().eq('id', settlementId).select()],
  ['insert group_messages', (c) => c.from('group_messages').insert({ group_id: groupId, sender_id: owner.id, body: 'forged', client_request_id: crypto.randomUUID() })],
  ['update group_messages', (c) => c.from('group_messages').update({ body: 'edited' }).eq('id', message.id).select()],
  ['delete group_messages', (c) => c.from('group_messages').delete().eq('id', message.id).select()],
  ['insert expense_candidates', (c) => c.from('expense_candidates').insert({ group_id: groupId, message_id: message.id, proposed_by: owner.id, source: 'manual', interpreter_version: 'x' })],
  ['update expense_candidates', (c) => c.from('expense_candidates').update({ amount_cents: 1 }).eq('id', candidate.id).select()],
  ['delete expense_candidates', (c) => c.from('expense_candidates').delete().eq('id', candidate.id).select()],
  ['update another person\'s profile', (c) => c.from('profiles').update({ full_name: 'Hacked' }).eq('id', owner.id).select()],
]
for (const [label, attempt] of writes) {
  for (const [role, c] of [['member', member.client], ['anon', anon]]) {
    const r = await attempt(c)
    check(`${role} cannot ${label}`, Boolean(r.error) || (Array.isArray(r.data) && r.data.length === 0), r.error?.code ?? `${r.data?.length ?? 0} rows`)
  }
}
const ownProfile = await member.client.from('profiles').update({ full_name: 'Mia M.' }).eq('id', member.id).select()
check('a member can rename their own profile', !ownProfile.error && ownProfile.data.length === 1)
const intact = must(await owner.client.from('expenses').select('description').eq('id', expenseId), 'intact')
check('the ledger is untouched after all write attempts', intact[0]?.description === 'Secret dinner')

// ---- RPCs --------------------------------------------------------------------------
const rpcs = [
  ['get_group_balances', { p_group_id: groupId }],
  ['get_ledger_identities', { p_group_id: groupId }],
  ['send_group_message', { p_group_id: groupId, p_body: 'x', p_client_request_id: crypto.randomUUID() }],
  ['create_equal_split_expense_v2', { p_group_id: groupId, p_description: 'x', p_amount_cents: 100, p_expense_date: today, p_paid_by: owner.id, p_participant_ids: [owner.id], p_notes: null }],
  ['record_settlement', { p_group_id: groupId, p_from_user: member.id, p_to_user: owner.id, p_amount_cents: 1, p_settled_on: today }],
  ['void_settlement', { p_settlement_id: settlementId, p_reason: 'x' }],
  ['approve_expense_candidate', { p_id: candidate.id, p_expected_version: 1 }],
  ['reject_expense_candidate', { p_id: candidate.id, p_expected_version: 1 }],
  ['update_expense_candidate', { p_id: candidate.id, p_expected_version: 1, p_description: 'x', p_amount_cents: 1, p_expense_date: today, p_paid_by: member.id, p_participant_ids: [member.id], p_notes: null }],
  ['propose_expense_candidate', { p_message_id: message.id, p_source: 'manual', p_interpreter_version: 'x', p_description: null, p_amount_cents: null, p_expense_date: null, p_paid_by: null, p_participant_ids: null, p_notes: null }],
  ['delete_expense', { p_expense_id: expenseId, p_expected_updated_at: new Date().toISOString() }],
  ['leave_group', { p_group_id: groupId }],
  ['delete_group', { p_group_id: groupId }],
  ['transfer_group_ownership', { p_group_id: groupId, p_new_owner_id: outsider.id }],
  ['remove_group_member', { p_group_id: groupId, p_user_id: member.id }],
  ['add_group_member_by_email', { target_group_id: groupId, target_email: email('out') }],
]
for (const [fn, args] of rpcs) {
  const a = await anon.rpc(fn, args)
  check(`anon cannot call ${fn}`, Boolean(a.error), a.error?.code)
  for (const [role, u] of [['outsider', outsider], ['former member', former]]) {
    const r = await u.client.rpc(fn, args)
    check(`${role} is refused by ${fn}`, Boolean(r.error), r.error?.message)
  }
}
const privateCall = await member.client.schema('private').rpc('my_active_group_ids')
check('the private schema is not exposed through the API', Boolean(privateCall.error), privateCall.error?.code)

// ---- Realtime -------------------------------------------------------------------------
async function listen(client, table, filtered) {
  const got = []
  const ch = client.channel(`sec-${table}-${filtered}-${crypto.randomUUID()}`)
    .on('postgres_changes', { event: '*', schema: 'public', table, ...(filtered ? { filter: `group_id=eq.${groupId}` } : {}) }, (p) => got.push(p))
  const status = await new Promise((resolve) => {
    ch.subscribe((s) => (s === 'SUBSCRIBED' || s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') && resolve(s))
    setTimeout(() => resolve('NO_STATUS'), 20000)
  })
  return { ch, got, status }
}
// The control subscribes first, so the negatives below are measured against
// a subscription known to receive this group's changes.
const memberWatch = await listen(member.client, 'group_messages', true)
const listeners = []
for (const table of ['group_messages', 'expense_candidates', 'expenses', 'settlements', 'group_events']) {
  for (const [role, c] of [['outsider', outsider.client], ['former member', former.client], ['anon', anon]]) {
    for (const filtered of [true, false]) listeners.push({ role, table, filtered, ...(await listen(c, table, filtered)) })
  }
}
// A listener that never joined "receives nothing" vacuously: every one must be live.
const notJoined = [...listeners, memberWatch].filter((l) => l.status !== 'SUBSCRIBED')
check('every Realtime listener actually joined', notJoined.length === 0, notJoined.map((l) => `${l.role ?? 'member'}/${l.table ?? 'group_messages'}: ${l.status}`).join(', '))
await sleep(1500)
const m2 = must(await owner.client.rpc('send_group_message', { p_group_id: groupId, p_body: 'after subscribe', p_client_request_id: crypto.randomUUID() }), 'm2')
must(await owner.client.rpc('propose_expense_candidate', {
  p_message_id: m2.id, p_source: 'manual', p_interpreter_version: 'audit', p_description: null, p_amount_cents: null,
  p_expense_date: today, p_paid_by: null, p_participant_ids: null, p_notes: null,
}), 'candidate 2')
must(await member.client.rpc('reject_expense_candidate', { p_id: candidate.id, p_expected_version: 1 }), 'reject')
for (let i = 0; i < 100 && !memberWatch.got.length; i++) await sleep(200)
check('control: an active member receives the new message', memberWatch.got.length > 0)
await sleep(5000)
for (const l of listeners) {
  check(`${l.role} receives nothing from ${l.table} (${l.filtered ? 'filtered' : 'unfiltered'})`, l.got.length === 0, `${l.got.length} events`)
  if (l.got.length && process.env.AUDIT_DEBUG) console.log(JSON.stringify(l.got).slice(0, 1500))
}

// DELETE events (Realtime does not filter them by RLS): the only source is
// deleting a solo group with its messages and proposals. Measure exactly what
// other subscribers receive.
const soloName = `Solo ${run}`
must(await owner.client.from('groups').insert({ name: soloName, description: null, created_by: owner.id }), 'solo')
const soloId = must(await owner.client.from('groups').select('id').eq('name', soloName).limit(1), 'solo id')[0].id
const soloMsg = must(await owner.client.rpc('send_group_message', { p_group_id: soloId, p_body: 'solo secret', p_client_request_id: crypto.randomUUID() }), 'solo msg')
must(await owner.client.rpc('propose_expense_candidate', {
  p_message_id: soloMsg.id, p_source: 'manual', p_interpreter_version: 'audit', p_description: 'solo secret', p_amount_cents: null,
  p_expense_date: today, p_paid_by: null, p_participant_ids: null, p_notes: null,
}), 'solo candidate')
for (const l of listeners) l.got.length = 0
must(await owner.client.rpc('delete_group', { p_group_id: soloId }), 'delete solo')
await sleep(8000)
const deletes = listeners.filter((l) => l.got.length)
const payloads = deletes.flatMap((l) => l.got.map((p) => JSON.stringify({ type: p.eventType, old: p.old, new: p.new })))
const leaksContent = payloads.some((p) => /solo secret|group_id|sender_id|body|proposed_by/.test(p))
check('a deleted solo group leaks no content, group or person to other subscribers', !leaksContent, payloads.slice(0, 2).join(' '))
console.log(`INFO  DELETE notifications reaching non-members: ${deletes.map((l) => `${l.role}/${l.table}/${l.filtered ? 'f' : 'u'}:${l.got.length}`).join(', ') || 'none'}`)
if (payloads.length) console.log(`INFO  sample DELETE payload: ${payloads[0]}`)

for (const l of [...listeners, memberWatch]) await l.ch.unsubscribe()
for (const c of [owner, member, former, outsider]) c.client.realtime.disconnect()
anon.realtime.disconnect()

const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} security checks passed`)
process.exit(passed === results.length ? 0 : 1)
