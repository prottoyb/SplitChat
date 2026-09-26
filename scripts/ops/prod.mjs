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
//   - write commands (repair-m0, push) require SPLITCHAT_PROD_APPROVAL=batch1,
//     copy the migrations into a private staging directory, verify the
//     *copies* against the full SHA-256 manifest, and point the CLI at that
//     staging copy (no gap between verification and execution);
//   - repair-m0 re-runs the exact drift check itself immediately before
//     writing; push requires the remote history to be exactly [M0];
//   - secrets are never printed.
//
// Usage:
//   node scripts/ops/prod.mjs identify
//   node scripts/ops/prod.mjs preflight <evidence-dir>   (read-only)
//   node scripts/ops/prod.mjs repair-m0                  (WRITE, approval)
//   node scripts/ops/prod.mjs dry-run                    (read-only)
//   node scripts/ops/prod.mjs push                       (WRITE, approval)
//   node scripts/ops/prod.mjs verify <evidence-dir>      (read-only)
//
// --rehearse-on-dev runs the identical procedure against SplitChat-Dev (its
// own git-ignored credentials; the dev sentinel must be PRESENT) so the
// production tool itself is dress-rehearsed before any production use.
// Negative tests of the production guards must use a dev ref or a wrong
// port, never a real-looking production host (no outbound attempts).

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
const MIGRATIONS = path.join(root, 'supabase', 'migrations')
const BASELINE_DUMP = path.join(root, 'supabase', 'baseline', 'public_schema.sql')
const REHEARSE = process.argv.includes('--rehearse-on-dev')

// Reviewed and rehearsed content of production batch 1
// (docs/phase1/batch1-rehearsal.md). Full SHA-256 of LF-normalised text.
const BATCH1 = {
  repair: '20260926000000',
  migrations: {
    '20260926000000_baseline_public_schema.sql': '7d7b627b2cbfd2709620fbba9eca9358885a565b648ed039fe47605db8ed2370',
    '20260926100000_guard_expense_immutable_columns.sql': 'cc322ff60c033443b23ee0856cbf5d5d5c9a0e6970576b0a0cd34593c857c207',
    '20260926110000_revoke_anon_harden_definer_functions.sql': '1a91b339524aea24a658db13ccd296c530c1835088d2d480fa48ccc2ccdfa0c0',
    '20260926120000_revoke_direct_ledger_writes.sql': '477de1deebca0ad810100f4d632f9d87f4bdbf7d5a54737f24b6434bc2ddb80b',
    '20260926130000_enforce_ledger_invariants.sql': '288fdd9b0ae0e8682f0e98b5238bf770896fdecbd5d16f3f90d6ab98dcae6bda',
    '20260926140000_restrict_owner_deletion_cascade.sql': 'f74b73c6ccbb2484becc24c4daa6bce6fb2d3a912edcb549428b2b5825dfa3aa',
  },
  // Post-M5 schema proven identical on the local harness and SplitChat-Dev.
  expectedSchema: ['batch1_expected_schema.sql', 'af3cf9a3c7ff1020f0517679296fb3300d51baaf29eda762d76485f06365ea63'],
}

const sha256 = (text) => crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex')

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
  return { ref, password: decodeURIComponent(password), dbUrl: `postgresql://postgres.${ref}@${host}:5432/${db}?sslmode=require` }
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'splitchat-prod-ro-'))
  const file = path.join(dir, 'query.sql')
  fs.writeFileSync(file, [
    'BEGIN TRANSACTION READ ONLY;',
    "SELECT current_setting('transaction_read_only') = 'on' AS ro_ok \\gset",
    '\\if :ro_ok', "\\echo '[guard] transaction_read_only = on'", '\\else',
    "\\echo '[guard] READ_ONLY_NOT_ON -- aborting'", '\\quit 3', '\\endif',
    body, 'ROLLBACK;',
  ].join('\n'), { flag: 'wx' })
  try {
    const r = run(t, pgBin('psql'), ['-X', '-v', 'ON_ERROR_STOP=1', '-d', t.dbUrl, '-f', file])
    if (r.status !== 0 || !r.out.includes('[guard] transaction_read_only = on')) throw new Error(`read-only query failed:\n${r.err}${r.out}`)
    return r.out
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const cli = (t, args, workdir) => run(t, process.execPath, [CLI_JS, ...args, '--db-url', t.dbUrl, ...(workdir ? ['--workdir', workdir] : [])])

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

const noDrift = (t) => normaliseDump(dump(t)) === normaliseDump(fs.readFileSync(BASELINE_DUMP, 'utf8'))

function remoteVersions(t) {
  const r = cli(t, ['migration', 'list'])
  if (r.status !== 0) throw new Error(`migration list failed:\n${r.err}`)
  const json = JSON.parse(r.out.slice(r.out.indexOf('{'), r.out.lastIndexOf('}') + 1))
  return json.migrations.map((m) => m.remote).filter(Boolean)
}

// Copies supabase/migrations into a private staging workdir, verifies the
// copies against the manifest, and returns that workdir for the CLI.
function stageApprovedMigrations() {
  if (process.env.SPLITCHAT_PROD_APPROVAL !== 'batch1') {
    throw new Error('REFUSING: write needs SPLITCHAT_PROD_APPROVAL=batch1 (set only after explicit human execution approval)')
  }
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'splitchat-prod-stage-'))
  const staged = path.join(workdir, 'supabase', 'migrations')
  fs.mkdirSync(staged, { recursive: true })
  const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()
  if (JSON.stringify(files) !== JSON.stringify(Object.keys(BATCH1.migrations).sort())) {
    throw new Error('REFUSING: supabase/migrations must contain exactly the batch 1 files')
  }
  for (const f of files) {
    fs.copyFileSync(path.join(MIGRATIONS, f), path.join(staged, f))
    const digest = sha256(fs.readFileSync(path.join(staged, f), 'utf8'))
    if (digest !== BATCH1.migrations[f]) throw new Error(`REFUSING: ${f} differs from the reviewed file (sha256 ${digest})`)
    fs.chmodSync(path.join(staged, f), 0o444)
  }
  return workdir
}

function gate(label, ok, detail) {
  console.log(`${ok ? 'PASS ' : 'ABORT'}  ${label}${detail ? `  (${detail})` : ''}`)
  return ok
}

function preflight(t, id, dir) {
  fs.mkdirSync(dir, { recursive: true })
  let ok = gate(REHEARSE ? 'REHEARSAL target is SplitChat-Dev' : 'target is production and not the dev project', true, `${t.ref}, ${id.publicTables} public tables`)
  const live = dump(t)
  fs.writeFileSync(path.join(dir, 'prod_before.sql'), live)
  ok = gate('no drift: live schema == Phase 0 capture (exact)', normaliseDump(live) === normaliseDump(fs.readFileSync(BASELINE_DUMP, 'utf8'))) && ok
  ok = gate('no migration history exists yet', !id.hasHistory && remoteVersions(t).length === 0) && ok
  const pre = readonly(t, fs.readFileSync(path.join(OPS, 'batch1_prechecks.sql'), 'utf8'))
  fs.writeFileSync(path.join(dir, 'prechecks.txt'), pre)
  const q = Object.fromEntries([...pre.matchAll(/^\s*(Q\d)[^|]*\|\s*(\d+)\s*$/gm)].map((m) => [m[1], Number(m[2])]))
  ok = gate('Q4/Q5/Q6/Q8 are 0 (M4/M5 preconditions)', [q.Q4, q.Q5, q.Q6, q.Q8].every((v) => v === 0), JSON.stringify(q)) && ok
  gate('Q1-Q3/Q7 recorded (informational)', true)
  fs.writeFileSync(path.join(dir, 'ledger_before.txt'), readonly(t, fs.readFileSync(path.join(OPS, 'ledger_snapshot.sql'), 'utf8')))
  const locks = readonly(t, fs.readFileSync(path.join(OPS, 'lock_check.sql'), 'utf8'))
  const lm = /^\s*(\d+)\s*\|\s*(\d+)\s*$/m.exec(locks)
  ok = gate('no other locks on expenses/expense_splits/groups and no long transactions', Boolean(lm) && lm[1] === '0' && lm[2] === '0', lm ? `${lm[1]} locks, ${lm[2]} long` : 'unparsed') && ok
  console.log(ok ? '\nPREFLIGHT PASSED' : '\nPREFLIGHT FAILED: do not proceed')
  return ok
}

function verify(t, dir) {
  const [schemaFile, schemaSha] = BATCH1.expectedSchema
  const expected = fs.readFileSync(path.join(OPS, schemaFile), 'utf8')
  if (sha256(expected) !== schemaSha) throw new Error('REFUSING: expected schema file differs from the reviewed one')
  let ok = gate('history = M0..M5', JSON.stringify(remoteVersions(t)) === JSON.stringify(Object.keys(BATCH1.migrations).sort().map((f) => f.slice(0, 14))))
  const postSql = fs.readFileSync(path.join(OPS, 'batch1_postchecks.sql'), 'utf8')
  const names = [...postSql.matchAll(/^\s*\('([^']+)',\s*$/gm)].map((m) => m[1])
  const post = readonly(t, postSql)
  fs.writeFileSync(path.join(dir, 'postchecks.txt'), post)
  const results = new Map([...post.matchAll(/^\s*(.+?)\s*\|\s*([tf])\s*$/gm)].map((m) => [m[1], m[2]]))
  const failing = names.filter((n) => results.get(n) !== 't')
  ok = gate('every named post-check is true', names.length === 17 && failing.length === 0, failing.length ? `failing: ${failing.join('; ')}` : `${names.length}/17`) && ok
  const ledgerAfter = readonly(t, fs.readFileSync(path.join(OPS, 'ledger_snapshot.sql'), 'utf8'))
  fs.writeFileSync(path.join(dir, 'ledger_after.txt'), ledgerAfter)
  ok = gate('ledger unchanged (counts, totals, digests)', ledgerAfter === fs.readFileSync(path.join(dir, 'ledger_before.txt'), 'utf8')) && ok
  const live = dump(t)
  fs.writeFileSync(path.join(dir, 'prod_after.sql'), live)
  ok = gate('schema == reviewed post-M5 schema', normaliseDump(live) === normaliseDump(expected)) && ok
  console.log(ok ? '\nVERIFY PASSED' : '\nVERIFY FAILED: stop and assess (forward-fix or approved rollback)')
  return ok
}

function main() {
  const [cmd, a1] = process.argv.slice(2).filter((a) => a !== '--rehearse-on-dev')
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
      process.exit(verify(t, a1) ? 0 : 1)
      break
    case 'dry-run':
      r = cli(t, ['db', 'push', '--dry-run'])
      break
    case 'repair-m0': {
      const workdir = stageApprovedMigrations()
      if (id.hasHistory) throw new Error('REFUSING: production already has migration history; stop and reassess')
      if (!noDrift(t)) throw new Error('REFUSING: live schema no longer matches the Phase 0 capture (drift)')
      r = cli(t, ['migration', 'repair', '--status', 'applied', BATCH1.repair], workdir)
      break
    }
    case 'push': {
      const workdir = stageApprovedMigrations()
      if (JSON.stringify(remoteVersions(t)) !== JSON.stringify([BATCH1.repair])) {
        throw new Error('REFUSING: remote history must be exactly [M0] before pushing M1-M5')
      }
      r = cli(t, ['db', 'push', '--yes'], workdir)
      break
    }
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
