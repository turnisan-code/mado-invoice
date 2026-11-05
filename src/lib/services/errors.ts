import type { ApiErrorCode, LifecycleErrorCode } from '@/types'

// A refusal a service decides itself, in the API's terms: the status a route answers with and the
// code the browser (src/lib/api-errors.ts) and the Claude connector (src/lib/mcp/errors.ts) word.
// `details` carries the values the sentence names. Database failures are thrown as they came.
export class ServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | LifecycleErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ServiceError'
  }
}
