import { useState, type FormEvent } from 'react'
import { normaliseEmail } from '../domain/groupForm'
import styles from '../pages/GroupMembers.module.css'

/** Owner-only add-by-email form; reports the outcome through `onAdd`. */
export function AddMemberForm({ onAdd }: { onAdd: (email: string) => Promise<boolean> }) {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const clean = normaliseEmail(email)
    if (!clean) {
      setError('Please enter the member email address.')
      return
    }
    setError('')
    setBusy(true)
    try {
      if (await onAdd(clean)) setEmail('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className={styles.addMemberForm} onSubmit={submit} noValidate>
      <label className={styles.field}>
        <span>Email address</span>
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="friend@example.com"
          autoComplete="off"
          disabled={busy}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'add-member-error' : undefined}
        />
      </label>
      {error && (
        <p id="add-member-error" className={styles.errorMessage} role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="primary-button" disabled={busy}>
        {busy ? 'Adding member...' : '+ Add member'}
      </button>
    </form>
  )
}
