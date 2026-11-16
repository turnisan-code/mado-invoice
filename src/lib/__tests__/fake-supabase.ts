// A stand-in for the Supabase query builder, for tests: every chain (from().select().eq()…,
// update().eq().or().select(), insert(), maybeSingle()) is recorded as one `Op` when awaited, and
// `answer` decides what it returns. Only what the code under test calls is supported.
import type { SupabaseClient } from '@supabase/supabase-js'

export type Op = {
  table: string
  action: 'select' | 'insert' | 'update' | 'delete'
  columns?: string
  values?: unknown
  returning?: string
  filters: [string, ...unknown[]][]
  single?: 'maybe' | 'single'
}

export type Answer = { data?: unknown; error?: { message: string; code?: string } | null }

export function fakeSupabase(answer: (op: Op) => Answer | undefined) {
  const ops: Op[] = []
  const from = (table: string) => {
    const op: Op = { table, action: 'select', filters: [] }
    const filter = (name: string) => (...args: unknown[]) => { op.filters.push([name, ...args]); return builder }
    const builder: Record<string, unknown> = {
      select(columns?: string) {
        if (op.action === 'select') op.columns = columns
        else op.returning = columns ?? '*'
        return builder
      },
      insert(values: unknown) { op.action = 'insert'; op.values = values; return builder },
      update(values: unknown) { op.action = 'update'; op.values = values; return builder },
      delete() { op.action = 'delete'; return builder },
      eq: filter('eq'), neq: filter('neq'), in: filter('in'), is: filter('is'), or: filter('or'), not: filter('not'),
      gte: filter('gte'), lte: filter('lte'), order: filter('order'), limit: filter('limit'),
      maybeSingle() { op.single = 'maybe'; return builder },
      single() { op.single = 'single'; return builder },
      then(resolve: (v: Answer) => unknown, reject: (e: unknown) => unknown) {
        ops.push(op)
        return Promise.resolve().then(() => answer(op) ?? { data: null, error: null }).then(r => ({ data: null, error: null, ...r })).then(resolve, reject)
      },
    }
    return builder
  }
  return { client: { from } as unknown as SupabaseClient, ops }
}

// Whether an op has the filter `name` on `column` (with `value`, when given).
export const hasFilter = (op: Op, name: string, column: string, value?: unknown) =>
  op.filters.some(f => f[0] === name && f[1] === column && (value === undefined || f[2] === value))
