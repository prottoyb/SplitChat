#!/usr/bin/env node
// SplitChat-Dev check of M18 (group chat, ADR-0011 condition 13) through the
// real APIs: supabase-js as the frontend uses it, PostgREST, RLS and Realtime
// Postgres Changes with each user's own JWT. Fresh synthetic users per run.
// Target guard: loadDevTarget + sentinel.
//
//   node scripts/rehearsal/api-chat.mjs

import crypto from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { createClient } from '@supabase/supabase-js'
import { loadDevTarget, verifySentinel } from './dev.mjs'

const t = loadDevTarget()
verifySentinel(t)
const run = Date.now()
const password = crypto.randomBytes(18).toString('base64url') + 'Aa9!'
const email = (k) => `splitchat-rehearsal+chat-${k}-${run}@example.com`
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

// Subscribes to INSERTs on group_messages (optionally filtered by group) and
// records every payload received.
async function listen(client, label, groupId) {
  const received = []
  const channel = client
    .channel(`chat-${label}-${run}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'group_messages', ...(groupId ? { filter: `group_id=eq.${groupId}` } : {}) },
      (payload) => received.push(payload.new),
    )
  const status = await new Promise((resolve) => {
    channel.subscribe((s) => {
      if (s === 'SUBSCRIBED' || s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') resolve(s)
    })
    setTimeout(() => resolve('NO_STATUS'), 15000)
  })
  return { channel, received, status }
}

async function waitFor(predicate, ms = 15000) { // free-tier Realtime can take several seconds
  for (let waited = 0; waited < ms; waited += 200) {
    if (predicate()) return true
    await sleep(200)
  }
  return predicate()
}

const send = (u, groupId, body, requestId = crypto.randomUUID()) =>
  u.client.rpc('send_group_message', { p_group_id: groupId, p_body: body, p_client_request_id: requestId })

const owner = await user('owner', 'Olive Owner')
const bob = await user('bob', 'Bob Member')
const eve = await user('eve', 'Eve Member')
const cara = await user('cara', 'Cara Outsider')
const dan = await user('dan', 'Dan Former')

const name = `Chat ${run}`
await owner.client.from('groups').insert({ name, description: null, created_by: owner.id })
const groupId = (await owner.client.from('groups').select('id').eq('name', name).limit(1)).data[0].id
for (const m of [bob, eve, dan]) await owner.client.rpc('add_group_member_by_email', { target_group_id: groupId, target_email: email(m.key) })
await owner.client.rpc('remove_group_member', { p_group_id: groupId, p_user_id: dan.id })

const anon = newClient()
const listeners = {
  bob: await listen(bob.client, 'bob', groupId),
  eve: await listen(eve.client, 'eve', groupId),
  caraFiltered: await listen(cara.client, 'cara-f', groupId),
  caraAll: await listen(cara.client, 'cara-all', null),
  dan: await listen(dan.client, 'dan', groupId),
  anon: await listen(anon, 'anon', groupId),
}
check('members subscribe', listeners.bob.status === 'SUBSCRIBED' && listeners.eve.status === 'SUBSCRIBED',
  `${listeners.bob.status}/${listeners.eve.status}`)
console.log(`      outsider/former/anon subscription status: ${listeners.caraFiltered.status}, ${listeners.caraAll.status}, ${listeners.dan.status}, ${listeners.anon.status}`)
await sleep(1500)

// 1. Delivery to members only.
const first = await send(owner, groupId, '  Rent is due Friday  ')
check('a member sends through the RPC', !first.error && first.data?.body === 'Rent is due Friday', first.error?.message)
check('the id is a JSON integer', Number.isSafeInteger(first.data?.id))
const bobGot = await waitFor(() => listeners.bob.received.length >= 1)
check('another member receives the message in realtime', bobGot && listeners.bob.received[0]?.id === first.data?.id)
await sleep(5000)
check('exactly one event per message', listeners.bob.received.length === 1, `${listeners.bob.received.length}`)
check('an outsider subscribed with the group filter receives nothing', listeners.caraFiltered.received.length === 0)
check('an outsider subscribed to the whole table receives nothing', listeners.caraAll.received.length === 0)
check('a former member receives nothing', listeners.dan.received.length === 0)
check('an anonymous client receives nothing', listeners.anon.received.length === 0)

// 2. Reads through PostgREST.
const bobRead = await bob.client.from('group_messages').select('id, body, sender_id').eq('group_id', groupId)
check('a member reads the message', bobRead.data?.length === 1 && bobRead.data[0].sender_id === owner.id)
const caraRead = await cara.client.from('group_messages').select('id').eq('group_id', groupId)
check('an outsider reads nothing', !caraRead.error && caraRead.data.length === 0)
const danRead = await dan.client.from('group_messages').select('id').eq('group_id', groupId)
check('a former member reads nothing', !danRead.error && danRead.data.length === 0)
const anonRead = await anon.from('group_messages').select('id')
check('anon cannot read', Boolean(anonRead.error) || anonRead.data.length === 0, anonRead.error?.code)

// 3. Writes are refused outside the RPC and for non-members.
const caraSend = await send(cara, groupId, 'let me in')
check('an outsider cannot send', caraSend.error?.message === 'not_found_or_forbidden', caraSend.error?.message)
const danSend = await send(dan, groupId, 'still here?')
check('a former member cannot send', danSend.error?.message === 'not_found_or_forbidden', danSend.error?.message)
const anonSend = await send({ client: anon }, groupId, 'hi')
check('anon cannot send', Boolean(anonSend.error), anonSend.error?.code)
const forged = await bob.client.from('group_messages').insert({ group_id: groupId, sender_id: owner.id, body: 'forged', client_request_id: crypto.randomUUID() })
check('a direct insert (forged sender) is refused', Boolean(forged.error), forged.error?.code)
const edit = await owner.client.from('group_messages').update({ body: 'edited' }).eq('id', first.data.id).select()
check('a message cannot be edited', Boolean(edit.error) || edit.data.length === 0, edit.error?.code)

// 4. Idempotent retry.
const requestId = crypto.randomUUID()
const a = await send(bob, groupId, 'Dinner at 7?', requestId)
const b = await send(bob, groupId, 'Dinner at 7?', requestId)
check('a retried send returns the same message', !a.error && a.data?.id === b.data?.id, `${a.data?.id} ${b.data?.id}`)
const c = await send(bob, groupId, 'Dinner at 8?', requestId)
check('a reused request id with a different body is refused', c.error?.message === 'duplicate_request', c.error?.message)
const blank = await send(bob, groupId, '   ')
check('a blank message is refused', blank.error?.message === 'invalid_body', blank.error?.message)
await sleep(2000)

// 5. A JWT refresh keeps delivery working.
const refreshed = await eve.client.auth.refreshSession()
eve.client.realtime.setAuth(refreshed.data.session?.access_token)
const eveBefore = listeners.eve.received.length
const afterRefresh = await send(owner, groupId, 'After the refresh')
check('a member still receives after a token refresh',
  await waitFor(() => listeners.eve.received.some((r) => r.id === afterRefresh.data?.id)), `${listeners.eve.received.length - eveBefore} new`)

// 6. Removal takes effect from the next message.
await owner.client.rpc('remove_group_member', { p_group_id: groupId, p_user_id: bob.id })
const bobBefore = listeners.bob.received.length
const afterRemoval = await send(owner, groupId, 'After Bob left')
await waitFor(() => listeners.eve.received.some((r) => r.id === afterRemoval.data?.id))
await sleep(5000)
check('a removed member stops receiving from the next message', listeners.bob.received.length === bobBefore,
  `${listeners.bob.received.length - bobBefore} after removal`)

// 7. Names: a former sender stays nameable; no group_events from chat.
const names = await owner.client.rpc('get_ledger_identities', { p_group_id: groupId })
check('a former sender stays nameable', (names.data ?? []).some((n) => n.user_id === bob.id && n.display_name === 'Bob Member'))
const events = await owner.client.from('group_events').select('kind').eq('group_id', groupId)
check('chat writes no activity events', !(events.data ?? []).some((e) => !/^(group_created|member_)/.test(e.kind)),
  (events.data ?? []).map((e) => e.kind).join(','))

for (const l of Object.values(listeners)) await l.channel.unsubscribe()
for (const c of [owner, bob, eve, cara, dan]) c.client.realtime.disconnect()
anon.realtime.disconnect()

const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} checks passed`)
process.exit(passed === results.length ? 0 : 1)
