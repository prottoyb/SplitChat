# SplitChat

Expense splitting for groups — flatmates, trips, couples, clubs. Members
record shared expenses in AUD, see equal splits to the cent, and manage
group membership. Product direction: `docs/product-vision.md`; plan:
`docs/roadmap.md`. This is a developer README; the full project README is
roadmap Phase 9.

## Stack

- React 19 + TypeScript + Vite, React Router, CSS Modules.
- Supabase (Auth, Postgres, Row Level Security) via `@supabase/supabase-js`.
  No backend server of our own: authorization lives in the database (RLS,
  grants, `SECURITY DEFINER` RPCs that authorize first).
- Money is integer cents at every boundary; equal splits use one canonical
  rule (ascending user id, remainder cents to the first) shared by the
  frontend and the database (ADR-0006).

## Setup

1. `npm install` (current Node LTS).
2. Create `.env.local` (git-ignored) with the project's public client
   settings (read by `src/lib/supabase.ts`):
   ```
   VITE_SUPABASE_URL=https://<project-ref>.supabase.co
   VITE_SUPABASE_PUBLISHABLE_KEY=<public publishable/anon key>
   ```
   Only the public key belongs in the client — never a service-role key.
3. `npm run dev`.

## Checks (run before any change is considered done)

| Command | What it runs |
|---|---|
| `npm run lint` | ESLint |
| `npm run build` | `tsc -b && vite build` |
| `npm test` | Vitest: `src/**/*.test.ts(x)` and `scripts/**/*.test.mjs` |
| `npm run test:db` | Database harness: a throwaway local PostgreSQL 17 cluster with a Supabase role/auth shim; applies every migration, proves each rollback (up → down → up), checks the baseline round-trip, then runs `tests/db/cases/*.sql` |

`test:db` needs PostgreSQL 17 binaries (default Windows install path, or set
`SPLITCHAT_PG_BIN`). It only ever connects to its own loopback cluster.

## Code structure

`src/app` (routes, layout) · `src/shared` (Supabase client and `Result`
error codes, integer-cent money, dates, `useResource`, UI primitives) ·
`src/features/<feature>` (`api/` — the only code that talks to Supabase —
`domain/`, `components/`, `pages/`, public `index.ts`). The rules are in
`docs/ADR/0008-frontend-feature-modules.md` and are checked by
`scripts/architecture.test.mjs`.

CI (`.github/workflows/ci.yml`) runs lint, build, tests, `npm audit` and the
database harness on every push and pull request.

## Database changes

- The schema is under migration control: `supabase/migrations/` (M0 is the
  captured production baseline), with a tested rollback for each in
  `supabase/rollbacks/`. No dashboard edits.
- Every production operation needs explicit human approval and is run by
  the operator with `scripts/ops/prod.mjs --batch <id>` (hash-pinned files,
  exact schema and history checks, read-only pre/post checks). It is first
  dress-rehearsed on the separate SplitChat-Dev project
  (`--rehearse-on-dev`, `scripts/rehearsal/`).
- Design and decisions: `docs/phase1/design.md`, `docs/ADR/`. Current
  state and resume point: `docs/phase-state.md`.

## Security notes

- Secrets live only in git-ignored files (`.env.local`,
  `.env.splitchat-dev.local`) or the operator's shell; never commit or
  print them.
- Groups are tenant boundaries: members see only groups they actively
  belong to; ledger writes happen only through reviewed RPCs; triggers
  enforce balanced splits and immutable identities for every role.
- Account deletion keeps shared history: profiles are tombstoned
  ("Deleted user"), and an owner must transfer a shared group first.
