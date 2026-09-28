import { useState, type FormEvent } from 'react'
import { formatTimestamp } from '../../../shared/domain/dates'
import { Notice, SectionHeader } from '../../../shared/ui'
import {
  MAX_GROUP_DESCRIPTION,
  updateGroupDetails,
  validateGroupInput,
  type GroupDetail,
} from '../../../features/groups'
import styles from '../GroupWorkspace.module.css'

type Feedback = { tone: 'success' | 'error'; text: string; stale?: boolean }

/** The owner's form: name and description, saved through the M24 RPC. */
function DetailsForm({
  group,
  onSaved,
  onFeedback,
}: {
  group: GroupDetail
  onSaved: () => void
  onFeedback: (feedback: Feedback | null) => void
}) {
  const [name, setName] = useState(group.name)
  const [description, setDescription] = useState(group.description ?? '')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const unchanged = name.trim() === group.name && (description.trim() || null) === (group.description ?? null)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    onFeedback(null)
    const input = validateGroupInput(name, description)
    if (!input.ok) {
      setError(input.error)
      return
    }
    setError('')
    setSaving(true)
    const result = await updateGroupDetails(group.id, input.value, group.updatedAt)
    setSaving(false)
    if (!result.ok) {
      onFeedback({ tone: 'error', text: result.message, stale: result.code === 'stale' })
      return
    }
    onFeedback({ tone: 'success', text: 'Group details saved.' })
    onSaved()
  }

  return (
    <form className={styles.settingsForm} onSubmit={submit} aria-label="Group details" noValidate>
      <div className={styles.settingsField}>
        <label htmlFor="group-name">Name</label>
        <input
          id="group-name"
          value={name}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'group-name-error' : undefined}
          onChange={(e) => {
            setName(e.target.value)
            if (error) setError('')
          }}
        />
        {error && (
          <p id="group-name-error" className={styles.fieldError}>
            {error}
          </p>
        )}
      </div>
      <div className={styles.settingsField}>
        <label htmlFor="group-description">
          Description <span className={styles.optional}>Optional</span>
        </label>
        <textarea
          id="group-description"
          rows={3}
          value={description}
          aria-describedby="group-description-count"
          onChange={(e) => setDescription(e.target.value)}
        />
        <p id="group-description-count" className={styles.counter}>
          {description.trim().length}/{MAX_GROUP_DESCRIPTION}
        </p>
      </div>
      <div>
        <button type="submit" className="primary-button" disabled={saving || unchanged}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  )
}

/**
 * The group's details, reached from the group menu. The owner edits the name
 * and description (operator decision D4, Phase 9); members see them read-only.
 */
export function SettingsSection({ group, onSaved }: { group: GroupDetail; onSaved: () => void }) {
  const owner = group.members.find((m) => m.role === 'owner')
  const isOwner = group.myRole === 'owner'
  // Kept here: the form remounts after a save (new version) and must not take it along.
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const reload = () => {
    setFeedback(null)
    onSaved()
  }
  return (
    <>
      <SectionHeader
        title="Group settings"
        description={isOwner ? 'Rename the group or change its description. Everyone in the group sees the change.' : 'Only the group owner can change these.'}
      />
      {feedback && (
        <Notice
          tone={feedback.tone}
          action={
            feedback.stale ? (
              <button type="button" className="secondary-button" onClick={reload}>
                Reload
              </button>
            ) : undefined
          }
        >
          {feedback.text}
        </Notice>
      )}
      <section className={`panel ${styles.compactPanel}`}>
        {isOwner ? (
          // Keyed on the version so a reload after a save or conflict resets the form.
          <DetailsForm key={group.updatedAt} group={group} onSaved={onSaved} onFeedback={setFeedback} />
        ) : (
          <dl className={styles.details}>
            <div>
              <dt>Name</dt>
              <dd>{group.name}</dd>
            </div>
            <div>
              <dt>Description</dt>
              <dd>{group.description?.trim() || <span className={styles.muted}>No description</span>}</dd>
            </div>
          </dl>
        )}
        <dl className={`${styles.details} ${styles.detailsMeta}`}>
          <div>
            <dt>Owner</dt>
            <dd>{owner ? owner.fullName : <span className={styles.muted}>No active owner</span>}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{formatTimestamp(group.createdAt)}</dd>
          </div>
        </dl>
      </section>
    </>
  )
}
