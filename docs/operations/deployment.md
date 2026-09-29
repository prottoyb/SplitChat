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

Phase 9 adds password reset, which needs more before the Phase 9 frontend
goes live:

- **Redirect URLs** must also allow `<production origin>/reset-password`
  (the reset email links there).
- **Email delivery** must work for the production project (a reset link
  that never arrives is a dead end); test it with a real reset.
- **"Secure password change"** (recent sign-in or reauthentication before
  `updateUser` sets a password) must be confirmed enabled. It is the
  server-side control behind the reset/change-password UI (Phase 9
  QA/Security, `docs/phase9/plan.md`).

Changing production Auth settings is a human-gated action (CLAUDE.md).

## Ordering (mandatory)

1. Production database batch 4 applied **and verified**
   (`docs/operations/release-runbook.md`). Done: production is at M23
   (25 versions) since 2026-09-29.
2. **For a Phase 9 frontend:**
   - **Required, not yet done:** batch 5 must be applied and verified in
     production (production is at M23 until then). Batch 5 is M24
     `20261001100000_group_details` and M25
     `20261001110000_profile_name_rules`. It needs its own release approval
     (ADR-0013). Tool, pre/post-checks and runbook:
     `prod.mjs --batch batch5`, `docs/phase9/release-batch5.md`. Its
     preflight includes the M25 compatibility count (Q23), which must be 0.
     Without M24, group rename fails.
   - The Phase 9 Auth settings above are completed and tested. Without
     them, password reset fails.
   - The reset-link race fix must be in the release commit. It is fixed on
     `fix/password-recovery-race` (QA/Security PASS, Senior APPROVE; the
     E2E genuine reset-link journey passes on Dev, 2026-09-29) but **not
     yet merged to `main`**. See `docs/phase9/release-batch5.md`, "Reset-link
     race fix".
3. Build the frontend from the release commit (must contain `a5ed4e8`, the
   integer-cents frontend, and the Phase 8 commits).
4. Deploy; smoke-test sign-in, a group, an expense, balances, chat, and
   (Phase 9) rename a group, edit a display name, change and reset a
   password.
5. Record the deployed commit (it becomes the frontend attestation for any
   later database batch).

Rollback of the frontend: redeploy the previous build. Batch 4, M24 and M25
are additive for older frontends, so a frontend rollback never needs a
database rollback.
