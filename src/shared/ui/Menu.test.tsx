import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { Menu } from '.'

function renderMenu(onLeave = vi.fn()) {
  render(
    <MemoryRouter initialEntries={['/']}>
      <button type="button">Before</button>
      <Menu
        label="Group options"
        trigger="⋯"
        items={[
          { key: 'members', label: 'Members', to: '/members' },
          { key: 'activity', label: 'Activity', to: '/activity' },
          { key: 'leave', label: 'Leave', onClick: onLeave },
        ]}
      />
      <button type="button">After</button>
      <Routes>
        <Route path="/" element={<p>Home page</p>} />
        <Route path="/members" element={<p>Members page</p>} />
      </Routes>
    </MemoryRouter>,
  )
  return onLeave
}

const trigger = () => screen.getByRole('button', { name: 'Group options' })

describe('Menu', () => {
  it('is closed until opened, and says so', () => {
    renderMenu()
    expect(trigger()).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger()).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('opens on the first item with Enter and moves with arrows, Home and End (wrapping)', async () => {
    const user = userEvent.setup()
    renderMenu()
    trigger().focus()
    await user.keyboard('{Enter}')
    expect(trigger()).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('menuitem', { name: 'Members' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Activity' })).toHaveFocus()
    await user.keyboard('{End}')
    expect(screen.getByRole('menuitem', { name: 'Leave' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Members' })).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(screen.getByRole('menuitem', { name: 'Leave' })).toHaveFocus()
    await user.keyboard('{Home}')
    expect(screen.getByRole('menuitem', { name: 'Members' })).toHaveFocus()
  })

  it('opens on the last item with ArrowUp', async () => {
    const user = userEvent.setup()
    renderMenu()
    trigger().focus()
    await user.keyboard('{ArrowUp}')
    expect(screen.getByRole('menuitem', { name: 'Leave' })).toHaveFocus()
  })

  it('closes with Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup()
    renderMenu()
    await user.click(trigger())
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger()).toHaveFocus()
  })

  it('closes on Tab and on a click outside', async () => {
    const user = userEvent.setup()
    renderMenu()
    await user.click(trigger())
    await user.keyboard('{Tab}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    await user.click(trigger())
    await user.click(screen.getByText('Home page'))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('follows a link item and closes', async () => {
    const user = userEvent.setup()
    renderMenu()
    await user.click(trigger())
    await user.click(screen.getByRole('menuitem', { name: 'Members' }))
    expect(screen.getByText('Members page')).toBeInTheDocument()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('runs an action item, closes and refocuses the trigger', async () => {
    const user = userEvent.setup()
    const onLeave = renderMenu()
    await user.click(trigger())
    await user.click(screen.getByRole('menuitem', { name: 'Leave' }))
    expect(onLeave).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger()).toHaveFocus()
  })
})
