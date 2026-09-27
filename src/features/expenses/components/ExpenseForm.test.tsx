import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { ExpenseForm } from './ExpenseForm'

const people = [
  { userId: 'u1', name: 'Alice Adams', current: true },
  { userId: 'u2', name: 'Bob Brown', current: true },
]

function renderForm(notes: string, onSubmit = vi.fn()) {
  return render(
    <MemoryRouter>
      <ExpenseForm
        mode="create"
        people={people}
        currentUserId="u1"
        initial={{ description: 'Dinner', amount: '10', expenseDate: '2026-09-20', paidBy: 'u1', participantIds: ['u1', 'u2'], notes }}
        onSubmit={onSubmit}
      />
    </MemoryRouter>,
  )
}

describe('ExpenseForm accessibility', () => {
  it('describes the notes field by both its counter and its error', async () => {
    const onSubmit = vi.fn()
    renderForm('n'.repeat(501), onSubmit)

    await userEvent.setup().click(screen.getByRole('button', { name: 'Create expense' }))

    const notes = screen.getByLabelText(/Notes/)
    const ids = (notes.getAttribute('aria-describedby') ?? '').split(' ')
    expect(notes).toHaveAttribute('aria-invalid', 'true')
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toEqual([
      '501/500',
      'Notes cannot exceed 500 characters.',
    ])
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('describes the notes field by its counter alone when valid', () => {
    renderForm('fine')

    const notes = screen.getByLabelText(/Notes/)
    expect(notes).not.toHaveAttribute('aria-invalid')
    expect(document.getElementById(notes.getAttribute('aria-describedby') ?? '')?.textContent).toBe('4/500')
  })

  it('connects each field error to its field', async () => {
    render(
      <MemoryRouter>
        <ExpenseForm
          mode="create"
          people={people}
          currentUserId="u1"
          initial={{ description: '', amount: '', expenseDate: '2026-09-20', paidBy: 'u1', participantIds: ['u1'], notes: '' }}
          onSubmit={vi.fn()}
        />
      </MemoryRouter>,
    )

    await userEvent.setup().click(screen.getByRole('button', { name: 'Create expense' }))

    expect(screen.getByLabelText('Description')).toHaveAccessibleDescription('Please enter an expense description.')
    expect(screen.getByLabelText('Amount')).toHaveAccessibleDescription('Please enter an amount.')
  })
})
