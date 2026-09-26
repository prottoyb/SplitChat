import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSupabaseMock } from '../test/supabaseMock'
import GroupsPage from './GroupsPage'

const mock = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('../lib/supabase', () => ({
  get supabase() {
    return (mock.current as ReturnType<typeof createSupabaseMock>).client
  },
}))

vi.mock('../auth/useAuth', () => ({
  useAuth: () => ({ session: { user: { id: 'u1' } } }),
}))

let supabaseMock: ReturnType<typeof createSupabaseMock>

beforeEach(() => {
  supabaseMock = createSupabaseMock()
  mock.current = supabaseMock
})

describe('GroupsPage owner badge', () => {
  it('follows the membership role, not groups.created_by', async () => {
    supabaseMock.setTable('groups', [
      // u1 created "Flat" but transferred ownership; u1 owns "Trip".
      { id: 'g1', name: 'Flat', description: null, created_by: 'u1', created_at: '2026-09-01', updated_at: '2026-09-01' },
      { id: 'g2', name: 'Trip', description: null, created_by: 'u9', created_at: '2026-09-02', updated_at: '2026-09-02' },
    ])
    supabaseMock.setTable('group_members', [
      { group_id: 'g1', role: 'member' },
      { group_id: 'g2', role: 'owner' },
    ])
    render(
      <MemoryRouter>
        <GroupsPage />
      </MemoryRouter>,
    )

    const flat = (await screen.findByText('Flat')).closest('article')
    const trip = screen.getByText('Trip').closest('article')
    expect(flat).toHaveTextContent('Member')
    expect(flat).not.toHaveTextContent('Owner')
    expect(trip).toHaveTextContent('Owner')
  })
})
