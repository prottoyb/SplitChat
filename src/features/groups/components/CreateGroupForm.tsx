import { useState, type FormEvent } from 'react'
import { MAX_GROUP_DESCRIPTION, MAX_GROUP_NAME, validateGroupInput, type GroupInput } from '../domain/groupForm'
import styles from '../pages/GroupsPage.module.css'

export function CreateGroupForm({
  onCreate,
  onClose,
}: {
  onCreate: (input: GroupInput) => Promise<string | null>
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const validation = validateGroupInput(name, description)
    if (!validation.ok) {
      setError(validation.error)
      return
    }
    setError('')
    setBusy(true)
    const failure = await onCreate(validation.value)
    setBusy(false)
    if (failure) setError(failure)
  }

  return (
    <section className={styles.createPanel} aria-labelledby="create-group-title">
      <div className={styles.createHeader}>
        <div>
          <p className="eyebrow">NEW GROUP</p>
          <h3 id="create-group-title">Create a group</h3>
          <p>Give the group a clear name and an optional description.</p>
        </div>
        <button
          type="button"
          className={styles.closeButton}
          onClick={onClose}
          disabled={busy}
          aria-label="Close create group form"
        >
          ×
        </button>
      </div>

      <form className={styles.createForm} onSubmit={submit} noValidate>
        <div className={styles.field}>
          <label htmlFor="group-name">
            <span>Group name</span>
          </label>
          <input
            id="group-name"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Bali Trip 2026"
            maxLength={MAX_GROUP_NAME}
            disabled={busy}
            required
            autoFocus
            aria-describedby="group-name-count"
          />
          <small id="group-name-count">
            {name.length}/{MAX_GROUP_NAME}
          </small>
        </div>

        <div className={styles.field}>
          <label htmlFor="group-description">
            <span>Description</span>
          </label>
          <textarea
            id="group-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Optional — what is this group for?"
            maxLength={MAX_GROUP_DESCRIPTION}
            disabled={busy}
            aria-describedby="group-description-count"
          />
          <small id="group-description-count">
            {description.length}/{MAX_GROUP_DESCRIPTION}
          </small>
        </div>

        {error && (
          <div className={styles.errorMessage} role="alert">
            {error}
          </div>
        )}

        <div className={styles.formActions}>
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? 'Creating...' : 'Create group'}
          </button>
        </div>
      </form>
    </section>
  )
}
