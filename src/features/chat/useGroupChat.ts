import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { NameMap } from '../people'
import { isUuid, listMessages, namesFor, parseMessage, sendMessage } from './api/messages'
import { emptyTimeline, timelineReducer, validateBody, type ChatMessage } from './domain/timeline'
import { subscribeGroupMessages } from './realtime/subscribeGroupMessages'

type LoadState = { status: 'loading' } | { status: 'ready' } | { status: 'error'; message: string }

/**
 * One group's chat (ADR-0011): the newest page, live inserts, gap-fill after
 * every (re)subscription, coming back online or the tab becoming visible,
 * optimistic sends confirmed by id, and older pages on request. Sending never
 * depends on Realtime. Mount one per group (key the caller by group id).
 */
export function useGroupChat(groupId: string, userId: string) {
  const invalid = !isUuid(groupId) || !userId
  const reducer = useMemo(() => timelineReducer(userId), [userId])
  const [timeline, dispatch] = useReducer(reducer, emptyTimeline)
  const [load, setLoad] = useState<LoadState>({ status: 'loading' })
  const [names, setNames] = useState<NameMap>(new Map())
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [olderError, setOlderError] = useState('')
  // Sending was refused because the caller is no longer a member.
  const [removed, setRemoved] = useState(false)
  const loaded = useRef(false)
  const live = useRef(false)
  // Latest values for callbacks that must not re-subscribe when they change.
  const messagesRef = useRef<ChatMessage[]>([])
  const namesRef = useRef(names)
  useLayoutEffect(() => {
    messagesRef.current = timeline.messages
    namesRef.current = names
  })

  const addNames = useCallback((more: NameMap) => {
    if (more.size) setNames((current) => new Map([...current, ...more]))
  }, [])

  const gapFill = useCallback(async () => {
    const page = await listMessages(groupId)
    if (!page.ok) return
    addNames(page.value.names)
    dispatch({ type: 'gapFilled', messages: page.value.messages, hasOlder: page.value.hasOlder })
  }, [groupId, addNames])

  useEffect(() => {
    if (invalid) return
    let active = true
    loaded.current = false
    live.current = false

    void listMessages(groupId).then((page) => {
      if (!active) return
      if (!page.ok) return setLoad({ status: 'error', message: page.message })
      addNames(page.value.names)
      dispatch({ type: 'loaded', messages: page.value.messages, hasOlder: page.value.hasOlder })
      loaded.current = true
      setLoad({ status: 'ready' })
      // A message committed after this page was read but before the
      // subscription went live would otherwise be missed.
      if (live.current) void gapFill()
    })

    const unsubscribe = subscribeGroupMessages(groupId, (event) => {
      if (!active) return
      if (event.type === 'status') {
        live.current = event.status === 'live'
        dispatch({ type: 'status', live: event.status })
        if (event.status === 'live' && loaded.current) void gapFill()
        return
      }
      const message = parseMessage(event.row)
      if (!message || message.groupId !== groupId) {
        void gapFill() // an unreadable payload: fetch the truth instead
        return
      }
      dispatch({ type: 'received', message })
      if (!namesRef.current.has(message.senderId)) {
        void namesFor(groupId, [message]).then((r) => active && r.ok && addNames(r.value))
      }
    })

    const refill = () => {
      if (loaded.current && document.visibilityState === 'visible') void gapFill()
    }
    window.addEventListener('online', refill)
    document.addEventListener('visibilitychange', refill)
    return () => {
      active = false
      unsubscribe()
      window.removeEventListener('online', refill)
      document.removeEventListener('visibilitychange', refill)
    }
  }, [groupId, invalid, addNames, gapFill])

  const deliver = useCallback(
    async (clientRequestId: string, body: string) => {
      const result = await sendMessage(groupId, body, clientRequestId)
      if (result.ok) return dispatch({ type: 'sendConfirmed', message: result.value })
      if (result.code === 'not_found') setRemoved(true)
      dispatch({ type: 'sendFailed', clientRequestId, error: result.message })
    },
    [groupId],
  )

  /** Validates and sends; returns an error to show, or null once the send has started. */
  const send = useCallback(
    (raw: string): string | null => {
      const checked = validateBody(raw)
      if (!checked.ok) return checked.error
      const clientRequestId = crypto.randomUUID()
      dispatch({ type: 'sendStarted', clientRequestId, body: checked.body })
      void deliver(clientRequestId, checked.body)
      return null
    },
    [deliver],
  )

  /** Sends a failed message again with the same request id (never twice). */
  const retry = useCallback(
    (clientRequestId: string) => {
      const pending = timeline.pending.find((p) => p.clientRequestId === clientRequestId)
      if (!pending || pending.status !== 'failed') return
      dispatch({ type: 'retry', clientRequestId })
      void deliver(clientRequestId, pending.body)
    },
    [timeline.pending, deliver],
  )

  const discard = useCallback((clientRequestId: string) => dispatch({ type: 'discard', clientRequestId }), [])

  const loadOlder = useCallback(async () => {
    const first = messagesRef.current[0]
    if (!first || loadingOlder) return
    setLoadingOlder(true)
    setOlderError('')
    const page = await listMessages(groupId, { before: { createdAt: first.createdAt, id: first.id } })
    setLoadingOlder(false)
    if (!page.ok) return setOlderError(page.message)
    addNames(page.value.names)
    dispatch({ type: 'olderLoaded', messages: page.value.messages, hasOlder: page.value.hasOlder })
  }, [groupId, loadingOlder, addNames])

  const reload = useCallback(() => {
    setLoad({ status: 'loading' })
    void listMessages(groupId).then((page) => {
      if (!page.ok) return setLoad({ status: 'error', message: page.message })
      addNames(page.value.names)
      dispatch({ type: 'loaded', messages: page.value.messages, hasOlder: page.value.hasOlder })
      loaded.current = true
      setLoad({ status: 'ready' })
    })
  }, [groupId, addNames])

  const state: LoadState = invalid ? { status: 'error', message: 'This group does not exist or you do not have access to it.' } : load
  return { timeline, load: state, names, removed, loadingOlder, olderError, send, retry, discard, loadOlder, reload }
}
