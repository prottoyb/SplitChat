#!/usr/bin/env node
// Production operations for SplitChat (project ref jhftlnsccurhfgneltgi).
// NOTHING here runs without the operator's explicit, per-operation execution
// approval (CLAUDE.md Mandatory Gate #5; docs/phase1/design.md §F).
//
// Guards:
//   - target comes only from the operator's DB_URL; it must be the
//     production session pooler (user postgres.jhftlnsccurhfgneltgi, port
//     5432) and must NOT carry the SplitChat-Dev rehearsal sentinel;
//   - child processes get a scrubbed environment (no PG*/SUPABASE_*/DB_URL)
//     and a password-free --db-url; the password travels only as PGPASSWORD;
//     the pinned CLI is run directly with node (no shell);
//   - read commands run inside an asserted read-only transaction;
//   - write commands (repair-m0, push) require SPLITCHAT_PROD_APPROVAL=<batch>
//     and refuse unless supabase/migrations matches the reviewed SHA-256
//     manifest exactly;
//   - secrets are never printed.
//
// Usage:
//   node scripts/ops/prod.mjs identify
//   node scripts/ops/prod.mjs preflight <evidence-dir>   (read-only, batch 1)
//   node scripts/ops/prod.mjs repair-m0                  (WRITE, approval)
//   node scripts/ops/prod.mjs dry-run                    (read-only)
//   node scripts/ops/prod.mjs push                       (WRITE, approval)
//   node scripts/ops/prod.mjs verify <evidence-dir> <expected-schema.sql>
//
// --rehearse-on-dev runs the identical procedure against SplitChat-Dev (its
// own git-ignored credentials; the dev sentinel must be PRESENT) so the
// production tool itself is dress-rehearsed before any production use.

import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isolatedEnv, normaliseDump } from '../db-test.mjs'
import { loadDevTarget } from '../rehearsal/dev.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PROD_REF = 'jhftlnsccurhfgneltgi'
const DEV_SENTINEL = 'splitchat_rehearsal_sentinel'
const CLI_JS = path.join(root, 'node_modules', 'supabase', 'dist', 'supabase.js')
const OPS = path.join(root, 'supabase', 'ops')
const BASELINE_DUMP = path.join(root, 'supabase', 'baseline', 'public_schema.sql')

// Reviewed and rehearsed files for production batch 1 (docs/phase1/batch1-rehearsal.md).
const BATCH1 = {
  repair: '20260926000000',
  sha256: {
    '20260926000000_baseline_public_schema.sql': '7d7b627b2cbfd270',
    '20260926100000_guard_expense_immutable_columns.sql': 'cc322ff60c033443',
    '20260926110000_revoke_anon_harden_definer_functions.sql': '1a91b339524aea24',
    '20260926120000_revoke_direct_ledger_writes.sql': '477de1deebca0ad8',
    '20260926130000_enforce_ledger_invariants.sql': '288fdd9b0ae0e868',
    '20260926140000_restrict_owner_deletion_cascade.sql': 'f74b73c6ccbb2484',
  },
}

const REHEARSE = process.argv.includes('--rehearse-on-dev')

function target() {
  if (REHEARSE) {
    const d = loadDevTarget()
    return { ref: d.ref, password: d.password, dbUrl: d.dbUrl }
  }
  const url = process.env.DB_URL ?? ''
  const m = /^postgres(?:ql)?:\/\/postgres\.([a-z0-9]{20}):([^@]+)@([^:/]+):(\d+)\/([^?]+)/.exec(url)
  if (!m) throw new Error('DB_URL is not a Supabase pooler URL')
  const [, ref, password, host, port, db] = m
  if (ref !== PROD_REF) throw new Error('REFUSING: DB_URL is not the production project')
  if (!/\.pooler\.supabase\.com$/.test(host) || port !== '5432') throw new Error('REFUSING: expected the session pooler on port 5432')
  return {
    ref,
    password: decodeURIComponent(password),
    dbUrl: `postgresql://postgres.${ref}@${host}:5432/${db}?sslmode=require`,
  }
}

function pgBin(name) {
  const dir = process.env.SPLITCHAT_PG_BIN || (process.platform === 'win32' ? 'C:\\Program Files\\PostgreSQL\\17\\bin' : '')
  return dir ? path.join(dir, process.platform === 'win32' ? `${name}.exe` : name) : name
}

const envFor = (t) => ({ ...isolatedEnv(process.env, os.tmpdir()), PGPASSWORD: t.password })
const redact = (t, s) => String(s).split(t.password).join('<redacted>').split(encodeURIComponent(t.password)).join('<redacted>')

function run(t, cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env: envFor(t), maxBuffer: 64 * 1024 * 1024 })
  if (r.error) throw r.error
  return { status: r.status, out: redact(t, r.stdout), err: redact(t, r.stderr) }
}

function readonly(t, body) {
  const file = path.join(os.tmpdir(), `splitchat-prod-ro-${process.pid}.sql`)
  fs.writeFileSync(file, [
    'BEGIN TRANSACTION READ ONLY;',
    "SELECT current_setting('transaction_read_only') = 'on' AS ro_ok \\gset",
    '\\if :ro_ok', "\\echo '[guard] transaction_read_only = on'", '\\else',
    "\\echo '[guard] READ_ONLY_NOT_ON -- aborting'", '\\quit 3', '\\endif',
    body, 'ROLLBACK;',
  ].join('\n'))
  try {
    const r = run(t, pgBin('psql'), ['-X', '-v', 'ON_ERROR_STOP=1', '-d', t.dbUrl, '-f', file])
    if (r.status !== 0 || !r.out.includes('[guard] transaction_read_only = on')) throw new Error(`read-only query failed:\n${r.err}${r.out}`)
    return r.out
  } finally {
    fs.rmSync(file, { force: true })
  }
}

const cli = (t, args) => run(t, process.execPath, [CLI_JS, ...args, '--db-url', t.dbUrl])

function identify(t) {
  const out = readonly(t, `SELECT to_regnamespace('${DEV_SENTINEL}') IS NULL AS not_dev,
    (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r') AS public_tables,
    to_regclass('supabase_migrations.schema_migrations') IS NOT NULL AS has_history \\gset
\\echo not_dev=:not_dev public_tables=:public_tables has_history=:has_history`)
  const m = /not_dev=(\w+) public_tables=(\d+) has_history=(\w+)/.exec(out)
  if (!m) throw new Error('identity query failed')
  if (REHEARSE ? m[1] !== 'f' : m[1] !== 't') {
    throw new Error(REHEARSE ? 'REFUSING: rehearsal target lacks the SplitChat-Dev sentinel' : 'REFUSING: target carries the SplitChat-Dev sentinel')
  }
  return { publicTables: Number(m[2]), hasHistory: m[3] === 't' }
}

function dump(t) {
  const r = run(t, pgBin('pg_dump'), ['--schema-only', '--schema=public', '--schema=private', '-d', t.dbUrl])
  if (r.status !== 0) throw new Error(`pg_dump failed:\n${r.err}`)
  return r.out
}

function remoteVersions(t) {
  const r = cli(t, ['migration', 'list'])
  if (r.status !== 0) throw new Error(`migration list failed:\n${r.err}`)
  const json = JSON.parse(r.out.slice(r.out.indexOf('{'), r.out.lastIndexOf('}') + 1))
  return json.migrations.map((m) => m.remote).filter(Boolean)
}

function requireApproval() {
  if (process.env.SPLITCHAT_PROD_APPROVAL !== 'batch1') {
    throw new Error('REFUSING: write needs SPLITCHAT_PROD_APPROVAL=batch1 (set only after explicit human execution approval)')
  }
  const dir = path.join(root, 'supabase', 'migrations')
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  if (JSON.stringify(files) !== JSON.stringify(Object.keys(BATCH1.sha256).sort())) {
    throw new Error('REFUSING: supabase/migrations must contain exactly the batch 1 files')
  }
  for (const f of files) {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n')).digest('hex').slice(0, 16)
    if (sha !== BATCH1.sha256[f]) throw new Error(`REFUSING: ${f} differs from the reviewed file (sha256 ${sha})`)
  }
}

// Each check prints PASS/ABORT; any ABORT stops the procedure.
function gate(label, ok, detail) {
  console.log(`${ok ? 'PASS ' : 'ABORT'}  ${label}${detail ? `  (${detail})` : ''}`)
  return ok
}

function preflight(t, id, dir) {
  fs.mkdirSync(dir, { recursive: true })
  let ok = gate(REHEARSE ? 'REHEARSAL target is SplitChat-Dev' : 'target is production and not the dev project', true, `${t.ref}, ${id.publicTables} public tables`)
  const live = dump(t)
  fs.writeFileSync(path.join(dir, 'prod_before.sql'), live)
  ok = gate('no drift: live public schema == Phase 0 capture', normaliseDump(live) === normaliseDump(fs.readFileSync(BASELINE_DUMP, 'utf8'))) && ok
  ok = gate('no migration history exists yet', !id.hasHistory && remoteVersions(t).length === 0) && ok
  const pre = readonly(t, fs.readFileSync(path.join(OPS, 'batch1_prechecks.sql'), 'utf8'))
  fs.writeFileSync(path.join(dir, 'prechecks.txt'), pre)
  const q = Object.fromEntries([...pre.matchAll(/^\s*(Q\d)[^|]*\|\s*(\d+)\s*$/gm)].map((m) => [m[1], Number(m[2])]))
  ok = gate('Q4/Q5/Q6/Q8 are 0 (M4/M5 preconditions)', [q.Q4, q.Q5, q.Q6, q.Q8].every((v) => v === 0), JSON.stringify(q)) && ok
  gate('Q1-Q3/Q7 recorded (informational)', true)
  fs.writeFileSync(path.join(dir, 'ledger_before.txt'), readonly(t, fs.readFileSync(path.join(OPS, 'ledger_snapshot.sql'), 'utf8')))
  const locks = readonly(t, fs.readFileSync(path.join(OPS, 'lock_check.sql'), 'utf8'))
  const lm = /^\s*(\d+)\s*\|\s*(\d+)\s*$/m.exec(locks)
  ok = gate('no other locks on expenses/expense_splits/groups and no long transactions', lm && lm[1] === '0' && lm[2] === '0', lm ? `${lm[1]} locks, ${lm[2]} long` : 'unparsed') && ok
  console.log(ok ? '\nPREFLIGHT PASSED' : '\nPREFLIGHT FAILED: do not proceed')
  return ok
}

function verify(t, dir, expectedSchema) {
  let ok = gate('history = M0..M5', JSON.stringify(remoteVersions(t)) === JSON.stringify(Object.keys(BATCH1.sha256).sort().map((f) => f.slice(0, 14))))
  const post = readonly(t, fs.readFileSync(path.join(OPS, 'batch1_postchecks.sql'), 'utf8'))
  fs.writeFileSync(path.join(dir, 'postchecks.txt'), post)
  const rows = [...post.matchAll(/\|\s*([tf])\s*$/gm)].map((m) => m[1])
  ok = gate('post-checks all true', rows.length === 17 && rows.every((v) => v === 't'), `${rows.filter((v) => v === 't').length}/${rows.length}`) && ok
  const ledgerAfter = readonly(t, fs.readFileSync(path.join(OPS, 'ledger_snapshot.sql'), 'utf8'))
  fs.writeFileSync(path.join(dir, 'ledger_after.txt'), ledgerAfter)
  ok = gate('ledger unchanged (counts, totals, digests)', ledgerAfter === fs.readFileSync(path.join(dir, 'ledger_before.txt'), 'utf8')) && ok
  const live = dump(t)
  fs.writeFileSync(path.join(dir, 'prod_after.sql'), live)
  ok = gate('schema == rehearsed/harness post-M5 schema', normaliseDump(live) === normaliseDump(fs.readFileSync(expectedSchema, 'utf8'))) && ok
  console.log(ok ? '\nVERIFY PASSED' : '\nVERIFY FAILED: stop and assess (forward-fix or approved rollback)')
  return ok
}

function main() {
  const [cmd, a1, a2] = process.argv.slice(2).filter((a) => a !== '--rehearse-on-dev')
  const t = target()
  const id = identify(t)
  let r
  switch (cmd) {
    case 'identify':
      console.log(`${REHEARSE ? 'REHEARSAL SplitChat-Dev' : 'production'} ${t.ref}: public tables=${id.publicTables}; migration history present=${id.hasHistory}`)
      return
    case 'preflight':
      process.exit(preflight(t, id, a1) ? 0 : 1)
      break
    case 'verify':
      process.exit(verify(t, a1, a2) ? 0 : 1)
      break
    case 'dry-run':
      r = cli(t, ['db', 'push', '--dry-run'])
      break
    case 'repair-m0':
      requireApproval()
      if (id.hasHistory) throw new Error('REFUSING: production already has migration history; stop and reassess')
      r = cli(t, ['migration', 'repair', '--status', 'applied', BATCH1.repair])
      break
    case 'push':
      requireApproval()
      if (JSON.stringify(remoteVersions(t)) !== JSON.stringify([BATCH1.repair])) {
        throw new Error('REFUSING: remote history must be exactly [M0] before pushing M1-M5')
      }
      r = cli(t, ['db', 'push', '--yes'])
      break
    default:
      throw new Error(`unknown command ${cmd}`)
  }
  process.stdout.write(r.out)
  process.stderr.write(r.err)
  process.exit(r.status ?? 1)
}

try {
  main()
} catch (error) {
  console.error(`ERROR: ${error.message}`)
  process.exit(1)
}
