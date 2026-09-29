import { supabase } from '../../../shared/api/supabase'
import { fail, failureFrom, guard, ok, type Result } from '../../../shared/api/result'
import { isIsoDate } from '../../../shared/domain/dates'
import { readCents } from '../../../shared/domain/money'
import type { ExpenseInput } from '../../expenses'
import type { Draft } from '../domain/interpreter'

export type CandidateStatus = 'proposed' | 'approved' | 'rejected'
export type CandidateSource = 'command' | 'natural' | 'manual'

/** A proposed expense (ADR-0012). Draft fields may be missing until approval. */
export type Candidate = {
  id: string
  groupId: string
  messageId: number
  proposedBy: string
  status: CandidateStatus
  source: CandidateSource
  interpreterVersion: string
  description: string | null
  amountCents: number | null
  expenseDate: string | null
  paidBy: string | null
  participantIds: string[] | null
  notes: string | null
  version: number
  expenseId: string | null
  decidedBy: string | null
  createdAt: string
}

const COLUMNS =
  'id, group_id, message_id, proposed_by, status, source, interpreter_version, description, amount_cents, expense_date, paid_by, participant_ids, notes, version, expense_id, decided_by, created_at'

const STATUSES: ReadonlySet<string> = new Set(['proposed', 'approved', 'rejected'])
const SOURCES: ReadonlySet<string> = new Set(['command', 'natural', 'manual'])
const str = (v: unknown) => (typeof v === 'string' ? v : null)

/** Reads a candidate row strictly (PostgREST, RPC result or Realtime payload); null if malformed. */
export function parseCandidate(row: unknown): Candidate | null {
  if (!row || typeof row !== 'object') return null
  const r = row as Record<string, unknown>
  const messageId = typeof r.message_id === 'string' && /^\d+$/.test(r.message_id) ? Number(r.message_id) : r.message_id
  const amount = r.amount_cents === null || r.amount_cents === undefined ? null : readCents(r.amount_cents)
  const participants = r.participant_ids
  if (
    typeof r.id !== 'string' || typeof r.group_id !== 'string' || typeof r.proposed_by !== 'string' ||
    typeof messageId !== 'number' || !Number.isSafeInteger(messageId) ||
    typeof r.status !== 'string' || !STATUSES.has(r.status) ||
    typeof r.source !== 'string' || !SOURCES.has(r.source) ||
    typeof r.version !== 'number' || !Number.isSafeInteger(r.version) ||
    (r.amount_cents !== null && r.amount_cents !== undefined && amount === null) ||
    (participants !== null && participants !== undefined && !(Array.isArray(participants) && participants.every((p) => typeof p === 'string'))) ||
    (r.expense_date !== null && r.expense_date !== undefined && !(typeof r.expense_date === 'string' && isIsoDate(r.expense_date)))
  ) {
    return null
  }
  return {
    id: r.id,
    groupId: r.group_id,
    messageId,
    proposedBy: r.proposed_by,
    status: r.status as CandidateStatus,
    source: r.source as CandidateSource,
    interpreterVersion: str(r.interpreter_version) ?? '',
    description: str(r.description),
    amountCents: amount,
    expenseDate: str(r.expense_date),
    paidBy: str(r.paid_by),
    participantIds: Array.isArray(participants) ? (participants as string[]) : null,
    notes: str(r.notes),
    version: r.version,
    expenseId: str(r.expense_id),
    decidedBy: str(r.decided_by),
    createdAt: str(r.created_at) ?? '',
  }
}

const UNEXPECTED = 'Expense proposals could not be read. Please try again.'

/** Candidates for the given messages of a group (RLS: active members only). */
export function listCandidates(groupId: string, messageIds: readonly number[]): Promise<Result<Candidate[]>> {
  return guard(async () => {
    if (messageIds.length === 0) return ok([])
    const result = await supabase.from('expense_candidates').select(COLUMNS).eq('group_id', groupId).in('message_id', [...messageIds])
    if (result.error) return failureFrom(result.error, 'Unable to load expense proposals.')
    const out: Candidate[] = []
    for (const row of Array.isArray(result.data) ? result.data : []) {
      const c = parseCandidate(row)
      if (!c || c.groupId !== groupId) return fail('unknown', UNEXPECTED)
      out.push(c)
    }
    return ok(out)
  }, 'Unable to load expense proposals.')
}

// Ids go into a PostgREST filter string: letters, digits and hyphens only
// (UUIDs), so no value can add a condition (commas, dots, parentheses).
const SAFE_ID = /^[A-Za-z0-9-]+$/

/**
 * Open proposals the caller can act on across their groups: their own, and
 * any in the groups they own (RLS: active members only). Newest first.
 */
export function listActionableProposals(
  userId: string,
  ownedGroupIds: readonly string[],
  { groupId, limit = 20 }: { groupId?: string; limit?: number } = {},
): Promise<Result<Candidate[]>> {
  return guard(async () => {
    if (!SAFE_ID.test(userId) || !ownedGroupIds.every((id) => SAFE_ID.test(id))) return fail('unknown', UNEXPECTED)
    const scoped = groupId === undefined ? supabase.from('expense_candidates').select(COLUMNS) : supabase.from('expense_candidates').select(COLUMNS).eq('group_id', groupId)
    const owned = new Set(ownedGroupIds)
    const filter = [`proposed_by.eq.${userId}`, ...(owned.size ? [`group_id.in.(${[...owned].join(',')})`] : [])].join(',')
    const result = await scoped
      .eq('status', 'proposed')
      .or(filter)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (result.error) return failureFrom(result.error, 'Unable to load expense proposals.')
    const out: Candidate[] = []
    for (const row of Array.isArray(result.data) ? result.data : []) {
      const c = parseCandidate(row)
      if (!c) return fail('unknown', UNEXPECTED)
      if (c.status === 'proposed' && (c.proposedBy === userId || owned.has(c.groupId)) && (groupId === undefined || c.groupId === groupId)) out.push(c)
    }
    return ok(out)
  }, 'Unable to load expense proposals.')
}

/** One candidate by id (RLS: active members of its group only). */
export function loadCandidate(id: string): Promise<Result<Candidate>> {
  return guard(async () => {
    const result = await supabase.from('expense_candidates').select(COLUMNS).eq('id', id).limit(1)
    if (result.error) return failureFrom(result.error, 'Unable to load this proposal.')
    const row = (Array.isArray(result.data) ? result.data : [])[0]
    if (!row) return fail('not_found', 'This proposal does not exist or you do not have access to it.')
    const c = parseCandidate(row)
    return c ? ok(c) : fail('unknown', UNEXPECTED)
  }, 'Unable to load this proposal.')
}

const draftArgs = (d: Partial<Draft> & { notes?: string | null }) => ({
  p_description: d.description ?? null,
  p_amount_cents: d.amountCents ?? null,
  p_expense_date: d.expenseDate ?? null,
  p_paid_by: d.paidBy ?? null,
  p_participant_ids: d.participantIds ?? null,
  p_notes: d.notes ?? null,
})

async function row(call: PromiseLike<{ data: unknown; error: { message: string } | null }>, fallback: string): Promise<Result<Candidate>> {
  const { data, error } = await call
  if (error) return failureFrom(error, fallback)
  const c = parseCandidate(data)
  return c ? ok(c) : fail('unknown', fallback)
}

/** Proposes the draft for one of my messages (idempotent per message). */
export function proposeCandidate(messageId: number, source: CandidateSource, interpreterVersion: string, draft: Partial<Draft>): Promise<Result<Candidate>> {
  return guard(
    () =>
      row(
        supabase.rpc('propose_expense_candidate', {
          p_message_id: messageId,
          p_source: source,
          p_interpreter_version: interpreterVersion,
          ...draftArgs(draft),
        }),
        'The expense proposal could not be saved.',
      ),
    'The expense proposal could not be saved.',
  )
}

/** Replaces the draft of a proposal (optimistic version check). */
export function updateCandidate(candidate: Candidate, input: ExpenseInput): Promise<Result<Candidate>> {
  return guard(
    () =>
      row(
        supabase.rpc('update_expense_candidate', {
          p_id: candidate.id,
          p_expected_version: candidate.version,
          ...draftArgs({
            description: input.description,
            amountCents: input.amountCents,
            expenseDate: input.expenseDate,
            paidBy: input.paidBy,
            participantIds: input.participantIds,
            notes: input.notes,
          }),
        }),
        'The proposal could not be saved.',
      ),
    'The proposal could not be saved.',
  )
}

export function rejectCandidate(candidate: Candidate): Promise<Result<void>> {
  return guard(async () => {
    const { error } = await supabase.rpc('reject_expense_candidate', { p_id: candidate.id, p_expected_version: candidate.version })
    if (error) return failureFrom(error, 'The proposal could not be rejected.')
    return ok(undefined)
  }, 'The proposal could not be rejected.')
}

/**
 * Approves the reviewed version: the server creates the expense through the
 * canonical path and returns its id (the same id if already approved).
 */
export function approveCandidate(candidate: Candidate): Promise<Result<string>> {
  return guard(async () => {
    const { data, error } = await supabase.rpc('approve_expense_candidate', { p_id: candidate.id, p_expected_version: candidate.version })
    if (error) return failureFrom(error, 'The expense could not be added.')
    return typeof data === 'string' ? ok(data) : fail('unknown', 'The expense could not be added.')
  }, 'The expense could not be added.')
}
