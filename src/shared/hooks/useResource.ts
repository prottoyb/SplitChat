import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Failure, Result } from '../api/result'

export type ResourceState<T> =
  | { status: 'loading'; data: null; error: null }
  | { status: 'ready'; data: T; error: null }
  | { status: 'error'; data: null; error: Failure }

export type Resource<T> = ResourceState<T> & {
  /** True while `reload()` re-fetches data that is already shown. */
  refreshing: boolean
  /** Re-runs the loader for the current key, keeping the current data. */
  reload: () => void
  /** Replaces the loaded data (e.g. after a successful mutation). */
  setData: (update: (current: T) => T) => void
}

type Entry<T> = { key: string; state: ResourceState<T>; refreshing: boolean }

const LOADING = { status: 'loading', data: null, error: null } as const

/**
 * Loads data for a key (usually built from route params), per ADR-0008:
 * - a new key shows `loading` at once — the previous key's data is never
 *   shown for the new key;
 * - a response that arrives after the key changed, or after unmount, is
 *   ignored;
 * - `reload()` keeps the current data and sets `refreshing`.
 * No caching across keys or components. A `null` key means "not ready to
 * load" (e.g. no session yet) and stays in `loading`.
 */
export function useResource<T>(
  key: string | null,
  load: () => Promise<Result<T>>,
): Resource<T> {
  const [entry, setEntry] = useState<Entry<T> | null>(null)
  const [generation, setGeneration] = useState(0)
  // The latest loader, without making it an effect dependency (callers pass
  // inline functions); synced before the loading effect runs.
  const loadRef = useRef(load)
  useLayoutEffect(() => {
    loadRef.current = load
  })

  useEffect(() => {
    if (key === null) return
    let active = true
    loadRef.current().then(
      (result) => {
        if (!active) return
        setEntry({
          key,
          refreshing: false,
          state: result.ok
            ? { status: 'ready', data: result.value, error: null }
            : { status: 'error', data: null, error: result },
        })
      },
      () => {
        if (!active) return
        setEntry({
          key,
          refreshing: false,
          state: {
            status: 'error',
            data: null,
            error: { ok: false, code: 'unknown', message: 'Something went wrong. Please try again.' },
          },
        })
      },
    )
    return () => {
      active = false
    }
  }, [key, generation])

  const reload = useCallback(() => {
    setEntry((current) => (current && current.key === key ? { ...current, refreshing: true } : current))
    setGeneration((g) => g + 1)
  }, [key])

  const setData = useCallback(
    (update: (current: T) => T) => {
      setEntry((current) =>
        current && current.key === key && current.state.status === 'ready'
          ? { ...current, state: { ...current.state, data: update(current.state.data) } }
          : current,
      )
    },
    [key],
  )

  const current = entry && entry.key === key ? entry : null
  return {
    ...(current ? current.state : LOADING),
    refreshing: current?.refreshing ?? false,
    reload,
    setData,
  }
}
