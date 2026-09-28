# Phase 7 — Deterministic Smart Expense

**Status:** ✅ COMPLETE 2026-09-29 on `feature/phase7-smart-expense`
(UI/UX rendered review APPROVE AFTER FIXES → fixed and re-rendered;
QA/Security PASS, fixes re-verified PASS with its MEDIUM RESOLVED; Senior
Review APPROVE). Design: ADR-0012 (plus M20 below).

## Trust chain (operator rule)

chat message → deterministic interpreter (client, pure) → `validateDraft`
→ candidate (`propose_expense_candidate`, server re-validates) → human
review / edit → explicit confirmation → `approve_expense_candidate` →
`private.create_equal_split_expense_core` (the same core manual creation
uses) → ledger. The interpreter never writes anything; nothing becomes an
expense without a person confirming the amount and each share.

## Delivered

| Area | What |
|---|---|
| M19 `20260929100000_smart_expense_candidates.sql` | Shared private expense core (v2 now a thin wrapper, contract unchanged — every earlier v2/ledger case passes unmodified); `expense_candidates` (one per message, composite FK keeps message and candidate in one group, nullable draft, approved ⇒ complete, immutable once decided, cascade only with the group, RLS read for active members, no client writes, published for Realtime); propose (sender only, idempotent) / update (versioned) / reject (idempotent) / approve (idempotent: one expense per candidate, provenance `candidate_id`, `message_id`, `proposed_by` in `expense_created`); manage rule M13; lock order group KEY SHARE → candidate → memberships by `user_id` |
| M20 `20260929110000_expense_core_membership_locks.sql` | QA/Security MEDIUM (pre-existing since M12): the core now holds the actor, payer and participants as members until the expense commits (group KEY SHARE, memberships FOR SHARE in `user_id` order, re-checked). Covers manual creation and approval |
| Interpreter | `features/smart-expense/domain` — `ExpenseInterpreter` interface, `deterministic-1` split into `text`, `amounts` (shared cents parser, rule A, foreign currency refused), `people` (exact / unique first name, active members only, no prefixes or nicknames), `fields`, `command` (`/expense` grammar), `natural` (conservative detection D1–D5, extraction N1–N6); `validateDraft` is the gate for any interpreter, a future LLM included |
| UI | `CandidateCard` under its message (bordered "Expense proposal" panel, never a bubble; status and missing fields in text + icon; hints from the message such as "Choose: Sam Lee or Sam Park"; "Add details" leads when incomplete; confirmation "Add this $X expense?" listing each share with Cancel focused; Reject behind a confirmation; actions only for proposer/owner; "View expense" once added), "Record as expense" on own messages with a number; Realtime INSERT/UPDATE merged by version; proposals only for a send the server just confirmed from this client (never history). Chat gained generic extension slots; chat does not import smart-expense |
| Tests | Vitest **525/525** (36 files; smart-expense 85 incl. 60 interpreter vectors — normal, ambiguous, malformed, adversarial); **test:db 31/31 (737)** incl. 240 (73), 241 (23, dblink), 242 (12, dblink: participant, payer and creator removed/left; fails without M20) |

## SplitChat-Dev rehearsal (2026-09-28/29)

- M19 then M20 pushed alone with the pinned CLI from a staging copy; ledger
  fingerprint identical before/after each; Dev schema IDENTICAL to the
  harness after each (3264, then 3280 normalised lines). Publication:
  `group_messages`, `expense_candidates`.
- `api-smart-expense.mjs` **23/23** (proposal INSERT and approval UPDATE
  delivered to members; outsider, former member and anon receive and read
  nothing; canonical shares sum; balances move and net to zero; provenance;
  idempotent approve; departed proposer refused; owner approves; incomplete
  and rejected refused). After M20 also `api-chat` 25/25,
  `api-settlements` 19/19, `api-activity` 11/11.
- Rendered review with seeded proposals (approved / needs details / ready):
  composer measured visible in the first viewport at 1440, 900, 390.

## Reviews

- **UI/UX:** HIGH confirm-button grammar → "Add this $X expense?" + "Add
  expense"; MEDIUM missing-field guidance inline and "Add details" first
  for incomplete proposals; LOW distinct amber "Needs details". Earlier
  render fixes: chat stays at the latest message as cards load; Reject sits
  in the action row.
- **QA/Security:** PASS. MEDIUM (pre-existing race in expense creation) →
  M20 + case 242. Focused re-verification of `7fe7212..475e9f5`: PASS,
  MEDIUM RESOLVED, no lock-order cycle against any RPC or trigger, v2
  contract unchanged; its LOW (creator-removed scenario) added to 242.
- **Senior:** APPROVE. MEDIUM interpreter cohesion → split into modules;
  LOW memoised hints and one "missing" helper; OPTIONAL comment added.

## Deferred

- LOW: the "Old proposal" note (30 days) has no call to action.
- LOW: former members referenced only by a proposal's draft (payer or
  participant who left before approval) show as "Former member" on the
  card (names come from current members).
- OPTIONAL: move the Chat tab earlier now that it is also an expense-entry
  surface (designer; revisit with usage).
- Candidate edit history is not kept (by design, ADR-0012).
- Product choices recorded in ADR-0012's status for operator confirmation
  before production.
