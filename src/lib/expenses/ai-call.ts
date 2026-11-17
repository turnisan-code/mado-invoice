import type Anthropic from '@anthropic-ai/sdk'

// What a caller with a deadline gives one AI call (PR „Job 1 fixes“ § 3.2): how long one
// request may take, how often the SDK may send it again, and the signal that aborts it.
// The SDK sends a request that timed out again, so one call can take timeoutMs ×
// (maxRetries + 1), plus the pauses between; an aborted call is never sent again.
export type AiCallOptions = { timeoutMs?: number; maxRetries?: number; signal?: AbortSignal }

// The SDK's request options for them, only those given: the SDK refuses `timeout:
// undefined` („timeout must be an integer“), and with a negative or fractional maxRetries
// it would send a failing request again without end. The timeout in whole milliseconds, at
// least 1; anything that is no finite number counts as not given. None given: none, so the
// call is the one made before (the client's 10 minutes and 2 retries).
export function aiRequestOptions(opts: AiCallOptions = {}): Anthropic.RequestOptions | undefined {
  const options: Anthropic.RequestOptions = {}
  if (opts.timeoutMs != null && Number.isFinite(opts.timeoutMs)) options.timeout = Math.max(1, Math.round(opts.timeoutMs))
  if (opts.maxRetries != null && Number.isFinite(opts.maxRetries)) options.maxRetries = Math.max(0, Math.floor(opts.maxRetries))
  if (opts.signal) options.signal = opts.signal
  return Object.keys(options).length ? options : undefined
}

// An AI call as long as `signal` lets it run: it settles with the call, or rejects at once
// with an AbortError when the signal aborts. The SDK waits out a rate limit's retry-after
// (uncapped) before it looks at the signal again, so an aborted call could outlast Analyse's
// deadline by the server's wait. The listener goes once the call settles. No signal: the call.
export function untilAborted<T>(call: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return Promise.resolve(call)
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error('Request was aborted.'), { name: 'AbortError' }))
    Promise.resolve(call).then(
      value => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

// The SDK call the readers and the classifiers make: their client's `messages`. Tests pass
// a stand-in, so nothing reaches the network. What they read of the answer: how it ended
// and its content.
export type AiMessages = {
  create(
    body: Anthropic.MessageCreateParamsNonStreaming,
    options?: Anthropic.RequestOptions,
  ): PromiseLike<Pick<Anthropic.Message, 'stop_reason' | 'content'>>
}
