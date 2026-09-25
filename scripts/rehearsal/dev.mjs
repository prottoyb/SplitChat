#!/usr/bin/env node
// Tier-2 rehearsal tool for the SplitChat-Dev Supabase project (ADR-0007).
// It can only ever act on SplitChat-Dev:
//   - target settings come from the git-ignored .env.splitchat-dev.local,
//     never from DB_URL or any PG* variable (all scrubbed from children);
//   - the production project ref is refused outright;
//   - positive identification: on first contact (`init`) a sentinel schema
//     carrying the dev ref is created, and only if the database has no app
//     tables; every later command first verifies that sentinel.
// Passwords and keys are never printed; output is redacted.
//
// Usage: node scripts/rehearsal/dev.mjs <init|check|sql|file|dump|cli> [...]

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isolatedEnv } from '../db-test.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PROD_REF = 'jhftlnsccurhfgneltgi'
const SENTINEL = 'splitchat_rehearsal_sentinel'

export function loadDevTarget() {
  const file = path.join(root, '.env.splitchat-dev.local')
  if (!fs.existsSync(file)) throw new Error('.env.splitchat-dev.local not found')
  const env = {}
  for (const line of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m) env[m[1]] = m[2]
  }
  const ref = env.SPLITCHAT_DEV_PROJECT_REF
  if (!/^[a-z0-9]{20}$/.test(ref ?? '')) throw new Error('invalid dev project ref')
  if (ref === PROD_REF || env.SPLITCHAT_PROD_PROJECT_REF_DO_NOT_TARGET !== PROD_REF) {
    throw new Error('REFUSING: dev target is the production project or the guard value is missing')
  }
  if (env.SPLITCHAT_DEV_URL !== `https://${ref}.supabase.co`) throw new Error('dev URL does not match dev ref')
  const password = env.SPLITCHAT_DEV_DB_PASSWORD
  const host = env.SPLITCHAT_DEV_POOLER_HOST
  const dbUrl = `postgresql://postgres.${ref}:${encodeURIComponent(password)}@${host}:5432/postgres?sslmode=require`
  return { ref, dbUrl, password, url: env.SPLITCHAT_DEV_URL, anonKey: env.SPLITCHAT_DEV_ANON_KEY, serviceKey: env.SPLITCHAT_DEV_SERVICE_ROLE_KEY }
}

function pgBin(name) {
  const dir = process.env.SPLITCHAT_PG_BIN || (process.platform === 'win32' ? 'C:\\Program Files\\PostgreSQL\\17\\bin' : '')
  const exe = process.platform === 'win32' ? `${name}.exe` : name
  return dir ? path.join(dir, exe) : exe
}

function redact(text, t) {
  return String(text)
    .split(t.password).join('<redacted>')
    .split(encodeURIComponent(t.password)).join('<redacted>')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<redacted-jwt>')
    .replace(/sbp_[A-Za-z0-9]+/g, '<redacted-token>')
}

const childEnv = isolatedEnv(process.env, os.tmpdir())

function psql(t, args) {
  const r = spawnSync(pgBin('psql'), ['-X', '-v', 'ON_ERROR_STOP=1', '-d', t.dbUrl, ...args], { encoding: 'utf8', env: childEnv, maxBuffer: 64 * 1024 * 1024 })
  if (r.error) throw r.error
  return { status: r.status, out: redact(r.stdout, t), err: redact(r.stderr, t) }
}

function scalar(t, sql) {
  const r = psql(t, ['-At', '-c', sql])
  if (r.status !== 0) throw new Error(r.err)
  return r.out.trim()
}

export function verifySentinel(t) {
  const comment = scalar(t, `SELECT coalesce(obj_description(to_regnamespace('${SENTINEL}'), 'pg_namespace'), '')`)
  if (comment !== `SplitChat-Dev ${t.ref}`) {
    throw new Error('REFUSING: connected database does not carry the SplitChat-Dev sentinel')
  }
}

function init(t) {
  const hasSentinel = scalar(t, `SELECT to_regnamespace('${SENTINEL}') IS NOT NULL`) === 't'
  if (hasSentinel) return verifySentinel(t)
  const appTables = Number(scalar(t, "SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'"))
  if (appTables !== 0) throw new Error('REFUSING init: database already has public tables (could be production)')
  const r = psql(t, ['-c', `CREATE SCHEMA ${SENTINEL}; COMMENT ON SCHEMA ${SENTINEL} IS 'SplitChat-Dev ${t.ref}'; REVOKE ALL ON SCHEMA ${SENTINEL} FROM PUBLIC;`])
  if (r.status !== 0) throw new Error(r.err)
  verifySentinel(t)
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const t = loadDevTarget()
  if (cmd === 'init') {
    init(t)
    console.log(`sentinel verified for SplitChat-Dev ${t.ref}`)
    return
  }
  verifySentinel(t)
  let r
  switch (cmd) {
    case 'check':
      console.log(`sentinel verified for SplitChat-Dev ${t.ref}`)
      return
    case 'sql':
      r = psql(t, ['-c', rest.join(' ')])
      break
    case 'file':
      r = psql(t, ['-1', '-f', rest[0]])
      break
    case 'readonly': {
      // Same guard as production reads: read-only transaction asserted first.
      const body = fs.readFileSync(rest[0], 'utf8')
      const wrapped = path.join(os.tmpdir(), `splitchat-ro-${process.pid}.sql`)
      fs.writeFileSync(wrapped, [
        'BEGIN TRANSACTION READ ONLY;',
        "SELECT current_setting('transaction_read_only') = 'on' AS ro_ok \\gset",
        '\\if :ro_ok',
        "\\echo '[guard] transaction_read_only = on'",
        '\\else',
        "\\echo '[guard] READ_ONLY_NOT_ON -- aborting'",
        '\\quit 3',
        '\\endif',
        body,
        'ROLLBACK;',
      ].join('\n'))
      r = psql(t, ['-f', wrapped])
      fs.rmSync(wrapped, { force: true })
      break
    }
    case 'dump': {
      const d = spawnSync(pgBin('pg_dump'), ['--schema-only', '--schema=public', '--schema=private', '-d', t.dbUrl], { encoding: 'utf8', env: childEnv, maxBuffer: 64 * 1024 * 1024 })
      r = { status: d.status, out: redact(d.stdout, t), err: redact(d.stderr, t) }
      if (rest[0] && d.status === 0) {
        fs.writeFileSync(rest[0], r.out)
        r.out = `dump written to ${rest[0]}\n`
      }
      break
    }
    case 'cli': {
      const c = spawnSync('npx', ['--no-install', 'supabase', ...rest, '--db-url', t.dbUrl], { encoding: 'utf8', env: childEnv, shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 })
      r = { status: c.status, out: redact(c.stdout, t), err: redact(c.stderr, t) }
      break
    }
    default:
      throw new Error(`unknown command ${cmd}`)
  }
  process.stdout.write(r.out)
  process.stderr.write(r.err)
  process.exit(r.status ?? 1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(`ERROR: ${error.message}`)
    process.exit(1)
  }
}
