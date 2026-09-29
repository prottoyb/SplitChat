import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Notice } from '../../../shared/ui'
import { changePassword, signOut, updateDisplayName } from '../api/auth'
import { MAX_DISPLAY_NAME, validateDisplayName, validateNewPassword } from '../domain/displayName'
import { useAuth } from '../useAuth'
import styles from './ProfilePage.module.css'

type Feedback = { tone: 'success' | 'error'; text: string } | null

function NameForm({ userId, current, onSaved }: { userId: string; current: string; onSaved: () => void }) {
  const [name, setName] = useState(current)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState<Feedback>(null)
  const [saving, setSaving] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFeedback(null)
    const valid = validateDisplayName(name)
    if (!valid.ok) {
      setError(valid.error)
      return
    }
    setError('')
    setSaving(true)
    const result = await updateDisplayName(userId, valid.value)
    setSaving(false)
    if (!result.ok) {
      setFeedback({ tone: 'error', text: result.message })
      return
    }
    setName(valid.value)
    setFeedback({ tone: 'success', text: 'Your name has been updated. Your groups see the new name.' })
    onSaved()
  }

  return (
    <form className={styles.form} onSubmit={submit} aria-label="Profile details" noValidate>
      {feedback && <Notice tone={feedback.tone}>{feedback.text}</Notice>}
      <div className={styles.field}>
        <label htmlFor="profile-name">Display name</label>
        <input
          id="profile-name"
          value={name}
          autoComplete="name"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'profile-name-error' : 'profile-name-hint'}
          onChange={(e) => {
            setName(e.target.value)
            if (error) setError('')
          }}
        />
        {error ? (
          <p id="profile-name-error" className={styles.fieldError}>
            {error}
          </p>
        ) : (
          <p id="profile-name-hint" className={styles.hint}>
            Shown to the people in your groups. Up to {MAX_DISPLAY_NAME} characters.
          </p>
        )}
      </div>
      <div>
        <button type="submit" className="primary-button" disabled={saving || name.trim() === current}>
          {saving ? 'Saving…' : 'Save name'}
        </button>
      </div>
    </form>
  )
}

function PasswordForm({ email }: { email: string }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [feedback, setFeedback] = useState<Feedback>(null)
  const [saving, setSaving] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFeedback(null)
    if (!current) {
      setFeedback({ tone: 'error', text: 'Please enter your current password.' })
      return
    }
    const problem = validateNewPassword(next, confirm)
    if (problem) {
      setFeedback({ tone: 'error', text: problem })
      return
    }
    setSaving(true)
    const result = await changePassword(email, current, next)
    setSaving(false)
    if (!result.ok) {
      setFeedback({ tone: 'error', text: result.message })
      return
    }
    setCurrent('')
    setNext('')
    setConfirm('')
    setFeedback({ tone: 'success', text: 'Your password has been changed.' })
  }

  return (
    <form className={styles.form} onSubmit={submit} aria-label="Change password" noValidate>
      {feedback && <Notice tone={feedback.tone}>{feedback.text}</Notice>}
      <div className={styles.field}>
        <label htmlFor="password-current">Current password</label>
        <input
          id="password-current"
          type="password"
          value={current}
          autoComplete="current-password"
          onChange={(e) => setCurrent(e.target.value)}
        />
      </div>
      <div className={styles.pair}>
        <div className={styles.field}>
          <label htmlFor="password-new">New password</label>
          <input id="password-new" type="password" value={next} autoComplete="new-password" onChange={(e) => setNext(e.target.value)} />
        </div>
        <div className={styles.field}>
          <label htmlFor="password-confirm">Confirm new password</label>
          <input
            id="password-confirm"
            type="password"
            value={confirm}
            autoComplete="new-password"
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>
      </div>
      <div>
        <button type="submit" className="secondary-button" disabled={saving}>
          {saving ? 'Changing…' : 'Change password'}
        </button>
      </div>
    </form>
  )
}

/** The signed-in user's account: display name, email, password, sign out (D3; no account deletion). */
function ProfilePage() {
  const navigate = useNavigate()
  const { session, profile, isProfileLoading, refreshProfile } = useAuth()
  const [signingOut, setSigningOut] = useState(false)
  const user = session?.user
  if (!user) return null

  const handleSignOut = async () => {
    setSigningOut(true)
    const result = await signOut()
    if (!result.ok) {
      setSigningOut(false)
      return
    }
    navigate('/login', { replace: true })
  }

  return (
    <>
      <header className="topbar">
        <div>
          <p className="eyebrow">ACCOUNT</p>
          <h2>Your profile</h2>
          <p className="subtitle">How you appear to your groups, and how you sign in.</p>
        </div>
      </header>

      <div className={styles.grid}>
        <section className={`panel ${styles.fit}`} aria-labelledby="profile-heading">
          <h3 id="profile-heading" className={styles.heading}>
            Profile
          </h3>
          {isProfileLoading ? (
            <p className={styles.hint} role="status">
              Loading your profile…
            </p>
          ) : (
            <NameForm key={profile?.full_name ?? ''} userId={user.id} current={profile?.full_name ?? ''} onSaved={refreshProfile} />
          )}
        </section>

        <section className={`panel ${styles.fit}`} aria-labelledby="signin-heading">
          <h3 id="signin-heading" className={styles.heading}>
            Sign-in
          </h3>
          <dl className={styles.details}>
            <div>
              <dt>Email</dt>
              <dd>{user.email}</dd>
            </div>
          </dl>
          <PasswordForm email={user.email ?? ''} />
          <div className={styles.signOut}>
            <button type="button" className="secondary-button" onClick={handleSignOut} disabled={signingOut}>
              {signingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </section>
      </div>
    </>
  )
}

export default ProfilePage
