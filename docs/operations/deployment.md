# Frontend deployment

Prepared in Phase 8; **nothing is deployed** until the operator approves a
release (Phase 9 chooses the host). The app is a static single-page app;
there is no server of our own.

## Build

| | |
|---|---|
| Node | 24 (as CI) |
| Install | `npm ci` |
| Build | `npm run build` (`tsc -b && vite build`) |
| Output | `dist/` (static files; `dist/index.html` + hashed `dist/assets/*`) |
| Checks before building a release | `npm run lint`, `npm test`, `npm audit`, CI green on the release commit |

## Environment variables (build time)

Vite inlines these into the bundle at build time; set them in the host's
build settings, never in the repository.

| Variable | Value | Notes |
|---|---|---|
| `VITE_SUPABASE_URL` | `https://jhftlnsccurhfgneltgi.supabase.co` | production project URL (public) |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | the production **publishable / anon** key | public by design; **never** the service-role key |

No other variable is read by the app. `.env.local` (git-ignored) holds the
production values for local builds; `npm run dev` refuses to start against
production unless `SPLITCHAT_DEV_ALLOW_PRODUCTION=yes`, and tests always use
a non-routable placeholder.

## SPA routing

Every path that is not a file must serve `index.html` with status 200
(client-side routes such as `/groups/<id>/chat`, `/expenses/<id>/edit`,
`/login`). Typical settings: Netlify `/* /index.html 200`; Vercel rewrite
`{ "source": "/(.*)", "destination": "/index.html" }`; Cloudflare Pages
serves SPAs by default. Hashed files under `/assets/` can be cached
immutably; `index.html` must not be cached long.

## Supabase Auth settings (production; operator-only change)

Sign-up sends a confirmation email whose link returns to
`window.location.origin`. In the production project's Auth URL
configuration:

- **Site URL:** the production origin (e.g. `https://splitchat.example`).
- **Redirect URLs:** the production origin (and any preview origin you
  intend to use). Without it, confirmation links fall back to the Site URL.

Changing production Auth settings is a human-gated action (CLAUDE.md).

## Ordering (mandatory)

1. Production database batch 4 applied **and verified**
   (`docs/operations/release-runbook.md`). The Phase 3–8 frontend needs
   the batch-4 schema (activity, settlements, chat, proposals); against the
   current production schema it would fail.
2. Build the frontend from the release commit (must contain `a5ed4e8`, the
   integer-cents frontend, and the Phase 8 commits).
3. Deploy; smoke-test sign-in, a group, an expense, balances, chat.
4. Record the deployed commit (it becomes the frontend attestation for any
   later database batch).

Rollback of the frontend: redeploy the previous build. Batch 4 is additive
for older frontends, so a frontend rollback never needs a database rollback.
