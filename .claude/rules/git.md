# Git Standards

Git history must remain understandable and recoverable.

---

## Canonical Branch

The canonical/default branch is the repository's configured primary
integration branch (commonly `main` or `master` — verify which for the
project at hand rather than assuming).

Agents must not push directly to the canonical branch.

Meaningful development must occur on a feature or fix branch.

Agents must not force-push, or otherwise rewrite history, on the
canonical branch or any other shared/protected branch. A force-push is
permitted only on an agent's own feature branch that no other agent
depends on; if another agent may depend on it, treat it as shared (see
Worktrees) rather than rewriting it. Force-pushing to a shared branch is
a high-risk irreversible action (`.claude/rules/security.md`) and
requires the execution approval that entails.

The `git-guard` hook (`.claude/hooks/git-guard.mjs`) enforces the first
two mechanically: it blocks pushes to `main`, `master` and the remote's
default branch, and every force-push variant. It cannot tell whether a
branch is "own and unshared", so it blocks force-pushes of feature
branches too — the operator runs those themselves (`!` prefix in the
session). It also blocks clearly destructive commands (`git reset
--hard`, `git clean -f`, ...). Coverage and gaps: `docs/enforcement.md`.

---

## Branch Naming

Prefer:

feature/<name>
fix/<name>
refactor/<name>
docs/<name>
test/<name>
chore/<name>

---

## Commits

Commits should:

- represent coherent changes
- have clear messages
- avoid unrelated modifications
- avoid generated or unrelated noise (e.g., formatting-only diffs across
  untouched files, accidental regeneration of build/lock files)

---

## Pull Requests

Meaningful features should be delivered through Pull Requests.

A Pull Request should communicate:

- what changed
- why it changed
- how it was tested
- known limitations
- security considerations, whenever the change touches authentication,
  authorization, data access, external input, or dependencies — otherwise
  state explicitly that there is no security impact

---

## Worktrees

Parallel implementation agents should use isolated worktrees whenever
their changes could touch overlapping files or shared state.

Agents must not overwrite another agent's working changes.

An isolated worktree (`isolation: worktree`) starts from the repository's
default branch, not the delegator's current HEAD. When delegated work
depends on the coordinator's local work, the coordinator commits that
work (on a feature branch — never by pushing to the canonical branch)
and names the base revision in the work packet; the specialist verifies
its base, may fast-forward to it (`git merge --ff-only <base>`), and
stops and reports if it cannot. If that is impractical, keep the
implementation in the main session instead of delegating. Naming a
revision does not by itself change the worktree.

---

## Shared Resources and Merge Ordering

When multiple agents have open work touching overlapping files,
dependent behaviour, or the same shared environment (e.g., a shared
staging environment or the same migration target), the coordinator —
the main session, or `engineering-lead` when invoked for
coordination-heavy work — must:

- designate a single owner for that shared resource for the duration of
  the change, so no two agents act on it concurrently
- determine merge order among conflicting or dependent pull requests,
  and may require one to rebase on another

This arbitration covers ordering and technical sequencing only. It does
not waive CI, review, or any required human approval for any pull
request in the sequence (`CLAUDE.md`'s Agent Orchestration).

---

## Canonical Branch Protection

Never bypass required review or validation simply to merge faster.

A pull request containing a high-risk irreversible action
(`.claude/rules/security.md`) — including a destructive database change
— must not be merged, and the action must not be executed, without the
specific approval that action requires under `CLAUDE.md`'s Human
Approval section.

---

## Before Completion

Inspect:

git status

and the final diff.

Do not accidentally commit:

- credentials
- local configuration
- build artifacts
- temporary files
- unrelated changes