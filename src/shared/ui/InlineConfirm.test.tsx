import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { InlineConfirm } from '.'

const renderConfirm = (onConfirm = vi.fn(() => Promise.resolve())) => {
  render(
    <InlineConfirm
      triggerLabel="Delete expense"
      title="Delete this expense?"
      description="This cannot be undone."
      confirmLabel="Yes, delete"
      busyLabel="Deleting..."
      onConfirm={onConfirm}
    />,
  )
  return onConfirm
}

describe('InlineConfirm (keyboard)', () => {
  it('moves focus to the safe choice when it opens', async () => {
    const user = userEvent.setup()
    renderConfirm()
    await user.click(screen.getByRole('button', { name: 'Delete expense' }))
    expect(screen.getByRole('group', { name: 'Delete this expense?' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
  })

  it('cancels with Escape and returns focus to the trigger, doing nothing', async () => {
    const user = userEvent.setup()
    const onConfirm = renderConfirm()
    await user.click(screen.getByRole('button', { name: 'Delete expense' }))
    await user.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: 'Delete expense' })).toHaveFocus()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('never confirms from Enter on the trigger alone', async () => {
    const user = userEvent.setup()
    const onConfirm = renderConfirm()
    screen.getByRole('button', { name: 'Delete expense' }).focus()
    await user.keyboard('{Enter}')
    await user.keyboard('{Enter}') // lands on Cancel, not on "Yes, delete"
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
