# ADR-0012: Smart Expense (deterministic)

**Status:** Accepted 2026-09-28 (Software Architect design; team adoption
under the operator's instruction to implement the approved Smart Expense
pipeline with the interpreter behind an interface). Built and tested locally
and on SplitChat-Dev in Phase 7; production only in a later reviewed release
batch with its own execution approval. **Supersedes** ADR-0011's sentence
"Phase 7 candidate decisions do [write group_events]" (see Options).
**Product choices recorded for operator confirmation before production**
(not blocking local/Dev work): the approver becomes the expense creator;
candidates are visible to all active members; natural-language detections
propose automatically; "with" includes the sender; the payer is never
defaulted; candidates never expire; candidate text is permanent after a
decision.

## Context
The operator fixed the trust chain: message → deterministic interpretation →
candidate → human review/edit → approval → canonical expense path → ledger.
The interpreter never writes financial state and never guesses critical
fields. Messages are immutable with bigint ids (ADR-0011). Expenses are
created only by `create_equal_split_expense_v2` (integer cents, canonical
`private.equal_split_cents`, membership checks, `expense_created` event;
ADR-0006, ADR-0009). Management rule (M13): the creator while an active
member, or the active owner. ADR-0008 rule 9: Smart Expense only produces
`ExpenseInput` candidates. Equal splits, AUD, no LLM, no new dependency.

## Options considered
- **Where interpretation runs:** server-side SQL parsing (brittle, puts the
  parser in the trusted zone) vs a pure client TypeScript interpreter with
  the server validating draft fields only. **Chosen: client.** The server
  never trusts how a draft was produced; it re-validates at approval.
- **Candidate storage:** a `kind` on messages (rejected by ADR-0011),
  local-only suggestions (nothing to review, audit or share), or an
  `expense_candidates` table, one row per message. **Chosen: table.**
- **Approval write:** client calls v2 after marking approved (two
  transactions → duplicates/orphans) vs an approve RPC calling a private core
  shared with v2 in one transaction. **Chosen: shared core.**
- **Audit events:** new kinds for proposed/approved/rejected vs the
  candidate row as the audit record plus provenance in `expense_created`.
  **Chosen: no new kinds** — events stay the ledger and membership log
  (ADR-0009 condition 1), the kinds CHECK and feed are untouched.
- **Realtime:** refetch on message insert (misses candidates proposed just
  after the send and decisions by others) vs Postgres Changes on
  `expense_candidates`. **Chosen: Postgres Changes** (ADR-0011 mechanism).

## Decision
**Interpreter (client, pure).** `features/smart-expense/domain`:
`interface ExpenseInterpreter { readonly version: string; interpret(body,
ctx): Promise<Interpretation> }`, `ctx = { senderId, messageDate, members }`
(active members with display names). Result `{ kind: 'none' }` or
`{ kind: 'candidate', source: 'command' | 'natural', draft, issues,
interpreterVersion }`; every draft field nullable; `issues` list `{ field,
code: missing | ambiguous | unknown_name | multiple_amounts |
invalid_amount | unsupported_currency | too_long | invalid_date, token?,
matches? }`. Implementation `deterministic-1`. All interpreter output (any
future LLM's too) passes one `validateDraft` before proposing; invalid
values become null plus an issue. Interpreters never call an API. Only the
review UI turns a draft into an `ExpenseInput` (via `validateExpenseForm`).

**No guessing (binding).** Amount, payer, participants and description are
filled only when stated and resolved to exactly one value. The date defaults
to the message's local date, is missing when an unrecognised date-like word
appears, and an explicit invalid date is never replaced. Notes are null.
"with L" includes the sender (grammar rule; the card names everyone).

**Who proposes.** Only the sender's client: automatically for the message it
has just sent (confirmed by the send result; never on history load), and via
"Record as expense" on the user's own message without a candidate
(`source = 'manual'`, fields null except the date). Every `/expense` message
proposes, even with issues; natural language only when detection passes.

**Table `public.expense_candidates` (M19).** `id uuid` PK; `group_id` FK
groups ON DELETE CASCADE; `message_id bigint NOT NULL UNIQUE` with composite
FK `(message_id, group_id)` → `group_messages (id, group_id)` (new UNIQUE on
that pair) ON DELETE CASCADE; `proposed_by` FK profiles RESTRICT, equal to
the message sender; `status` proposed | approved | rejected; `source` command
| natural | manual; `interpreter_version` 1–32 chars; nullable draft
`description` (1–120, trimmed), `amount_cents` (1–999999999999),
`expense_date`, `paid_by`, `participant_ids uuid[]` (1–200), `notes` (≤500);
`version int` from 1; `expense_id uuid UNIQUE` (no FK: expenses are
hard-deleted); `decided_by`, `decided_at`; `created_at`, `updated_at`,
`updated_by`. CHECKs: approved ⇔ `expense_id` set; proposed ⇔ `decided_*`
null; approved ⇒ every draft field but notes set. A guard trigger refuses
UPDATE of a decided row and DELETE unless the group row is gone. RLS SELECT
for active members; anon nothing; no client writes. No expiry (the UI labels
proposals older than 30 days).

**RPCs** (SECURITY DEFINER, `search_path=''`, EXECUTE for `authenticated`).
Manage rule for edit/reject/approve = M13: the proposer while an active
member, or the active owner. The approver becomes the expense creator and
event actor; `proposed_by` goes into the event payload.
- `propose_expense_candidate(message_id, source, interpreter_version,
  fields…)` → row; idempotent per message; only the message's sender.
- `update_expense_candidate(id, expected_version, fields…)` → row; whole
  draft replaced; `version + 1`.
- `reject_expense_candidate(id, expected_version)`; idempotent if rejected.
- `approve_expense_candidate(id, expected_version) → uuid`: already approved
  → the stored `expense_id` (manage rule still applies); rejected →
  `candidate_rejected`; incomplete → `candidate_incomplete`; otherwise
  `private.create_equal_split_expense_core(actor, …, provenance jsonb)`, then
  approved + `expense_id` + `decided_*`, one transaction. A later-deleted
  expense leaves the candidate approved; it is never re-created.

**Lock order in every candidate RPC:** unlocked authorization check → group
`FOR KEY SHARE` → candidate `FOR UPDATE` → re-check status/version → active
memberships `FOR SHARE` ordered by `user_id` (actor only for
propose/update/reject; actor ∪ payer ∪ participants for approve) → re-check
under the locks. Consistent with `delete_group`, the account-deletion
trigger and `transfer_group_ownership`; removal/leave commit first → approve
refused (`invalid_participants` / `invalid_payer`), candidate stays proposed;
approve first → removal waits.

**Core refactor.** `private.create_equal_split_expense_core(p_actor, …,
p_event_extra jsonb DEFAULT '{}')` holds v2's body with `v_uid` → `p_actor`
and the extra keys merged into the event payload; v2 becomes the
`auth_required` check plus `RETURN core(auth.uid(), …, '{}')`. Signature,
grants, error codes and order, and payload unchanged.

**Realtime.** `expense_candidates` joins `supabase_realtime`;
`subscribeGroupCandidates` listens for INSERT and UPDATE with the group
filter, parses strictly, merges by id when the version is newer; a bad
payload triggers a refetch; chat gap-fill also refetches candidates.

**Frontend.** `features/smart-expense/{domain, api, realtime, components}`.
Chat never imports smart-expense: `GroupChat` gains `onOwnMessageConfirmed`
and `renderAfterMessage` slots wired in `app/workspace/sections/ChatSection`.
`CandidateCard` is its own list item after its message, never inside the
bubble: bordered panel, "Expense proposal" label with an icon, status in text
("Needs review", "Expense added · View expense", "Rejected"), fields with
"Not set" / "Choose: Sam Lee or Sam Park" (text + icon, not colour). Edit
reuses the expenses form component and validation. Approve is disabled
while incomplete (reason shown) and opens a confirmation listing amount,
description, date, payer and the per-person split (canonical client mirror);
the confirm button reads "Add $84.50 expense", is not focused by default and
is disabled in flight. Actions are shown only to users the manage rule
allows; the server decides.

## Consequences
M19: one table, four RPCs, the private core (v2 a thin wrapper), a UNIQUE on
`group_messages (id, group_id)`, a publication change. The feed shows only
`expense_created`, whose payload now carries provenance. Candidate edit
history is not kept.

## Risks
- Refactoring the canonical write path — mitigated by the unchanged v2
  harness suite plus payload and error-order tests, and security review.
- A proposer's client can submit fields unlike the message — no more than v2
  already allows the proposer; the card shows server fields; approval is
  explicit.
- Natural-language false positives create visible proposals — conservative
  detection; one-click Reject.
- Candidate text is permanent after a decision (ADR-0011 trade-off).
- Owner approval makes the owner the expense creator.

## Binding conditions
1. One migration M19 in house style (`SET LOCAL lock_timeout`, REVOKE ALL
   then explicit GRANTs, `search_path=''`, header, rollback note).
2. v2's signature, grants, error codes and order, and payload unchanged; the
   existing v2/ledger harness passes unmodified; a test asserts v2's
   `expense_created` payload has no `candidate_id`.
3. The core is revoked from PUBLIC, anon, authenticated, service_role;
   raises `auth_required` on a null actor; never reads `auth.uid()`.
4. CHECKs and guard trigger as specified; RPCs validate too; no client
   INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER.
5. Error codes: `auth_required`, `not_found_or_forbidden`, `forbidden`,
   `stale_candidate`, `candidate_decided`, `candidate_rejected`,
   `candidate_incomplete`, `invalid_source`, plus v2's field codes; all
   mapped in the client.
6. Lock order exactly as above; manage rule and membership re-checked under
   the locks.
7. Approve idempotent: at most one expense per candidate (`expense_id
   UNIQUE` + row lock); exactly one `expense_created` per approval.
8. No new event kinds; the activity payload reader tolerates the optional
   `candidate_id`, `message_id`, `proposed_by` keys (tested).
9. Interpreter pure, no network, no `eval`, no regex built from input,
   linear regexes; bodies over 500 characters are not interpreted in
   natural mode.
10. All interpreter output goes through `validateDraft` (members, limits,
    AUD).
11. Proposals only from the sender's client, only in the two cases above.
12. Harness: permission matrix (propose/update/reject/approve × proposer
    active, proposer left, owner, other member, former member, outsider,
    anon); proposing on someone else's message or another group's;
    idempotent propose; approve twice → same id; approve after the expense
    was deleted → same id, nothing created; incomplete/rejected/stale
    refused; decided rows immutable (also for the table owner); concurrency
    approve×approve, approve×edit, approve×remove, approve×leave,
    approve×transfer, approve×delete_group; departed payer/participant
    refused and the candidate stays proposed; ledger balanced; RLS isolation;
    publication membership.
13. Interpreter vectors: normal; ambiguous (duplicate first/full names, "us",
    two payers, several amounts, weekday dates); malformed (`84.505`,
    `1,23.4`, `$`, `/expense` alone, invalid date, `with:` + `split:`,
    repeated key); adversarial (`-5`, `−5`, `0`, `1e5`, `0x10`, 20 digits,
    fullwidth and Arabic-Indic digits, € and US$, zero-width/bidi in names,
    `<script>` and SQL-like text as plain description, 2000-character input
    under 50 ms, "didn't pay $20", questions).
14. UI tests: incomplete drafts cannot be approved; the confirmation shows
    amount and split; buttons disabled in flight; unauthorized users see no
    actions; the card is outside the bubble; status in text.
15. SplitChat-Dev: A proposes, B receives the INSERT; A approves, B receives
    the UPDATE; the expense and balances appear for both; outsider, former
    member and anon see nothing; the owner approves a departed proposer's
    candidate.
16. Security review of the core refactor, RPCs, RLS and Realtime proof; the
    production batch pre-checks the publication.

## Interpreter specification (`deterministic-1`)

**Normalisation (all modes):** NFKC; remove zero-width and bidi controls;
collapse whitespace; keywords case-insensitive; amount digits must be ASCII
after NFKC.

**Amount rule A:** `^(A\$|\$|AUD)?(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?(AUD)?$`
(optional space before a suffix `AUD`), parsed to cents with string
arithmetic, 1–999,999,999,999 cents. A leading `-`/`−` → `invalid_amount`;
more than two decimals, bad grouping, exponent/hex → `invalid_amount`
(command) or not an amount (natural). €, £, ¥, US$, NZ$, USD, NZD, EUR, GBP,
euro(s), pound(s) next to a number → `unsupported_currency`, amount null.

**`/expense` grammar**
```
message     := "/expense" (WS | END) rest     ; first token, case-insensitive
rest        := [amount] [description] {option}
amount      := first token after the command, rule A
description := words up to the first option key; trimmed; empty → missing; >120 → too_long
option      := key ":" value                   ; value runs to the next key or END
key         := "paid" | "with" | "split" | "date"
paid:  person                                  ; omitted → payer missing (never defaulted)
with:  people → participants = {sender} ∪ people
split: people → exactly people | "all" | "everyone" → all active members
date:  YYYY-MM-DD | "today" | "yesterday"      ; relative to the message date
       omitted → message date; invalid/out of range → null + invalid_date
people := person {("," | " and " | "&") person}
```
A first token that is not an amount → amount missing and it starts the
description. `Dinner:` (unknown key) stays in the description. A repeated
key, or `with:` together with `split:` → that field null + `ambiguous`.

**Natural-language detection** (all must hold): D1 not starting with `/`;
D2 ≤ 500 characters; D3 not ending in `?` and none of not, never, don't,
didn't, won't, can't, isn't, wasn't; D4 an amount — currency-marked rule-A
token, or a bare rule-A number right after paid, spent, cost, costs, was;
D5 a cue word: paid, spent, bought, covered, split.

**Extraction:** N1 one distinct amount → it; several → null +
`multiple_amounts`. N2 payer: "I paid/spent/bought/covered/got" or "paid by
me/myself" → sender; "paid by P" or "P paid/…" (P 1–3 words at the start or
after a comma) → match P; conflicts → `ambiguous`; none → `missing`.
N3 participants: "for/with everyone|everybody|all", "split (it)
between|among (us) all|everyone" → all members; "(split (it)) with L" →
{sender} ∪ L; "(split (it)) between|among L" → exactly L; L ends at the end,
`. ! ?`, `;`, or the words for, on, paid, today, yesterday, or an amount;
any unresolved person → field null with an issue per token; no cue →
`missing`. N4 description from the first of "for D" (not an everyone phrase
or a people list), "bought D", "on D" (D not a date); D ends like L and also
at with, split, between, among; missing → null; >120 → `too_long`.
N5 date: today / yesterday / "on YYYY-MM-DD" from the message date; other
date-like words (weekdays, months, tomorrow, tonight, "last night", "ago",
`\d{1,2}/\d{1,2}`) → null + `ambiguous`; else the message date. N6 notes null.

**Name matching** (active members only): M1 normalise (strip leading `@` and
trailing punctuation, lowercase); former/deleted members never match. M2
`me`, `i`, `myself` → sender; `us`, `we`, `you` → `ambiguous`. M3 exact
full display name: one → match, several → `ambiguous` (listed). M4 else the
first word of display names: one → match, several → `ambiguous`. M5 else
`unknown_name`; no prefix, fuzzy, nickname or email matching. M6 duplicates
collapse.
