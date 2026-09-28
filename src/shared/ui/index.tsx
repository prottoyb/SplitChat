import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { initialsOf } from './initials'
import styles from './ui.module.css'

export function Avatar({ name }: { name: string }) {
  return (
    <span className={styles.avatar} aria-hidden="true">
      {initialsOf(name)}
    </span>
  )
}

/** The id a workspace focuses after section navigation. */
export const SECTION_HEADING_ID = 'section-heading'

/**
 * A section's heading row. The heading is programmatically focusable so that
 * navigating between sections moves focus (and screen readers) to it.
 */
export function SectionHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className={styles.sectionHeader}>
      <div>
        <h3 id={SECTION_HEADING_ID} tabIndex={-1}>
          {title}
        </h3>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className={styles.sectionActions}>{actions}</div>}
    </div>
  )
}

/** `compact` fits a state inside a panel (smaller, and the title is not a heading). */
export function LoadingState({ title, message, compact = false }: { title: string; message?: string; compact?: boolean }) {
  const Title = compact ? 'p' : 'h2'
  return (
    <section className={`${styles.stateCard}${compact ? ` ${styles.stateCompact}` : ''}`} aria-busy="true">
      <div className={styles.stateIcon}>
        <span className={styles.spinner} />
      </div>
      <Title className={styles.stateTitle} role="status">{title}</Title>
      {message && <p>{message}</p>}
    </section>
  )
}

type StateAction = { label: string; to: string } | { label: string; onClick: () => void }

export function ErrorState({
  title,
  message,
  actions = [],
  compact = false,
}: {
  title: string
  message: string
  actions?: StateAction[]
  compact?: boolean
}) {
  const Title = compact ? 'p' : 'h2'
  return (
    <section className={`${styles.stateCard}${compact ? ` ${styles.stateCompact}` : ''}`}>
      <div className={`${styles.stateIcon} ${styles.stateIconError}`} aria-hidden="true">
        !
      </div>
      <Title className={styles.stateTitle}>{title}</Title>
      <p role="alert">{message}</p>
      {actions.length > 0 && (
        <div className={styles.stateActions}>
          {actions.map((action) =>
            'to' in action ? (
              <Link key={action.label} to={action.to} className={styles.link}>
                {action.label}
              </Link>
            ) : (
              <button key={action.label} type="button" className={styles.button} onClick={action.onClick}>
                {action.label}
              </button>
            ),
          )}
        </div>
      )}
    </section>
  )
}

/** Success / error / info message near the content it concerns. */
export function Notice({
  tone,
  children,
  action,
}: {
  tone: 'success' | 'error' | 'info'
  children: ReactNode
  action?: ReactNode
}) {
  const toneClass = { success: styles.noticeSuccess, error: styles.noticeError, info: styles.noticeInfo }[tone]
  return (
    <div className={`${styles.notice} ${toneClass}`} role={tone === 'error' ? 'alert' : 'status'}>
      {action ? (
        <div className={styles.noticeRow}>
          <span>{children}</span>
          {action}
        </div>
      ) : (
        children
      )}
    </div>
  )
}

/**
 * A destructive action behind a two-step inline confirmation. `onConfirm`
 * resolves when done; the buttons are disabled meanwhile.
 */
export function InlineConfirm({
  triggerLabel,
  title,
  description,
  confirmLabel,
  busyLabel,
  onConfirm,
}: {
  triggerLabel: string
  title: string
  description: ReactNode
  confirmLabel: string
  busyLabel: string
  onConfirm: () => Promise<unknown>
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  // Keyboard users keep their place: opening focuses the safe choice
  // (Cancel); cancelling returns focus to the trigger.
  const cancelRef = useRef<HTMLButtonElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef(false)
  useEffect(() => {
    if (open) cancelRef.current?.focus()
    else if (returnFocus.current) {
      returnFocus.current = false
      triggerRef.current?.focus()
    }
  }, [open])

  if (!open) {
    return (
      <button type="button" ref={triggerRef} className={styles.dangerButton} onClick={() => setOpen(true)}>
        {triggerLabel}
      </button>
    )
  }

  const confirm = async () => {
    setBusy(true)
    try {
      await onConfirm()
    } finally {
      setBusy(false)
      setOpen(false)
    }
  }
  const cancel = () => {
    returnFocus.current = true
    setOpen(false)
  }

  return (
    <div
      className={styles.confirmBox}
      role="group"
      aria-label={title}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) cancel()
      }}
    >
      <strong>{title}</strong>
      <p>{description}</p>
      <div className={styles.confirmActions}>
        <button type="button" className={styles.confirmButton} onClick={() => void confirm()} disabled={busy}>
          {busy ? busyLabel : confirmLabel}
        </button>
        <button type="button" ref={cancelRef} className={styles.cancelButton} onClick={cancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  )
}
