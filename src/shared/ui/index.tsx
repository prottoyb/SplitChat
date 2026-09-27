import { useState, type ReactNode } from 'react'
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

export function LoadingState({ title, message }: { title: string; message?: string }) {
  return (
    <section className={styles.stateCard} aria-busy="true">
      <div className={styles.stateIcon}>
        <span className={styles.spinner} />
      </div>
      <h2 role="status">{title}</h2>
      {message && <p>{message}</p>}
    </section>
  )
}

type StateAction = { label: string; to: string } | { label: string; onClick: () => void }

export function ErrorState({
  title,
  message,
  actions = [],
}: {
  title: string
  message: string
  actions?: StateAction[]
}) {
  return (
    <section className={styles.stateCard}>
      <div className={`${styles.stateIcon} ${styles.stateIconError}`} aria-hidden="true">
        !
      </div>
      <h2>{title}</h2>
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

  if (!open) {
    return (
      <button type="button" className={styles.dangerButton} onClick={() => setOpen(true)}>
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

  return (
    <div className={styles.confirmBox} role="group" aria-label={title}>
      <strong>{title}</strong>
      <p>{description}</p>
      <div className={styles.confirmActions}>
        <button type="button" className={styles.confirmButton} onClick={() => void confirm()} disabled={busy}>
          {busy ? busyLabel : confirmLabel}
        </button>
        <button type="button" className={styles.cancelButton} onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  )
}

