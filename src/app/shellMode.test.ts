import { describe, expect, it } from 'vitest'
import { shellMode } from './shellMode'

describe('shellMode (phone app bars)', () => {
  it.each([
    ['/groups/g1/chat', ' app-shell--chat'],
    ['/groups/g1/chat/', ' app-shell--chat'],
    ['/groups/g1/expenses/new', ' app-shell--form'],
    ['/groups/g1/proposals/c1/edit', ' app-shell--form'],
    ['/expenses/x1/edit', ' app-shell--form'],
    ['/', ''],
    ['/groups/g1', ''],
    ['/groups/g1/expenses', ''],
    ['/groups/g1/members', ''],
    ['/expenses/x1', ''],
  ])('%s → %j', (path, mode) => {
    expect(shellMode(path)).toBe(mode)
  })
})
