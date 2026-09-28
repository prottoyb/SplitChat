import { vi } from 'vitest'

type QueryResult = { data: unknown; error: unknown }
type RpcResult = { data: unknown; error: { message: string; code?: string } | null }

export type RecordedQuery = { table: string; calls: { method: string; args: unknown[] }[] }

/**
 * Minimal stand-in for the Supabase query builder. Each table resolves to the
 * result registered for it; every builder method returns the same chainable,
 * awaitable object and is recorded (method + arguments) for assertions. RPCs
 * resolve to the result registered for their name (default: no data, no
 * error).
 */
export function createSupabaseMock() {
  const tableResults = new Map<string, QueryResult>()
  const rpcResults = new Map<string, RpcResult>()
  const tableQueries: string[] = []
  const queries: RecordedQuery[] = []

  const rpc = vi.fn<
    (name: string, args: Record<string, unknown>) => Promise<RpcResult>
  >((name) =>
    Promise.resolve(rpcResults.get(name) ?? { data: null, error: null }),
  )

  const from = vi.fn((table: string) => {
    tableQueries.push(table)
    const recorded: RecordedQuery = { table, calls: [] }
    queries.push(recorded)

    const result = tableResults.get(table) ?? {
      data: [],
      error: null,
    }

    const chain: Record<string, unknown> = {}

    for (const method of [
      'select',
      'insert',
      'update',
      'eq',
      'neq',
      'in',
      'is',
      'gte',
      'lte',
      'order',
      'limit',
      'single',
      'or',
    ]) {
      chain[method] = (...args: unknown[]) => {
        recorded.calls.push({ method, args })
        return chain
      }
    }

    chain.then = (
      resolve: (value: QueryResult) => unknown,
      reject: (reason: unknown) => unknown,
    ) => Promise.resolve(result).then(resolve, reject)

    return chain
  })

  // Realtime channels: tests drive them with emit()/setStatus().
  type Handler = (payload: { new: unknown }) => void
  const channels: { name: string; filter: unknown; handlers: Handler[]; status: ((s: string) => void) | null; removed: boolean }[] = []
  const channel = vi.fn((name: string) => {
    const entry = { name, filter: null as unknown, handlers: [] as Handler[], status: null as ((s: string) => void) | null, removed: false }
    channels.push(entry)
    const api = {
      on: (_type: string, filter: unknown, handler: Handler) => {
        entry.filter ??= filter
        entry.handlers.push(handler)
        return api
      },
      subscribe: (cb: (s: string) => void) => {
        entry.status = cb
        return api
      },
      entry,
    }
    return api
  })
  const removeChannel = vi.fn((api: { entry: { removed: boolean } }) => {
    api.entry.removed = true
    return Promise.resolve('ok')
  })

  return {
    client: { from, rpc, channel, removeChannel },
    channels,
    /** Delivers a Realtime payload to every live channel whose name starts with `prefix` (all by default). */
    emit(row: unknown, prefix = '') {
      for (const c of channels) if (!c.removed && c.name.startsWith(prefix)) c.handlers.forEach((h) => h({ new: row }))
    },
    /** Reports a subscription status (e.g. SUBSCRIBED, CHANNEL_ERROR) to every live channel. */
    setStatus(status: string) {
      for (const c of channels) if (!c.removed) c.status?.(status)
    },
    rpc,
    from,
    tableQueries,
    queries,
    setTable(table: string, data: unknown, error: unknown = null) {
      tableResults.set(table, { data, error })
    },
    setRpc(
      name: string,
      data: unknown,
      error: { message: string; code?: string } | null = null,
    ) {
      rpcResults.set(name, { data, error })
    },
  }
}
