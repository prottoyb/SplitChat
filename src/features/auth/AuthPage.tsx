import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { signIn, signUp } from './api/auth'
import styles from './AuthPage.module.css'

type AuthMode = 'signin' | 'signup'

function AuthPage() {
  const navigate = useNavigate()

  const [mode, setMode] = useState<AuthMode>('signin')
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  const [isLoading, setIsLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [successMessage, setSuccessMessage] = useState('')

  const isSignUp = mode === 'signup'

  const switchMode = (nextMode: AuthMode) => {
    setMode(nextMode)
    setErrorMessage('')
    setSuccessMessage('')
    setPassword('')
    setConfirmPassword('')
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    setErrorMessage('')
    setSuccessMessage('')

    const cleanEmail = email.trim().toLowerCase()
    const cleanFullName = fullName.trim()

    if (!cleanEmail || !password) {
      setErrorMessage('Please enter your email and password.')
      return
    }

    if (isSignUp) {
      if (!cleanFullName) {
        setErrorMessage('Please enter your full name.')
        return
      }

      if (password.length < 8) {
        setErrorMessage('Your password must be at least 8 characters.')
        return
      }

      if (password !== confirmPassword) {
        setErrorMessage('Your passwords do not match.')
        return
      }
    }

    try {
      setIsLoading(true)

      if (isSignUp) {
        const result = await signUp(cleanEmail, password, cleanFullName)

        if (!result.ok) {
          setErrorMessage(result.message)
          return
        }

        if (result.value.signedIn) {
          navigate('/')
          return
        }

        // Same message whether or not the address already had an account.
        setSuccessMessage(
          'Check your email: if this address can be used, we have sent a link to confirm it before you sign in.',
        )

        setPassword('')
        setConfirmPassword('')
        return
      }

      const result = await signIn(cleanEmail, password)

      if (!result.ok) {
        setErrorMessage(result.message)
        return
      }

      navigate('/')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <main className={styles.page}>
      <section className={styles.brandPanel}>
        <div className={styles.brandContent}>
          <div className={styles.logoMark}>S</div>

          <div>
            <p className={styles.eyebrow}>SPLITCHAT</p>
            <h1>Shared expenses without the awkward maths.</h1>
          </div>

          <p className={styles.brandDescription}>
            Create groups, track shared spending and keep everyone on the same
            page.
          </p>

          <div className={styles.featureList}>
            <div className={styles.feature}>
              <span className={styles.featureNumber}>01</span>
              <div>
                <strong>Create your group</strong>
                <p>Keep trips, households and shared costs organised.</p>
              </div>
            </div>

            <div className={styles.feature}>
              <span className={styles.featureNumber}>02</span>
              <div>
                <strong>Track expenses</strong>
                <p>Know exactly who paid and what each person owes.</p>
              </div>
            </div>

            <div className={styles.feature}>
              <span className={styles.featureNumber}>03</span>
              <div>
                <strong>Settle confidently</strong>
                <p>Clear balances make repayments easier to understand.</p>
              </div>
            </div>
          </div>
        </div>

        <p className={styles.brandFooter}>Simple splitting. Clear conversations.</p>
      </section>

      <section className={styles.authPanel}>
        <div className={styles.mobileBrand}>
          <div className={styles.logoMark}>S</div>
          <span>SplitChat</span>
        </div>
        {/* Phones do not show the brand panel: one line on what SplitChat is for. */}
        <p className={styles.mobilePitch}>Split shared costs with your flatmates, trips and friends, and see who owes whom.</p>

        <div className={styles.authCard}>
          <div className={styles.heading}>
            <p className={styles.eyebrow}>
              {isSignUp ? 'GET STARTED' : 'WELCOME BACK'}
            </p>

            <h2>{isSignUp ? 'Create your account' : 'Sign in to SplitChat'}</h2>

            <p>
              {isSignUp
                ? 'Start organising shared expenses with the people that matter.'
                : 'Enter your details to continue to your dashboard.'}
            </p>
          </div>

          <div className={styles.modeSelector}>
            <button
              type="button"
              className={mode === 'signin' ? styles.activeMode : ''}
              onClick={() => switchMode('signin')}
            >
              Sign in
            </button>

            <button
              type="button"
              className={mode === 'signup' ? styles.activeMode : ''}
              onClick={() => switchMode('signup')}
            >
              Create account
            </button>
          </div>

          <form className={styles.form} onSubmit={handleSubmit}>
            {isSignUp && (
              <label className={styles.field}>
                <span>Full name</span>
                <input
                  type="text"
                  value={fullName}
                  onChange={(event) => setFullName(event.target.value)}
                  placeholder="Your full name"
                  autoComplete="name"
                  disabled={isLoading}
                />
              </label>
            )}

            <label className={styles.field}>
              <span>Email address</span>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                disabled={isLoading}
              />
            </label>

            <label className={styles.field}>
              <span>Password</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={
                  isSignUp ? 'At least 8 characters' : 'Enter your password'
                }
                autoComplete={isSignUp ? 'new-password' : 'current-password'}
                disabled={isLoading}
              />
            </label>

            {isSignUp && (
              <label className={styles.field}>
                <span>Confirm password</span>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(event) =>
                    setConfirmPassword(event.target.value)
                  }
                  placeholder="Enter your password again"
                  autoComplete="new-password"
                  disabled={isLoading}
                />
              </label>
            )}

            {errorMessage && (
              <div className={styles.errorMessage} role="alert">
                {errorMessage}
              </div>
            )}

            {successMessage && (
              <div className={styles.successMessage} role="status">
                {successMessage}
              </div>
            )}

            <button
              className={styles.submitButton}
              type="submit"
              disabled={isLoading}
            >
              {isLoading
                ? 'Please wait...'
                : isSignUp
                  ? 'Create account'
                  : 'Sign in'}
            </button>
          </form>

          <p className={styles.switchText}>
            {isSignUp ? 'Already have an account?' : 'New to SplitChat?'}

            <button
              type="button"
              onClick={() => switchMode(isSignUp ? 'signin' : 'signup')}
              disabled={isLoading}
            >
              {isSignUp ? 'Sign in' : 'Create an account'}
            </button>
          </p>
        </div>

        <p className={styles.authFooter}>
          SplitChat · Shared expenses made simple
        </p>
      </section>
    </main>
  )
}

export default AuthPage