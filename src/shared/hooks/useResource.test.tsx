import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { fail, ok, type Result } from '../api/result'
import { useResource } from './useResource'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe('useResource', () => {
  it('loads, then exposes the data', async () => {
    const { result } = renderHook(() => useResource('a', async () => ok('A')))

    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.data).toBe('A')
  })

  it('exposes a failure with its code', async () => {
    const { result } = renderHook(() => useResource('a', async () => fail('not_found', 'Gone.')))

    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.error).toEqual(fail('not_found', 'Gone.'))
  })

  it('shows loading immediately for a new key, never the previous key\'s data', async () => {
    const loads: Record<string, ReturnType<typeof deferred<Result<string>>>> = { a: deferred(), b: deferred() }
    const { result, rerender } = renderHook(({ k }) => useResource(k, () => loads[k].promise), {
      initialProps: { k: 'a' },
    })

    await act(async () => loads.a.resolve(ok('A')))
    expect(result.current.data).toBe('A')

    rerender({ k: 'b' })
    expect(result.current.status).toBe('loading')
    expect(result.current.data).toBeNull()

    await act(async () => loads.b.resolve(ok('B')))
    expect(result.current.data).toBe('B')
  })

  it('ignores a late response for a key that is no longer current', async () => {
    const loads: Record<string, ReturnType<typeof deferred<Result<string>>>> = { a: deferred(), b: deferred() }
    const { result, rerender } = renderHook(({ k }) => useResource(k, () => loads[k].promise), {
      initialProps: { k: 'a' },
    })

    rerender({ k: 'b' })
    await act(async () => loads.b.resolve(ok('B')))
    await act(async () => loads.a.resolve(ok('A (late)')))

    expect(result.current.data).toBe('B')
  })

  it('ignores a response that arrives after unmount', async () => {
    const load = deferred<Result<string>>()
    const { unmount } = renderHook(() => useResource('a', () => load.promise))

    unmount()
    await act(async () => load.resolve(ok('A')))
    // No state update on an unmounted component: nothing to assert beyond not throwing.
  })

  it('reload keeps the data visible and flags refreshing', async () => {
    let value = 'v1'
    let next = deferred<Result<string>>()
    const { result } = renderHook(() => useResource('a', () => (value === 'v1' ? Promise.resolve(ok(value)) : next.promise)))

    await waitFor(() => expect(result.current.data).toBe('v1'))
    value = 'v2'
    act(() => result.current.reload())

    expect(result.current.data).toBe('v1')
    expect(result.current.refreshing).toBe(true)

    await act(async () => next.resolve(ok('v2')))
    expect(result.current.data).toBe('v2')
    expect(result.current.refreshing).toBe(false)
    next = deferred()
  })

  it('setData updates loaded data', async () => {
    const { result } = renderHook(() => useResource('a', async () => ok([1, 2])))

    await waitFor(() => expect(result.current.status).toBe('ready'))
    act(() => result.current.setData((xs) => [...xs, 3]))

    expect(result.current.data).toEqual([1, 2, 3])
  })

  it('stays loading while the key is null', () => {
    let calls = 0
    const { result } = renderHook(() => useResource(null, async () => { calls += 1; return ok(1) }))

    expect(result.current.status).toBe('loading')
    expect(calls).toBe(0)
  })

  it('turns a rejected loader into a generic error', async () => {
    const { result } = renderHook(() => useResource('a', () => Promise.reject(new Error('boom'))))

    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.error?.message).not.toMatch(/boom/)
  })
})
