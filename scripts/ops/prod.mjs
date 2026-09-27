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
//   - every command names its batch (--batch batchN) and is checked against
//     that batch's reviewed manifest: exact migration files and full
//     SHA-256 digests, the expected schema and migration history before and
//     after, named pre- and post-checks;
//   - write commands (repair-m0 for batch 1, push) require
//     SPLITCHAT_PROD_APPROVAL=<that batch>, copy the migrations into a private
//     staging directory, verify the *copies*, and point the CLI at that copy;
//     repair-m0 re-runs the exact drift check itself immediately before
//     writing; push requires the remote history to be exactly the batch's
//     starting history;
//   - secrets are never printed.
//
// Usage (every command takes --batch batch1|batch2|batch3a|batch3b):
//   node scripts/ops/prod.mjs identify
//   node scripts/ops/prod.mjs preflight <evidence-dir>   (read-only)
//   node scripts/ops/prod.mjs repair-m0                  (WRITE, batch1 only)
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
import { CLI_MODE_FLAGS, MIGRATION_LIST_ARGS, parseMigrationList } from './cliOutput.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PROD_REF = 'jhftlnsccurhfgneltgi'
const DEV_SENTINEL = 'splitchat_rehearsal_sentinel'
const CLI_JS = path.join(root, 'node_modules', 'supabase', 'dist', 'supabase.js')
const OPS = path.join(root, 'supabase', 'ops')
const MIGRATIONS = path.join(root, 'supabase', 'migrations')
const argv = process.argv.slice(2)
const REHEARSE = argv.includes('--rehearse-on-dev')

// Full SHA-256 of LF-normalised text, for every reviewed file.
const M = {
  '20260926000000_baseline_public_schema.sql': '7d7b627b2cbfd2709620fbba9eca9358885a565b648ed039fe47605db8ed2370',
  '20260926100000_guard_expense_immutable_columns.sql': 'cc322ff60c033443b23ee0856cbf5d5d5c9a0e6970576b0a0cd34593c857c207',
  '20260926110000_revoke_anon_harden_definer_functions.sql': '1a91b339524aea24a658db13ccd296c530c1835088d2d480fa48ccc2ccdfa0c0',
  '20260926120000_revoke_direct_ledger_writes.sql': '477de1deebca0ad810100f4d632f9d87f4bdbf7d5a54737f24b6434bc2ddb80b',
  '20260926130000_enforce_ledger_invariants.sql': '288fdd9b0ae0e8682f0e98b5238bf770896fdecbd5d16f3f90d6ab98dcae6bda',
  '20260926140000_restrict_owner_deletion_cascade.sql': 'f74b73c6ccbb2484becc24c4daa6bce6fb2d3a912edcb549428b2b5825dfa3aa',
  '20260926150000_least_privilege_grants.sql': 'd1f1c66a14a139fcc660fb532adcaf949a4c68ba9c3393736a44ff9fff324f14',
  '20260926160000_membership_lifecycle_and_single_owner.sql': '9825e7fc0f485b04316a6c532011d14663d38b30f910ced5cffce50dac91a17a',
  '20260926170000_private_helpers_rls_rewrite.sql': '42863e08884ac3d84cfe78c676d93cd8e8d60a84e2f203df99d270a974d846fc',
  '20260926180000_membership_rpcs.sql': '460931bf3bd3f5457ca5208a7a4e6e7882bf75e22a08fc8a9584fbcb9206fe86',
  '20260926190000_revoke_direct_membership_delete.sql': '4b702e559d502d7eb5bad16fce3dc90de4ce91f527f36cc17b419f4ea70ecddb',
  '20260927100000_ledger_preserving_account_deletion.sql': '26cea13e06de6a7149931c5165f2c2e03968d331e9b3c9a06787c1f46cb81cb4',
  '20260927110000_money_cents_and_canonical_split.sql': '5cb96e482d792b3d8a8b0cc6a42687f2ddb40fcf78d7bc6d781e4f410bbbfbf4',
  '20260927120000_expense_update_delete_rpcs.sql': '616feb16aa85741a70c4155d80111126f752eac0b341a5d88449f72e9ff6a873',
  '20260927130000_delete_group_rpc.sql': '0204022c08cad6509db756792c925b9e89f43d5d61bf0c232a7873da56a8e3c1',
  '20260927135000_serialise_owner_deletion_and_member_add.sql': 'ddf392bca3cff2dea4ff47f563ec21b96fe0b564e7f8583354c9f8686d148c96',
  '20260927140000_drop_legacy_expense_rpc.sql': 'e3e653568265e5bd13185bc960f5e3c971ec42b844d0df267bf9a5e7c7c551ad',
}
const pick = (n) => Object.fromEntries(Object.entries(M).slice(0, n))
const versions = (n) => Object.keys(M).slice(0, n).map((f) => f.slice(0, 14))
// Batch 3a is M0-M13, M15 and the QS-B3-1 fix: M14 (the last timestamp) is batch 3b.
const BATCH3A = Object.fromEntries(Object.entries(M).filter(([f]) => f < '20260927140000'))

// Reviewed batches. `before` is the schema production must match before the
// batch (exact, CR-insensitive); `startHistory` is the required migration
// history before the batch's write; `after*` describe the verified end state.
const BATCHES = {
  batch1: {
    migrations: pick(6),
    before: ['../baseline/public_schema.sql', '7d4971e08e87a98bd23bc205961b06b067423ed535af5aedd85cd4dacd429d9d'],
    preflightHistory: [],
    repair: '20260926000000',
    startHistory: versions(1),
    prechecks: 'batch1_prechecks.sql',
    zeroChecks: ['Q4', 'Q5', 'Q6', 'Q8'],
    postchecks: 'batch1_postchecks.sql',
    expectedSchema: ['batch1_expected_schema.sql', 'af3cf9a3c7ff1020f0517679296fb3300d51baaf29eda762d76485f06365ea63'],
  },
  batch2: {
    migrations: pick(11),
    before: ['batch1_expected_schema.sql', 'af3cf9a3c7ff1020f0517679296fb3300d51baaf29eda762d76485f06365ea63'],
    preflightHistory: versions(6),
    startHistory: versions(6),
    prechecks: 'batch2_prechecks.sql',
    zeroChecks: ['Q9', 'Q10', 'Q4', 'Q5'],
    postchecks: 'batch2_postchecks.sql',
    expectedSchema: ['batch2_expected_schema.sql', '52d45db9baf1bec1c8d829e5c49bf0a1f478969305fab181a1a867b6c992acd6'],
    // M9 changes the add-by-email contract and M10 removes direct deletes:
    // every frontend in use must contain this commit (review B2-SR-3).
    frontendMinCommit: '29195231ad9bec4107b181d61aa25edacac4cf82',
  },
  // M11 ledger-preserving account deletion (FIX-FORWARD: postgres cannot drop
  // the auth.users trigger), M12 cents + canonical split + v2 (legacy RPC
  // kept as a wrapper), M13 expense edit/delete, M15 solo-group deletion,
  // and the QS-B3-1 fix (owner deletion vs add-by-email serialised).
  // Compatible with every frontend that contains the batch 2 minimum; a
  // frontend at or after the M12 frontend commit needs this batch first.
  batch3a: {
    migrations: BATCH3A,
    before: ['batch2_expected_schema.sql', '52d45db9baf1bec1c8d829e5c49bf0a1f478969305fab181a1a867b6c992acd6'],
    preflightHistory: versions(11),
    startHistory: versions(11),
    prechecks: 'batch3_prechecks.sql',
    zeroChecks: ['Q11', 'Q12', 'Q13', 'Q16', 'Q4', 'Q5'],
    postchecks: 'batch3a_postchecks.sql',
    expectedSchema: ['batch3a_expected_schema.sql', '1cfc040c309b810ca8c7461d62998122f3fa91da3b2056610e4723851805d854'],
    frontendMinCommit: '29195231ad9bec4107b181d61aa25edacac4cf82',
  },
  // M14 drops the legacy numeric expense RPC: every live frontend must
  // contain the M12 frontend commit (it calls v2 only), or none may be live.
  batch3b: {
    migrations: pick(17),
    before: ['batch3a_expected_schema.sql', '1cfc040c309b810ca8c7461d62998122f3fa91da3b2056610e4723851805d854'],
    preflightHistory: Object.keys(BATCH3A).map((f) => f.slice(0, 14)),
    startHistory: Object.keys(BATCH3A).map((f) => f.slice(0, 14)),
    prechecks: 'batch3_prechecks.sql',
    zeroChecks: ['Q4', 'Q5'],
    postchecks: 'batch3b_postchecks.sql',
    expectedSchema: ['batch3b_expected_schema.sql', '0804dc02e90b430c94c9a468322542cdbfbcee4f5ca1380d41b859663967ea5c'],
    frontendMinCommit: 'a5ed4e85e9a184e3acdf8f529f673ee2bbb07753',
  },
}

// Frontend compatibility attestation for batches that change a client
// contract. SPLITCHAT_FRONTEND_ATTESTATION must be either the commit of the
// frontend that is live (it must contain the batch's minimum commit), or
// exactly `no-live-frontend` when no frontend build is serving users.
function frontendAttestation(b) {
  if (!b.frontendMinCommit) return null
  const value = (process.env.SPLITCHAT_FRONTEND_ATTESTATION ?? '').trim()
  if (value === 'no-live-frontend') return value
  if (!/^[0-9a-f]{7,40}$/.test(value)) {
    throw new Error(`REFUSING: ${b.id} needs SPLITCHAT_FRONTEND_ATTESTATION=<live frontend commit> or no-live-frontend`)
  }
  const r = spawnSync('git', ['merge-base', '--is-ancestor', b.frontendMinCommit, value], { cwd: root, encoding: 'utf8' })
  if (r.status !== 0) {
    throw new Error(`REFUSING: live frontend ${value} does not contain the required commit ${b.frontendMinCommit.slice(0, 7)}`)
  }
  return value
}

const sha256 = (text) => crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex')

function selectBatch() {
  if (argv.filter((a) => a === '--batch').length !== 1) throw new Error('exactly one --batch is required')
  const i = argv.indexOf('--batch')
  const id = i >= 0 ? argv[i + 1] : undefined
  if (!id || !BATCHES[id]) throw new Error(`--batch must be one of: ${Object.keys(BATCHES).join(', ')}`)
  return { id, ...BATCHES[id] }
}

function readPinned(file, digest) {
  const text = fs.readFileSync(path.join(OPS, file), 'utf8')
  if (digest && sha256(text) !== digest) throw new Error(`REFUSING: ${file} differs from the reviewed file`)
  return text
}

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

// Agent-detection variables are removed too: the pinned CLI changes its
// output format when it detects an AI agent, and the tool must behave the
// same whoever runs it (CLI_MODE_FLAGS also pins --agent no).
const AGENT_ENV = /^(AI_AGENT|CLAUDECODE|CLAUDE_.*)$/
const envFor = (t) => ({
  ...isolatedEnv(Object.fromEntries(Object.entries(process.env).filter(([k]) => !AGENT_ENV.test(k))), os.tmpdir()),
  PGPASSWORD: t.password,
})
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

const cli = (t, args, workdir) => run(t, process.execPath, [CLI_JS, ...args, ...CLI_MODE_FLAGS, '--db-url', t.dbUrl, ...(workdir ? ['--workdir', workdir] : [])])

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

const beforeSchema = (b) => readPinned(b.before[0], b.before[1])
const matchesBefore = (t, b) => normaliseDump(dump(t)) === normaliseDump(beforeSchema(b))

function remoteVersions(t, id) {
  if (!id.hasHistory) return []
  const r = cli(t, MIGRATION_LIST_ARGS)
  if (r.status !== 0) throw new Error(`migration list failed:\n${r.err}`)
  // The whole of stdout must be the JSON listing; anything else refuses
  // (never an empty history). See scripts/ops/cliOutput.mjs.
  return parseMigrationList(r.out)
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// Only migrations are staged; refuse if the project gains any other CLI
// input (config, roles, seed, functions) that staging would not cover.
// The copies are verified against the batch manifest and made read-only.
function stageApprovedMigrations(b, { write = true } = {}) {
  if (write && process.env.SPLITCHAT_PROD_APPROVAL !== b.id) {
    throw new Error(`REFUSING: write needs SPLITCHAT_PROD_APPROVAL=${b.id} (set only after explicit human execution approval)`)
  }
  for (const extra of ['config.toml', 'roles.sql', 'seed.sql', 'functions']) {
    if (fs.existsSync(path.join(root, 'supabase', extra))) {
      throw new Error(`REFUSING: supabase/${extra} exists but is not part of the reviewed staging`)
    }
  }
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'splitchat-prod-stage-'))
  const staged = path.join(workdir, 'supabase', 'migrations')
  fs.mkdirSync(staged, { recursive: true })
  // The repository may already hold later migrations of a following batch
  // step (batch 3a runs while M14 exists); only the batch's own files are
  // staged, and nothing earlier than or among them may be missing or extra.
  const batchFiles = Object.keys(b.migrations).sort()
  const last = batchFiles[batchFiles.length - 1]
  const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()
  if (!same(files.filter((f) => f <= last), batchFiles)) {
    throw new Error(`REFUSING: supabase/migrations must contain exactly the ${b.id} files up to ${last}`)
  }
  for (const f of batchFiles) {
    fs.copyFileSync(path.join(MIGRATIONS, f), path.join(staged, f))
    const digest = sha256(fs.readFileSync(path.join(staged, f), 'utf8'))
    if (digest !== b.migrations[f]) throw new Error(`REFUSING: ${f} differs from the reviewed file (sha256 ${digest})`)
    fs.chmodSync(path.join(staged, f), 0o444)
  }
  return workdir
}

function gate(label, ok, detail) {
  console.log(`${ok ? 'PASS ' : 'ABORT'}  ${label}${detail ? `  (${detail})` : ''}`)
  return ok
}

function preflight(t, id, b, dir) {
  fs.mkdirSync(dir, { recursive: true })
  let ok = gate(REHEARSE ? 'REHEARSAL target is SplitChat-Dev' : 'target is production and not the dev project', true, `${t.ref}, ${id.publicTables} public tables, ${b.id}`)
  const live = dump(t)
  fs.writeFileSync(path.join(dir, 'prod_before.sql'), live)
  ok = gate(`no drift: live schema == expected pre-${b.id} schema (exact)`, normaliseDump(live) === normaliseDump(beforeSchema(b))) && ok
  const history = remoteVersions(t, id)
  ok = gate(`migration history is exactly the pre-${b.id} history`, same(history, b.preflightHistory), `${history.length} versions`) && ok
  const pre = readonly(t, readPinned(b.prechecks))
  fs.writeFileSync(path.join(dir, 'prechecks.txt'), pre)
  const q = Object.fromEntries([...pre.matchAll(/^\s*(Q\d+)[^|]*\|\s*(\d+)\s*$/gm)].map((m) => [m[1], Number(m[2])]))
  ok = gate(`${b.zeroChecks.join('/')} are 0 (preconditions)`, b.zeroChecks.every((k) => q[k] === 0), JSON.stringify(q)) && ok
  fs.writeFileSync(path.join(dir, 'ledger_before.txt'), readonly(t, readPinned('ledger_snapshot.sql')))
  gate('ledger snapshot recorded', true)
  const locks = readonly(t, readPinned('lock_check.sql'))
  const lm = /^\s*(\d+)\s*\|\s*(\d+)\s*$/m.exec(locks)
  ok = gate('no other locks on the ledger/membership tables and no long transactions', Boolean(lm) && lm[1] === '0' && lm[2] === '0', lm ? `${lm[1]} locks, ${lm[2]} long` : 'unparsed') && ok
  console.log(ok ? '\nPREFLIGHT PASSED' : '\nPREFLIGHT FAILED: do not proceed')
  return ok
}

function verify(t, id, b, dir) {
  const expected = readPinned(...b.expectedSchema)
  const history = remoteVersions(t, id)
  let ok = gate(`history = the ${b.id} migrations`, same(history, Object.keys(b.migrations).sort().map((f) => f.slice(0, 14))), `${history.length} versions`)
  const postSql = readPinned(b.postchecks)
  const names = [...postSql.matchAll(/^\s*\('([^']+)',\s*$/gm)].map((m) => m[1])
  if (names.length === 0 || new Set(names).size !== names.length) throw new Error('REFUSING: post-check names missing or duplicated')
  const post = readonly(t, postSql)
  fs.writeFileSync(path.join(dir, 'postchecks.txt'), post)
  const results = new Map([...post.matchAll(/^\s*(.+?)\s*\|\s*([tf])\s*$/gm)].map((m) => [m[1], m[2]]))
  const failing = names.filter((n) => results.get(n) !== 't')
  ok = gate('every named post-check is true', failing.length === 0, failing.length ? `failing: ${failing.join('; ')}` : `${names.length}/${names.length}`) && ok
  const ledgerAfter = readonly(t, readPinned('ledger_snapshot.sql'))
  fs.writeFileSync(path.join(dir, 'ledger_after.txt'), ledgerAfter)
  ok = gate('ledger unchanged (counts, totals, digests)', ledgerAfter === fs.readFileSync(path.join(dir, 'ledger_before.txt'), 'utf8')) && ok
  const live = dump(t)
  fs.writeFileSync(path.join(dir, 'prod_after.sql'), live)
  ok = gate(`schema == reviewed post-${b.id} schema`, normaliseDump(live) === normaliseDump(expected)) && ok
  console.log(ok ? '\nVERIFY PASSED' : '\nVERIFY FAILED: stop and assess (forward-fix or approved rollback)')
  return ok
}

function main() {
  const b = selectBatch()
  const [cmd, a1] = argv.filter((a, i) => a !== '--rehearse-on-dev' && a !== '--batch' && argv[i - 1] !== '--batch')
  const t = target()
  const id = identify(t)
  let r
  switch (cmd) {
    case 'identify':
      console.log(`${REHEARSE ? 'REHEARSAL SplitChat-Dev' : 'production'} ${t.ref}: public tables=${id.publicTables}; migration history present=${id.hasHistory}`)
      return
    case 'preflight':
      process.exit(preflight(t, id, b, a1) ? 0 : 1)
      break
    case 'verify':
      process.exit(verify(t, id, b, a1) ? 0 : 1)
      break
    case 'dry-run':
      // Against the same verified staging copy a push would use.
      r = cli(t, ['db', 'push', '--dry-run'], stageApprovedMigrations(b, { write: false }))
      break
    case 'repair-m0': {
      if (!b.repair) throw new Error(`REFUSING: ${b.id} has no repair step`)
      const workdir = stageApprovedMigrations(b)
      if (id.hasHistory) throw new Error('REFUSING: production already has migration history; stop and reassess')
      if (!matchesBefore(t, b)) throw new Error('REFUSING: live schema no longer matches the expected schema (drift)')
      r = cli(t, ['migration', 'repair', '--status', 'applied', b.repair], workdir)
      break
    }
    case 'push': {
      const workdir = stageApprovedMigrations(b)
      const attested = frontendAttestation(b)
      if (attested) console.log(`frontend attestation for ${b.id}: ${attested}`)
      if (!same(remoteVersions(t, id), b.startHistory)) {
        throw new Error(`REFUSING: remote history must be exactly [${b.startHistory.join(', ')}] before pushing ${b.id}`)
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
