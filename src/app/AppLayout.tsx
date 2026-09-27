import { useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useAuth } from '../features/auth/useAuth'
import { supabase } from '../shared/api/supabase'

function AppLayout() {
  const navigate = useNavigate()
  const { session, profile } = useAuth()

  const [isSigningOut, setIsSigningOut] = useState(false)

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
    try {
      setIsSigningOut(true)

      const { error } = await supabase.auth.signOut()

      if (error) {
        throw error
      }

      navigate('/login', { replace: true })
    } catch (error) {
      console.error('Unable to sign out:', error)
      setIsSigningOut(false)
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">S</div>

          <div>
            <h1>SplitChat</h1>
            <p>Shared expenses, simplified.</p>
          </div>
        </div>

        <nav className="navigation">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              `nav-item${isActive ? ' active' : ''}`
            }
          >
            <span>⌂</span>
            Dashboard
          </NavLink>

          <NavLink
            to="/groups"
            className={({ isActive }) =>
              `nav-item${isActive ? ' active' : ''}`
            }
          >
            <span>◎</span>
            Groups
          </NavLink>

          <NavLink
            to="/expenses"
            className={({ isActive }) =>
              `nav-item${isActive ? ' active' : ''}`
            }
          >
            <span>↔</span>
            Expenses
          </NavLink>

          <NavLink
            to="/activity"
            className={({ isActive }) =>
              `nav-item${isActive ? ' active' : ''}`
            }
          >
            <span>◌</span>
            Activity
          </NavLink>
        </nav>

        <div className="sidebar-footer">
          <div className="profile-avatar">{initials}</div>

          <div className="profile-details">
            <strong>{displayName}</strong>

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
        <Outlet />
      </main>
    </div>
  )
}

export default AppLayout