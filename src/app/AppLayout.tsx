import { Suspense, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { signOut, useAuth } from '../features/auth'
import { LoadingState, Menu } from '../shared/ui'
import { shellMode } from './shellMode'


function AppLayout() {
  const navigate = useNavigate()
  const { session, profile } = useAuth()

  const [isSigningOut, setIsSigningOut] = useState(false)
  const { pathname } = useLocation()

  const user = session?.user

  const metadataName =
    typeof user?.user_metadata?.full_name === 'string'
      ? user.user_metadata.full_name.trim()
      : ''

  const profileName = profile?.full_name.trim() ?? ''

  const displayName =
    profileName ||
    metadataName ||
    user?.email?.split('@')[0] ||
    'SplitChat user'

  const initials =
    displayName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join('') || 'SC'

  const handleSignOut = async () => {
    setIsSigningOut(true)
    const result = await signOut()
    if (!result.ok) {
      setIsSigningOut(false)
      return
    }
    navigate('/login', { replace: true })
  }

  return (
    <div className={`app-shell${shellMode(pathname)}`}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">S</div>

          <div>
            <h1>SplitChat</h1>
            <p>Shared expenses, simplified.</p>
          </div>

          <div className="mobile-account">
            <Menu
              label={`Account: ${displayName}`}
              trigger={<span className="profile-avatar" aria-hidden="true">{initials}</span>}
              triggerClassName="account-trigger"
              items={[
                { key: 'profile', label: 'Profile', to: '/profile' },
                {
                  key: 'sign-out',
                  label: isSigningOut ? 'Signing out...' : 'Sign out',
                  onClick: handleSignOut,
                  disabled: isSigningOut,
                },
              ]}
            />
          </div>
        </div>

        <nav className="navigation" aria-label="Main">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              `nav-item${isActive ? ' active' : ''}`
            }
          >
            <span aria-hidden="true">⌂</span>
            Dashboard
          </NavLink>

          <NavLink
            to="/groups"
            className={({ isActive }) =>
              `nav-item${isActive ? ' active' : ''}`
            }
          >
            <span aria-hidden="true">◎</span>
            Groups
          </NavLink>

          <NavLink
            to="/expenses"
            className={({ isActive }) =>
              `nav-item${isActive ? ' active' : ''}`
            }
          >
            <span aria-hidden="true">↔</span>
            Expenses
          </NavLink>

          <NavLink
            to="/activity"
            className={({ isActive }) =>
              `nav-item${isActive ? ' active' : ''}`
            }
          >
            <span aria-hidden="true">◌</span>
            Activity
          </NavLink>
        </nav>

        <div className="sidebar-footer">
          <div className="profile-avatar">{initials}</div>

          <div className="profile-details">
            <NavLink to="/profile" className="profile-link">
              {displayName}
            </NavLink>

            <button
              type="button"
              className="text-button"
              onClick={handleSignOut}
              disabled={isSigningOut}
            >
              {isSigningOut ? 'Signing out...' : 'Sign out'}
            </button>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <Suspense fallback={<LoadingState title="Loading..." />}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  )
}

export default AppLayout