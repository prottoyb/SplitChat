#!/usr/bin/env node
// QS-B3-1 on real Supabase (SplitChat-Dev only): owner account deletion vs
// add-by-email, with one side held open in a real database session while
// the other goes through the real API.
//
//   add first:    session A runs the real add_group_member_by_email RPC as
//                 the owner (JWT claims + role authenticated) and keeps the
//                 transaction open; the owner's deletion through the REAL
//                 GoTrue admin API must wait, then be refused
//                 (owner_must_transfer) once A commits.
//   delete first: session A deletes the owner's auth.users row (the same
//                 BEFORE DELETE trigger GoTrue fires) and keeps it open; the
//                 owner's add through REAL PostgREST must wait, then be
//                 refused (not_found_or_forbidden) once A commits.
// Fresh synthetic users per run. Target guard: loadDevTarget + sentinel.

import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { isolatedEnv } from '../db-test.mjs'
import { loadDevTarget, verifySentinel } from './dev.mjs'

const t = loadDevTarget()
verifySentinel(t)
const run = Date.now()
const password = crypto.randomBytes(18).toString('base64url') + 'Aa9!'
const email = (k) => `splitchat-rehearsal+race-${k}-${run}@example.com`
const admin = createClient(t.url, t.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
const results = []
const check = (name, pass, detail = '') => {
  results.push(Boolean(pass))
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
const pgBin = (n) => path.join(process.env.SPLITCHAT_PG_BIN || 'C:\\Program Files\\PostgreSQL\\17\\bin', process.platform === 'win32' ? `${n}.exe` : n)

// A long-lived psql session: statements are written to stdin, and `mark()`
// waits until everything written so far has executed.
function session() {
  const p = spawn(pgBin('psql'), ['-X', '-q', '-v', 'ON_ERROR_STOP=0', '-d', t.dbUrl], {
    env: { ...isolatedEnv(process.env, os.tmpdir()), PGPASSWORD: t.password }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  p.stdout.on('data', (d) => { out += d })
  p.stderr.on('data', (d) => { err += d })
  let n = 0
  return {
    send: (sql) => p.stdin.write(`${sql}\n`),
    mark: (ms = 20000) => new Promise((resolve, reject) => {
      const tag = `__MARK_${++n}__`
      p.stdin.write(`\\echo ${tag}\n`)
      const start = Date.now()
      const iv = setInterval(() => {
        if (out.includes(tag)) { clearInterval(iv); resolve() }
        else if (Date.now() - start > ms) { clearInterval(iv); reject(new Error(`timeout; stderr: ${err.slice(-300)}`)) }
      }, 50)
    }),
    errors: () => err,
    close: () => new Promise((resolve) => { p.on('close', resolve); p.stdin.end() }),
  }
}

async function user(key, name) {
  const { data, error } = await admin.auth.admin.createUser({ email: email(key), password, email_confirm: true, user_metadata: { full_name: name } })
  if (error) throw new Error(`create ${key}: ${error.message}`)
  const client = createClient(t.url, t.anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const s = await client.auth.signInWithPassword({ email: email(key), password })
  if (s.error) throw new Error(`sign in ${key}: ${s.error.message}`)
  return { id: data.user.id, client }
}
async function soloGroup(owner, name) {
  const ins = await owner.client.from('groups').insert({ name, description: null, created_by: owner.id })
  if (ins.error) throw new Error(ins.error.message)
  return (await owner.client.from('groups').select('id').eq('name', name).limit(1)).data[0].id
}
const pending = async (promise, ms = 2000) => {
  const marker = Symbol('pending')
  return (await Promise.race([promise.then(() => 'settled'), new Promise((r) => setTimeout(() => r(marker), ms))])) === marker
}
const asOwner = (id) => `SELECT set_config('request.jwt.claims', '{"sub":"${id}","role":"authenticated"}', true), set_config('request.jwt.claim.sub', '${id}', true);`

async function addFirst() {
  const owner = await user('owner-a', 'Race Owner A')
  await user('member-a', 'Race Member A')
  const g = await soloGroup(owner, `Race add-first ${run}`)
  const a = session()
  a.send('BEGIN;')
  a.send(asOwner(owner.id))
  a.send('SET LOCAL ROLE authenticated;')
  a.send(`SELECT result FROM public.add_group_member_by_email('${g}', '${email('member-a')}');`)
  await a.mark()
  const del = admin.auth.admin.deleteUser(owner.id)
  check('add first: real GoTrue deletion of the owner waits for the open add', await pending(del))
  a.send('COMMIT;')
  await a.mark()
  const r = await del
  check('add first: the deletion is then refused (owner_must_transfer)', Boolean(r.error) && /owner_must_transfer|Database error/.test(r.error.message), r.error?.message ?? 'deleted!')
  const u = await admin.auth.admin.getUserById(owner.id)
  const m = await owner.client.from('group_members').select('user_id, role').eq('group_id', g)
  check('add first: owner still exists and the group has its owner and the new member', !u.error && m.data?.length === 2 && m.data.some((x) => x.role === 'owner'))
  await a.close()
}

async function deleteFirst() {
  const owner = await user('owner-b', 'Race Owner B')
  await user('member-b', 'Race Member B')
  const g = await soloGroup(owner, `Race delete-first ${run}`)
  const a = session()
  a.send('BEGIN;')
  a.send(`DELETE FROM auth.users WHERE id = '${owner.id}';`)
  await a.mark()
  const add = owner.client.rpc('add_group_member_by_email', { target_group_id: g, target_email: email('member-b') })
  check('delete first: the owner\'s real PostgREST add waits for the open deletion', await pending(add))
  a.send('COMMIT;')
  await a.mark()
  const r = await add
  check('delete first: the add is then refused (not_found_or_forbidden)', r.error?.message === 'not_found_or_forbidden', r.error?.message ?? JSON.stringify(r.data))
  const m = await admin.from('group_members').select('user_id, role, left_at').eq('group_id', g)
  check('delete first: no active member without an owner (group orphaned with zero active members)',
    m.data?.length === 1 && m.data[0].left_at !== null, JSON.stringify(m.data))
  await a.close()
}

try {
  await addFirst()
  await deleteFirst()
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} race checks passed`)
  process.exit(failed ? 1 : 0)
} catch (error) {
  console.error(`ERROR: ${error.message}`)
  process.exit(1)
}
