// Strict readers for the pinned Supabase CLI's machine output, used by
// scripts/ops/prod.mjs. Kept free of side effects so they can be unit-tested.
//
// Why strict: the CLI chooses its default output format from the environment
// (it prints JSON when it detects an AI agent and a text table otherwise), so
// the tool always asks for JSON explicitly (`--output-format json`, with
// `--agent no`) and refuses anything that is not exactly the expected
// document. An unreadable history must stop the procedure; it must never be
// mistaken for an empty or partial one.

// Flags added to every CLI invocation: behave the same whether the operator
// or an agent runs the tool (the rehearsal must match production).
export const CLI_MODE_FLAGS = ['--agent', 'no']

// `migration list` in JSON form.
export const MIGRATION_LIST_ARGS = ['migration', 'list', '--output-format', 'json']

const VERSION = /^\d{14}$/

function refuse(reason, stdout) {
  const excerpt = String(stdout ?? '').trim().slice(0, 80).replace(/\s+/g, ' ')
  return new Error(`REFUSING: could not read the migration history (${reason}); output began: ${JSON.stringify(excerpt)}`)
}

/**
 * Parses `supabase migration list --output-format json` stdout and returns
 * the remote (applied) versions in the order listed. The whole of stdout
 * must be one JSON object with a `migrations` array whose entries carry
 * 14-digit `local` / `remote` versions (either may be empty for a version
 * present on one side only). Throws a REFUSING error otherwise.
 */
export function parseMigrationList(stdout) {
  const text = String(stdout ?? '').trim()
  if (!text) throw refuse('empty output', stdout)
  let doc
  try {
    doc = JSON.parse(text)
  } catch (error) {
    throw refuse(`not a JSON document: ${error.message}`, stdout)
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc) || !Array.isArray(doc.migrations)) {
    throw refuse('no migrations array', stdout)
  }
  const remote = []
  for (const [i, m] of doc.migrations.entries()) {
    if (m === null || typeof m !== 'object') throw refuse(`entry ${i} is not an object`, stdout)
    for (const side of ['local', 'remote']) {
      const v = m[side]
      if (v !== undefined && v !== null && v !== '' && !(typeof v === 'string' && VERSION.test(v))) {
        throw refuse(`entry ${i} has an invalid ${side} version`, stdout)
      }
    }
    if (!m.local && !m.remote) throw refuse(`entry ${i} has neither a local nor a remote version`, stdout)
    if (m.remote) remote.push(m.remote)
  }
  if (new Set(remote).size !== remote.length) throw refuse('duplicate remote versions', stdout)
  return remote
}
