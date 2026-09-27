#!/usr/bin/env node
// Compares two schema-only dumps using the harness normalisation
// (psql restrict keys and version comments removed). With --acl-order,
// consecutive GRANT/REVOKE runs are sorted, because ACL entry order carries no
// meaning. Usage: node scripts/rehearsal/compare-dumps.mjs <expected> <actual> [--acl-order]
import fs from 'node:fs'
import { normaliseDump, sortAclRuns } from '../db-test.mjs'

const [expectedFile, actualFile, flag] = process.argv.slice(2)
const prep = (file) => {
  const text = normaliseDump(fs.readFileSync(file, 'utf8'))
  return flag === '--acl-order' ? sortAclRuns(text) : text
}
const a = prep(expectedFile).split('\n')
const b = prep(actualFile).split('\n')
const at = a.findIndex((line, i) => line !== b[i])
if (at === -1 && a.length === b.length) {
  console.log(`IDENTICAL (${a.length} normalised lines)`)
} else {
  const i = at === -1 ? Math.min(a.length, b.length) : at
  console.log(`DIFFERENT at normalised line ${i + 1}\n  expected: ${a[i] ?? '<end>'}\n  actual:   ${b[i] ?? '<end>'}`)
  process.exit(1)
}
