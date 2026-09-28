import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ProtectedRoute from './ProtectedRoute'

const auth = vi.hoisted(() => ({ value: { session: null as unknown, isLoading: false } }))
vi.mock('./useAuth', () => ({ useAuth: () => auth.value }))

function LoginProbe() {
  const location = useLocation()
  return <p>Login page (from {(location.state as { from?: string } | null)?.from})</p>
}

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<LoginProbe />} />
        <Route path="/groups/:id" element={<ProtectedRoute><p>Private group page</p></ProtectedRoute>} />
      </Routes>
    </MemoryRouter>,
  )

beforeEach(() => {
  auth.value = { session: null, isLoading: false }
})

describe('ProtectedRoute', () => {
  it('sends a signed-out visitor to sign in, remembering where they were going', () => {
    renderAt('/groups/g1')
    expect(screen.getByText('Login page (from /groups/g1)')).toBeInTheDocument()
    expect(screen.queryByText('Private group page')).not.toBeInTheDocument()
  })

  it('shows nothing private while the session is still being restored', () => {
    auth.value = { session: null, isLoading: true }
    renderAt('/groups/g1')
    expect(screen.getByRole('status')).toHaveTextContent('Loading SplitChat...')
    expect(screen.queryByText('Private group page')).not.toBeInTheDocument()
  })

  it('renders the page for a signed-in user', () => {
    auth.value = { session: { user: { id: 'u1' } }, isLoading: false }
    renderAt('/groups/g1')
    expect(screen.getByText('Private group page')).toBeInTheDocument()
  })
})
