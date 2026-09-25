#!/usr/bin/env node
// Tier-1 database test harness (docs/phase1/design.md §C, ADR-0007).
//
// Creates a throwaway PostgreSQL 17 cluster on loopback, loads the Supabase
// compatibility shim, applies supabase/migrations in order as the
// non-superuser `postgres` role, proves the baseline migration round-trips
// to the Phase 0 capture, then runs every tests/db/cases/*.sql file in its
// own fresh copy of the seeded database. The cluster is deleted afterwards.
//
// Safety (design DS-8): this script can only ever talk to the cluster it
// created. Child processes get an environment with every PG*/database-URL
// variable removed and libpq service/password files pointed at nonexistent
// paths; every connection string is built here with host 127.0.0.1 and the
// cluster's own port; and before any SQL runs against a database the script
// asserts the server address is loopback, the port matches, and the
// cluster's system identifier equals the one recorded right after initdb.
//
// Usage: npm run test:db [-- --keep] [-- --case <substring>]
// PG binaries: SPLITCHAT_PG_BIN, else the default PostgreSQL 17 install
// location on Windows, else PATH.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const keep = args.includes('--keep')
const caseFilter = args.includes('--case') ? args[args.indexOf('--case') + 1] : null

const SUPERUSER = 'cluster_admin'
const TEMPLATE_DB = 'splitchat_template'
const ROUNDTRIP_DB = 'splitchat_m0'
const BASELINE_DUMP = path.join(root, 'supabase', 'baseline', 'public_schema.sql')
const MIGRATIONS_DIR = path.join(root, 'supabase', 'migrations')
const ROLLBACKS_DIR = path.join(root, 'supabase', 'rollbacks')
const SHIM_DIR = path.join(root, 'tests', 'db', 'shim')
const CASES_DIR = path.join(root, 'tests', 'db', 'cases')

const FORBIDDEN_ENV = /^(PG.*|DATABASE_URL|DB_URL|SUPABASE_DB_URL|SUPABASE_ACCESS_TOKEN|POSTGRES_.*)$/i

function pgBin(name) {
  const dir =
    process.env.SPLITCHAT_PG_BIN ||
    (process.platform === 'win32' ? 'C:\\Program Files\\PostgreSQL\\17\\bin' : '')
  const exe = process.platform === 'win32' ? `${name}.exe` : name
  if (!dir) return exe
  const full = path.join(dir, exe)
  if (!fs.existsSync(full)) {
    throw new Error(`${full} not found. Install PostgreSQL 17 or set SPLITCHAT_PG_BIN to its bin directory.`)
  }
  return full
}

// An environment that cannot point libpq anywhere but where we say.
export function isolatedEnv(baseEnv, tmpDir) {
  const env = {}
  for (const [key, value] of Object.entries(baseEnv)) {
    if (!FORBIDDEN_ENV.test(key)) env[key] = value
  }
  env.PGSERVICEFILE = path.join(tmpDir, 'no-such-service-file')
  env.PGSYSCONFDIR = path.join(tmpDir, 'no-such-sysconf-dir')
  env.PGPASSFILE = path.join(tmpDir, 'no-such-pgpass')
  env.PGCONNECT_TIMEOUT = '10'
  return env
}

function run(cmd, cmdArgs, options = {}) {
  const result = spawnSync(cmd, cmdArgs, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  })
  if (result.error) throw result.error
  return result
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function normaliseDump(text) {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => !/^\\(un)?restrict /.test(line))
    .filter((line) => !/^-- Dumped (from|by) /.test(line))
    .join('\n')
    .trim()
}

// ACL entry order carries no meaning, but revoking and re-granting reorders
// it. Rollback comparisons sort each consecutive GRANT/REVOKE run.
function sortAclRuns(text) {
  const out = []
  let run = []
  const flush = () => {
    out.push(...run.sort())
    run = []
  }
  for (const line of text.split('\n')) {
    if (/^(GRANT|REVOKE) /.test(line)) run.push(line)
    else {
      flush()
      out.push(line)
    }
  }
  flush()
  return out.join('\n')
}

class Cluster {
  constructor(tmpDir, port) {
    this.tmpDir = tmpDir
    this.dataDir = path.join(tmpDir, 'data')
    this.port = port
    this.env = isolatedEnv(process.env, tmpDir)
    this.systemIdentifier = null
  }

  conn(db, user) {
    return `host=127.0.0.1 port=${this.port} dbname=${db} user=${user} sslmode=disable`
  }

  init() {
    const r = run(pgBin('initdb'), ['-D', this.dataDir, '-U', SUPERUSER, '-A', 'trust', '-E', 'UTF8', '--no-locale'], { env: this.env })
    if (r.status !== 0) throw new Error(`initdb failed:\n${r.stderr}`)
    const control = run(pgBin('pg_controldata'), ['-D', this.dataDir], { env: this.env })
    const match = /Database system identifier:\s+(\d+)/.exec(control.stdout)
    if (!match) throw new Error('could not read the new cluster system identifier')
    this.systemIdentifier = match[1]
  }

  start() {
    const opts = `-p ${this.port} -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off`
    // stdio ignored: on Windows the detached server would otherwise inherit our pipes.
    const r = run(pgBin('pg_ctl'), ['start', '-w', '-D', this.dataDir, '-l', path.join(this.tmpDir, 'server.log'), '-o', opts], { env: this.env, stdio: 'ignore' })
    if (r.status !== 0) throw new Error(`pg_ctl start failed; see ${path.join(this.tmpDir, 'server.log')}`)
    this.started = true
  }

  stop() {
    if (!this.started) return
    run(pgBin('pg_ctl'), ['stop', '-m', 'fast', '-w', '-D', this.dataDir], { env: this.env, stdio: 'ignore' })
    this.started = false
  }

  psql(db, user, { file, sql, extra = [], env } = {}) {
    const a = ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', this.conn(db, user), ...extra]
    if (file) a.push('-f', file)
    if (sql) a.push('-c', sql)
    return run(pgBin('psql'), a, { env: env ?? this.env })
  }

  // Database lifecycle statements run on the maintenance database; each is
  // preceded by its own target check (review CP-QS-1).
  createDb(name, clause) {
    this.assertTarget('postgres')
    this.mustPsql('postgres', SUPERUSER, { sql: `CREATE DATABASE ${name} ${clause}` })
    this.assertTarget(name)
  }

  dropDb(name) {
    this.assertTarget('postgres')
    this.mustPsql('postgres', SUPERUSER, { sql: `DROP DATABASE ${name}` })
  }

  dumpPublic(db) {
    this.assertTarget(db)
    const r = run(pgBin('pg_dump'), ['--schema-only', '--schema=public', '--schema=private', '-d', this.conn(db, SUPERUSER)], { env: this.env })
    if (r.status !== 0) throw new Error(`pg_dump failed on ${db}:\n${r.stderr}`)
    return normaliseDump(r.stdout)
  }

  mustPsql(db, user, opts) {
    const r = this.psql(db, user, opts)
    if (r.status !== 0) {
      throw new Error(`psql failed on ${db} as ${user} (${opts.file ?? opts.sql}):\n${r.stderr}${r.stdout}`)
    }
    return r
  }

  // Positive-target guard: prove we are connected to our own disposable cluster.
  assertTarget(db, env) {
    const r = this.psql(db, SUPERUSER, {
      sql: "SELECT inet_server_addr()::text || '|' || current_setting('port') || '|' || (SELECT system_identifier::text FROM pg_control_system())",
      extra: ['-At'],
      env,
    })
    if (r.status !== 0) throw new Error(`target check failed on ${db}:\n${r.stderr}`)
    const [addr, port, sysid] = r.stdout.trim().split('|')
    if (!/^(127\.0\.0\.1|::1)(\/\d+)?$/.test(addr) || port !== String(this.port) || sysid !== this.systemIdentifier) {
      throw new Error(`REFUSING: ${db} is not the disposable test cluster (addr=${addr} port=${port})`)
    }
  }
}

function listSql(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => path.join(dir, f))
}

function spoofCheck(cluster) {
  // DS-8 self-test: hostile variables in the parent environment must not
  // change where we connect.
  const hostile = {
    ...process.env,
    PGHOST: '203.0.113.10',
    PGPORT: '5432',
    PGSERVICE: 'production',
    PGDATABASE: 'postgres',
    DATABASE_URL: 'postgresql://attacker@203.0.113.10:5432/postgres',
    DB_URL: 'postgresql://attacker@203.0.113.10:5432/postgres',
  }
  const env = isolatedEnv(hostile, cluster.tmpDir)
  const leaked = Object.keys(env).filter((k) => FORBIDDEN_ENV.test(k) && !['PGSERVICEFILE', 'PGSYSCONFDIR', 'PGPASSFILE', 'PGCONNECT_TIMEOUT'].includes(k))
  if (leaked.length) throw new Error(`isolatedEnv leaked: ${leaked.join(', ')}`)
  cluster.assertTarget('postgres', env)
}

// Every migration after the baseline must ship a rollback that restores the
// previous schema exactly, and must re-apply cleanly afterwards
// (up -> down -> up; design §B).
function checkRollbacks(cluster, migrations) {
  for (let k = 1; k < migrations.length; k++) {
    const base = path.basename(migrations[k], '.sql')
    const down = path.join(ROLLBACKS_DIR, `${base}.down.sql`)
    if (!fs.existsSync(down)) throw new Error(`missing rollback supabase/rollbacks/${base}.down.sql`)
    const db = `rollback_${k}`
    cluster.createDb(db, 'OWNER postgres')
    cluster.mustPsql(db, SUPERUSER, { file: path.join(SHIM_DIR, '01_database.sql') })
    for (const file of migrations.slice(0, k)) cluster.mustPsql(db, 'postgres', { file, extra: ['-1'] })
    const before = sortAclRuns(cluster.dumpPublic(db))
    cluster.mustPsql(db, 'postgres', { file: migrations[k], extra: ['-1'] })
    cluster.mustPsql(db, 'postgres', { file: down, extra: ['-1'] })
    const after = sortAclRuns(cluster.dumpPublic(db))
    if (after !== before) {
      const a = before.split('\n')
      const b = after.split('\n')
      const at = a.findIndex((line, idx) => line !== b[idx])
      throw new Error(`rollback ${base}.down.sql does not restore the previous schema exactly; first difference at line ${at + 1}:\n  before:   ${a[at]}\n  after:    ${b[at]}`)
    }
    cluster.mustPsql(db, 'postgres', { file: migrations[k], extra: ['-1'] })
    cluster.dropDb(db)
    console.log(`pass  rollback up/down/up  ${base}`)
  }
}

function runCases(cluster) {
  const files = listSql(CASES_DIR).filter((f) => !caseFilter || path.basename(f).includes(caseFilter))
  const results = []
  for (const [i, file] of files.entries()) {
    const name = path.basename(file)
    const db = `case_${i}`
    // If anything below throws, case_<i> is left behind on purpose: the whole
    // disposable cluster is then kept for diagnosis or deleted (CP-SR-1).
    cluster.createDb(db, `TEMPLATE ${TEMPLATE_DB}`)
    const r = cluster.psql(db, SUPERUSER, { file })
    const oks = (r.stderr.match(/NOTICE:\s+ok: /g) ?? []).length
    const failure = r.status !== 0 ? (r.stderr.split('\n').find((l) => /ERROR/.test(l)) ?? r.stderr.trim()) : null
    results.push({ name, oks, failure })
    console.log(`${failure ? 'FAIL' : 'pass'}  ${name}  (${oks} assertions)${failure ? `\n      ${failure}` : ''}`)
    cluster.dropDb(db)
  }
  return results
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'splitchat-dbtest-'))
  const cluster = new Cluster(tmpDir, await freePort())
  let failed = false
  try {
    cluster.init()
    cluster.start()
    cluster.assertTarget('postgres')
    spoofCheck(cluster)
    console.log(`cluster up on 127.0.0.1:${cluster.port} (guard + spoof check passed)`)

    cluster.mustPsql('postgres', SUPERUSER, { file: path.join(SHIM_DIR, '00_roles.sql') })
    const migrations = listSql(MIGRATIONS_DIR)
    if (migrations.length === 0) throw new Error('no migrations found')

    // Round-trip: the baseline migration alone must reproduce the Phase 0 dump.
    cluster.createDb(ROUNDTRIP_DB, 'OWNER postgres')
    cluster.mustPsql(ROUNDTRIP_DB, SUPERUSER, { file: path.join(SHIM_DIR, '01_database.sql') })
    cluster.mustPsql(ROUNDTRIP_DB, 'postgres', { file: migrations[0], extra: ['-1'] })
    cluster.assertTarget(ROUNDTRIP_DB)
    const dump = run(pgBin('pg_dump'), ['--schema-only', '--schema=public', '-d', cluster.conn(ROUNDTRIP_DB, SUPERUSER)], { env: cluster.env })
    if (dump.status !== 0) throw new Error(`pg_dump failed:\n${dump.stderr}`)
    const expected = normaliseDump(fs.readFileSync(BASELINE_DUMP, 'utf8'))
    const actual = normaliseDump(dump.stdout)
    if (expected !== actual) {
      const a = expected.split('\n')
      const b = actual.split('\n')
      const at = a.findIndex((line, idx) => line !== b[idx])
      fs.writeFileSync(path.join(tmpDir, 'roundtrip-actual.sql'), actual)
      throw new Error(`baseline round-trip differs at normalised line ${at + 1}:\n  expected: ${a[at]}\n  actual:   ${b[at]}\n(full dump kept in ${tmpDir})`)
    }
    console.log(`pass  baseline round-trip (${path.basename(migrations[0])} == supabase/baseline/public_schema.sql)`)

    // Full migration chain + fixtures into the template database.
    checkRollbacks(cluster, migrations)

    cluster.createDb(TEMPLATE_DB, 'OWNER postgres')
    cluster.mustPsql(TEMPLATE_DB, SUPERUSER, { file: path.join(SHIM_DIR, '01_database.sql') })
    const selftest = cluster.mustPsql(TEMPLATE_DB, SUPERUSER, { file: path.join(SHIM_DIR, '02_selftest.sql') })
    if (!/ok: shim roles/.test(selftest.stderr)) throw new Error('shim self-test did not report success')
    for (const file of migrations) {
      cluster.assertTarget(TEMPLATE_DB)
      cluster.mustPsql(TEMPLATE_DB, 'postgres', { file, extra: ['-1'] })
      console.log(`applied  ${path.basename(file)}`)
    }
    cluster.mustPsql(TEMPLATE_DB, SUPERUSER, { file: path.join(root, 'tests', 'db', 'helpers.sql') })
    cluster.mustPsql(TEMPLATE_DB, SUPERUSER, { file: path.join(root, 'tests', 'db', 'fixtures', 'seed.sql'), extra: ['-1'] })

    const results = runCases(cluster)
    const failures = results.filter((r) => r.failure)
    const assertions = results.reduce((n, r) => n + r.oks, 0)
    console.log(`\n${results.length - failures.length}/${results.length} case files passed, ${assertions} assertions`)
    failed = failures.length > 0 || results.length === 0
  } catch (error) {
    console.error(`\nERROR: ${error.message}`)
    failed = true
  } finally {
    cluster.stop()
    if (keep || failed) console.log(`cluster data kept in ${tmpDir}`)
    else fs.rmSync(tmpDir, { recursive: true, force: true })
  }
  process.exit(failed ? 1 : 0)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
