import { vi } from 'vitest'

type QueryResult = { data: unknown; error: unknown }
type RpcResult = { data: unknown; error: { message: string } | null }

/**
 * Minimal stand-in for the Supabase query builder. Each table resolves to the
 * result registered for it; every builder method returns the same chainable,
 * awaitable object, and each `from()` call is recorded for assertions. RPCs
 * resolve to the result registered for their name (default: no data, no
 * error).
 */
export function createSupabaseMock() {
  const tableResults = new Map<string, QueryResult>()
  const rpcResults = new Map<string, RpcResult>()
  const tableQueries: string[] = []

  const rpc = vi.fn<
    (name: string, args: Record<string, unknown>) => Promise<RpcResult>
  >((name) =>
    Promise.resolve(rpcResults.get(name) ?? { data: null, error: null }),
  )

  const from = vi.fn((table: string) => {
    tableQueries.push(table)

    const result = tableResults.get(table) ?? {
      data: [],
      error: null,
    }

    const chain: Record<string, unknown> = {}

    for (const method of [
      'select',
      'eq',
      'in',
      'is',
      'order',
      'limit',
    ]) {
      chain[method] = () => chain
    }

    chain.then = (
      resolve: (value: QueryResult) => unknown,
      reject: (reason: unknown) => unknown,
    ) => Promise.resolve(result).then(resolve, reject)

    return chain
  })

  return {
    client: { from, rpc },
    rpc,
    from,
    tableQueries,
    setTable(table: string, data: unknown, error: unknown = null) {
      tableResults.set(table, { data, error })
    },
    setRpc(
      name: string,
      data: unknown,
      error: { message: string } | null = null,
    ) {
      rpcResults.set(name, { data, error })
    },
  }
}
