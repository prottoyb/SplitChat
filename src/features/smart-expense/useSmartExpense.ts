import { useCallback, useEffect, useRef, useState } from 'react'
import { localIsoDate } from '../../shared/domain/dates'
import type { Failure } from '../../shared/api/result'
import type { ExpenseInput } from '../expenses'
import type { ChatMessage } from '../chat'
import {
  approveCandidate,
  listCandidates,
  parseCandidate,
  proposeCandidate,
  rejectCandidate,
  updateCandidate,
  type Candidate,
} from './api/candidates'
import { deterministicInterpreter, type ExpenseInterpreter, type InterpretContext, type Member } from './domain/interpreter'
import { validateDraft } from './domain/validateDraft'
import { subscribeGroupCandidates } from './realtime/subscribeGroupCandidates'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function contextFor(message: ChatMessage, members: readonly Member[]): InterpretContext {
  return { senderId: message.senderId, messageDate: localIsoDate(new Date(message.createdAt)), members }
}

/**
 * Smart Expense for one group's chat (ADR-0012). Proposals come only from
 * the sender's client for a message it has just sent (or on request for one
 * of its own messages); the interpreter's output always passes validateDraft
 * and the server re-validates everything. Candidates for the visible
 * messages are loaded and kept live; decisions go through the RPCs.
 */
export function useSmartExpense(
  groupId: string,
  members: readonly Member[],
  interpreter: ExpenseInterpreter = deterministicInterpreter,
) {
  const [byMessage, setByMessage] = useState<ReadonlyMap<number, Candidate>>(new Map())
  // Messages whose proposals have been looked up (so "none" is known, not
  // pending). Only successful lookups add to it; a failed lookup removes the
  // ids from `requested` instead, so they are asked for again next time.
  const [checked, setChecked] = useState<ReadonlySet<number>>(new Set())
  const requested = useRef(new Set<number>())
  const membersRef = useRef(members)
  useEffect(() => {
    membersRef.current = members
  })

  const merge = useCallback((incoming: readonly Candidate[]) => {
    if (incoming.length === 0) return
    setByMessage((current) => {
      const next = new Map(current)
      for (const c of incoming) {
        const known = next.get(c.messageId)
        if (!known || c.version >= known.version) next.set(c.messageId, c)
      }
      return next
    })
  }, [])

  const load = useCallback(
    async (ids: readonly number[]) => {
      const result = await listCandidates(groupId, ids)
      if (!result.ok) {
        ids.forEach((id) => requested.current.delete(id)) // try again next time
        return
      }
      merge(result.value)
      setChecked((current) => new Set([...current, ...ids]))
    },
    [groupId, merge],
  )

  /** Loads candidates for messages not asked about yet (called as the chat shows messages). */
  const onMessagesShown = useCallback(
    (ids: readonly number[]) => {
      const missing = ids.filter((id) => !requested.current.has(id))
      if (missing.length === 0) return
      missing.forEach((id) => requested.current.add(id))
      void load(missing)
    },
    [load],
  )

  useEffect(() => {
    if (!UUID.test(groupId)) return
    return subscribeGroupCandidates(groupId, (event) => {
      if (event.type === 'status') {
        // Catch up on anything decided while the subscription was down.
        if (event.status === 'live' && requested.current.size) void load([...requested.current])
        return
      }
      const c = parseCandidate(event.row)
      if (c && c.groupId === groupId) merge([c])
      else if (requested.current.size) void load([...requested.current])
    })
  }, [groupId, merge, load])

  /** Interprets a message I have just sent and proposes a candidate when one is found. */
  const onOwnMessageConfirmed = useCallback(
    async (message: ChatMessage) => {
      const ctx = contextFor(message, membersRef.current)
      const result = validateDraft(await interpreter.interpret(message.body, ctx), ctx)
      if (result.kind !== 'candidate') return
      const proposed = await proposeCandidate(message.id, result.source, result.interpreterVersion, result.draft)
      if (proposed.ok) merge([proposed.value])
    },
    [interpreter, merge],
  )

  /** "Record as expense" on one of my own messages that has no proposal. */
  const proposeManually = useCallback(
    async (message: ChatMessage): Promise<Failure | null> => {
      const ctx = contextFor(message, membersRef.current)
      const result = await proposeCandidate(message.id, 'manual', interpreter.version, { expenseDate: ctx.messageDate })
      if (!result.ok) return result
      merge([result.value])
      return null
    },
    [interpreter, merge],
  )

  const save = useCallback(
    async (candidate: Candidate, input: ExpenseInput): Promise<Failure | null> => {
      const result = await updateCandidate(candidate, input)
      if (!result.ok) return result
      merge([result.value])
      return null
    },
    [merge],
  )

  const refresh = useCallback((candidate: Candidate) => void load([candidate.messageId]), [load])

  const reject = useCallback(
    async (candidate: Candidate): Promise<Failure | null> => {
      const result = await rejectCandidate(candidate)
      refresh(candidate)
      return result.ok ? null : result
    },
    [refresh],
  )

  const approve = useCallback(
    async (candidate: Candidate): Promise<Failure | null> => {
      const result = await approveCandidate(candidate)
      refresh(candidate)
      return result.ok ? null : result
    },
    [refresh],
  )

  return { byMessage, checked, onMessagesShown, onOwnMessageConfirmed, proposeManually, save, reject, approve, refresh }
}
