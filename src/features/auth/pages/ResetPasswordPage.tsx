import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { getSession, isPasswordRecovery, setNewPassword, signOut } from '../api/auth'
import { validateNewPassword } from '../domain/displayName'
import styles from '../AuthPage.module.css'

type Stage = 'checking' | 'ready' | 'invalid'

/**
 * Where a password-reset email link lands. The form is offered only for a
 * recovery session started by that link on this page load, never for an
 * ordinary signed-in session (which must confirm the current password on the
 * profile page instead). After the change the user signs in again.
 */
function ResetPasswordPage() {
  const navigate = useNavigate()
  const [stage, setStage] = useState<Stage>('checking')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    void getSession().then((session) => {
      if (!cancelled) setStage(session && isPasswordRecovery() ? 'ready' : 'invalid')
    })
    return () => {
      cancelled = true
    }
  }, [])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const problem = validateNewPassword(password, confirm)
    if (problem) {
      setError(problem)
      return
    }
    setError('')
    setSaving(true)
    const result = await setNewPassword(password)
    if (!result.ok) {
      setSaving(false)
      setError(result.message)
      return
    }
    await signOut()
    navigate('/login?reset=done', { replace: true })
  }

  return (
    <main className={`${styles.page} ${styles.singlePage}`}>
      <section className={styles.authPanel}>
        <div className={styles.authCard}>
          <div className={styles.heading}>
            <p className={styles.eyebrow}>RESET PASSWORD</p>
            <h2>Choose a new password</h2>
            <p>
              {stage === 'invalid'
                ? 'This reset link is invalid or has expired.'
                : 'Pick a password of at least 8 characters. You will then sign in with it.'}
            </p>
          </div>

          {stage === 'checking' && (
            <p className={styles.switchText} role="status">
              Checking your reset link…
            </p>
          )}

          {stage === 'invalid' && (
            <p className={styles.switchText}>
              <Link to="/login">Request a new link from the sign-in page</Link>
            </p>
          )}

          {stage === 'ready' && (
            <form className={styles.form} onSubmit={submit} noValidate>
              <label className={styles.field}>
                <span>New password</span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  disabled={saving}
                />
              </label>
              <label className={styles.field}>
                <span>Confirm new password</span>
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  disabled={saving}
                />
              </label>
              {error && (
                <div className={styles.errorMessage} role="alert">
                  {error}
                </div>
              )}
              <button className={styles.submitButton} type="submit" disabled={saving}>
                {saving ? 'Saving…' : 'Save new password'}
              </button>
            </form>
          )}
        </div>
      </section>
    </main>
  )
}

export default ResetPasswordPage
