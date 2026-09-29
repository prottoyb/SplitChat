import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { addDays, formatDateLong, localIsoDate } from '../../../shared/domain/dates'
import { ErrorState, LoadingState, Notice } from '../../../shared/ui'
import { nameOf } from '../../people'
import { bodyLength, MAX_BODY, type ChatMessage, type PendingMessage } from '../domain/timeline'
import { useGroupChat } from '../useGroupChat'
import styles from './GroupChat.module.css'

const TIME = new Intl.DateTimeFormat('en-AU', { hour: 'numeric', minute: '2-digit' })
const FULL = new Intl.DateTimeFormat('en-AU', { dateStyle: 'full', timeStyle: 'short' })
// A run of messages from one sender within this gap shares one name line.
const RUN_GAP_MS = 5 * 60 * 1000
const NEAR_BOTTOM_PX = 80

function dayLabel(localDay: string, today: string): string {
  if (localDay === today) return 'Today'
  if (localDay === addDays(today, -1)) return 'Yesterday'
  return formatDateLong(localDay)
}

function MessageItem({ message, mine, sender, showSender }: { message: ChatMessage; mine: boolean; sender: string; showSender: boolean }) {
  const at = new Date(message.createdAt)
  return (
    <li className={`${styles.message} ${mine ? styles.mine : ''} ${showSender ? styles.runStart : ''}`}>
      {showSender && (
        <p className={styles.meta}>
          <span className={styles.sender}>{mine ? 'You' : sender}</span>
          <time dateTime={message.createdAt} title={FULL.format(at)}>
            {TIME.format(at)}
          </time>
        </p>
      )}
      {!showSender && (
        <span className={styles.visuallyHidden}>
          {mine ? 'You' : sender}, {TIME.format(at)}:
        </span>
      )}
      <p className={styles.bubble}>{message.body}</p>
    </li>
  )
}

const preview = (body: string) => (body.length > 40 ? `${body.slice(0, 40)}…` : body)

function PendingItem({ pending, onRetry, onDiscard }: { pending: PendingMessage; onRetry: () => void; onDiscard: () => void }) {
  return (
    <li className={`${styles.message} ${styles.mine} ${styles.runStart}`}>
      <p className={`${styles.bubble} ${pending.status === 'failed' ? styles.failedBubble : styles.sendingBubble}`}>{pending.body}</p>
      {pending.status === 'sending' ? (
        <p className={styles.pendingStatus}>Sending…</p>
      ) : (
        <div className={styles.failed} role="alert">
          <span>
            <span aria-hidden="true">⚠ </span>Not sent. {pending.error}
          </span>
          <button type="button" onClick={onRetry} aria-label={`Retry sending “${preview(pending.body)}”`}>
            Retry
          </button>
          <button type="button" onClick={onDiscard} aria-label={`Discard “${preview(pending.body)}”`}>
            Discard
          </button>
        </div>
      )}
    </li>
  )
}

/**
 * Optional hooks for features layered on chat (Smart Expense, ADR-0012);
 * chat itself knows nothing about them.
 */
export type ChatExtensions = {
  /** Called once for each message I sent, when the server confirms it. */
  onOwnMessageConfirmed?: (message: ChatMessage) => void
  /** Called with the ids of the messages currently loaded. */
  onMessagesShown?: (ids: readonly number[]) => void
  /** Content shown as its own list item right after a message (never inside the bubble). */
  renderAfterMessage?: (message: ChatMessage) => ReactNode
  /** A strip above the messages (e.g. open proposals); nothing when it returns null. */
  renderBanner?: () => ReactNode
}

/**
 * A group's chat (ADR-0011): messages are plain text (never HTML), newest at
 * the bottom; "Load earlier messages" keeps the reading position; the view
 * follows new messages only when the reader is at the bottom or has just
 * sent one. Chat messages are conversation, not financial records.
 */
export function GroupChat({ groupId, userId, extensions = {} }: { groupId: string; userId: string; extensions?: ChatExtensions }) {
  const chat = useGroupChat(groupId, userId, extensions.onOwnMessageConfirmed)
  const { timeline } = chat
  const [draft, setDraft] = useState('')
  const [draftError, setDraftError] = useState('')
  const [unseen, setUnseen] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const followNext = useRef(true)
  const olderAnchor = useRef<number | null>(null)
  const lastCount = useRef(0)
  const lastEpoch = useRef(0)

  const itemCount = timeline.messages.length + timeline.pending.length
  const { onMessagesShown, renderAfterMessage, renderBanner } = extensions
  useEffect(() => {
    if (timeline.messages.length) onMessagesShown?.(timeline.messages.map((m) => m.id))
  }, [timeline.messages, onMessagesShown])
  const section = useRef<HTMLElement>(null)
  const ready = chat.load.status === 'ready'

  // On narrow screens bring the whole chat (list + composer) into view once.
  useEffect(() => {
    if (!ready || typeof window.matchMedia !== 'function' || !window.matchMedia('(max-width: 720px)').matches) return
    section.current?.scrollIntoView?.({ block: 'start' })
  }, [ready])

  // Keep the reading position: after older messages are prepended, hold the
  // same content in view; after new ones, follow only if at the bottom.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    if (timeline.epoch !== lastEpoch.current) {
      // The list was replaced after a long disconnect: show the latest.
      lastEpoch.current = timeline.epoch
      olderAnchor.current = null
      el.scrollTop = el.scrollHeight
      setUnseen(false)
    } else if (olderAnchor.current !== null) {
      el.scrollTop = el.scrollHeight - olderAnchor.current
      olderAnchor.current = null
    } else if (itemCount > lastCount.current) {
      if (followNext.current || atBottom.current) {
        el.scrollTop = el.scrollHeight
        setUnseen(false)
      } else {
        setUnseen(true)
      }
    }
    followNext.current = false
    lastCount.current = itemCount
  }, [itemCount, chat.load.status, timeline.epoch])

  // Content can grow without new messages (e.g. an extension's card loads
  // under a message): a reader at the bottom stays at the bottom.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && atBottom.current && olderAnchor.current === null && el.scrollHeight - el.scrollTop - el.clientHeight > 1) {
      el.scrollTop = el.scrollHeight
    }
  })

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
    if (atBottom.current) setUnseen(false)
  }

  const jumpToLatest = () => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
    setUnseen(false)
  }

  const loadOlder = () => {
    const el = scroller.current
    olderAnchor.current = el ? el.scrollHeight - el.scrollTop : null
    void chat.loadOlder()
  }

  const submit = (event?: FormEvent) => {
    event?.preventDefault()
    const error = chat.send(draft)
    if (error) return setDraftError(error)
    setDraft('')
    setDraftError('')
    followNext.current = true
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends on devices with a keyboard; Shift+Enter adds a line. Touch
    // keyboards keep Enter for new lines and use the Send button.
    const finePointer = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: fine)').matches
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && finePointer) {
      event.preventDefault()
      submit()
    }
  }

  if (chat.load.status === 'loading') return <LoadingState title="Loading messages..." />
  if (chat.load.status === 'error') {
    return <ErrorState title="Chat unavailable" message={chat.load.message} actions={[{ label: 'Try again', onClick: chat.reload }]} />
  }

  const today = localIsoDate()
  const length = bodyLength(draft)
  let previous: ChatMessage | null = null
  let previousDay = ''
  const items: ReactNode[] = []
  for (const message of timeline.messages) {
    const day = localIsoDate(new Date(message.createdAt))
    if (day !== previousDay) {
      items.push(
        <li key={`day-${day}`} className={styles.day} aria-hidden="true">
          <span>{dayLabel(day, today)}</span>
        </li>,
      )
      previous = null
      previousDay = day
    }
    const showSender =
      !previous ||
      previous.senderId !== message.senderId ||
      new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() > RUN_GAP_MS
    items.push(
      <MessageItem
        key={message.id}
        message={message}
        mine={message.senderId === userId}
        sender={nameOf(chat.names, message.senderId)}
        showSender={showSender}
      />,
    )
    previous = message
    const extra = renderAfterMessage?.(message)
    if (extra) {
      items.push(
        <li key={`extra-${message.id}`} className={`${styles.extra} ${message.senderId === userId ? styles.extraMine : ''}`}>
          {extra}
        </li>,
      )
      previous = null // the next message starts a new run
    }
  }

  return (
    <section className={styles.chat} aria-label="Group chat" ref={section}>
      <div className={styles.top}>
        {timeline.live === 'paused' && (
          <p className={styles.liveNotice} role="status">
            Live updates paused — reconnecting. You can still send messages.
          </p>
        )}
        {renderBanner?.()}
      </div>

      <div className={styles.scroller} ref={scroller} onScroll={onScroll}>
        {timeline.hasOlder && (
          <div className={styles.older}>
            <button type="button" onClick={loadOlder} disabled={chat.loadingOlder}>
              {chat.loadingOlder ? 'Loading…' : 'Load earlier messages'}
            </button>
            {chat.olderError && <p role="alert">{chat.olderError}</p>}
          </div>
        )}
        {itemCount === 0 ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>No messages yet</p>
            <p>Talk about plans and shared costs here. Messages are visible to everyone in the group.</p>
          </div>
        ) : (
          <ol className={styles.log} role="log" aria-label="Messages">
            {items}
            {timeline.pending.map((p) => (
              <PendingItem
                key={p.clientRequestId}
                pending={p}
                onRetry={() => chat.retry(p.clientRequestId)}
                onDiscard={() => chat.discard(p.clientRequestId)}
              />
            ))}
          </ol>
        )}
      </div>

      {unseen && (
        <button type="button" className={styles.jump} onClick={jumpToLatest}>
          New messages ↓
        </button>
      )}

      {chat.removed ? (
        <div className={styles.removedNotice}>
          <Notice tone="info">You are no longer a member of this group, so you cannot send messages here.</Notice>
        </div>
      ) : (
        <form className={styles.composer} onSubmit={submit}>
          <label htmlFor={`chat-input-${groupId}`} className={styles.visuallyHidden}>
            Message
          </label>
          <textarea
            id={`chat-input-${groupId}`}
            value={draft}
            rows={2}
            placeholder="Write a message…"
            aria-invalid={draftError ? true : undefined}
            aria-describedby={draftError || length > MAX_BODY - 200 ? `chat-hint-${groupId}` : undefined}
            onChange={(e) => {
              setDraft(e.target.value)
              if (draftError) setDraftError('')
            }}
            onKeyDown={onKeyDown}
          />
          <button type="submit" className="primary-button">
            Send
          </button>
          {(draftError || length > MAX_BODY - 200) && (
            <p id={`chat-hint-${groupId}`} className={draftError ? styles.error : styles.counter}>
              {draftError || `${length.toLocaleString('en-AU')} / ${MAX_BODY.toLocaleString('en-AU')} characters`}
            </p>
          )}
        </form>
      )}
    </section>
  )
}
