import './owner'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import Anthropic from '@anthropic-ai/sdk'
import { aiRequestOptions, untilAborted, type AiCallOptions } from '../ai-call'
import { readPdfInvoice, type PdfReaderMessages } from '../pdf-reader'

// The time an AI call with a deadline gets (Bookmatic's PR „Job 1 fixes“ § 3.2, ported for
// PR 9b): what lib/expenses/ai-call.ts makes of a caller's timeout, retries and signal, and what
// the SDK (@anthropic-ai/sdk 1.3) does with them — its own client, at a host that does not exist,
// on a stand-in fetch: no network.

describe('aiRequestOptions — a caller’s time for one AI call, as the SDK takes it', () => {
  test('the timeout, the retries and the signal, as given', () => {
    const signal = new AbortController().signal
    assert.deepEqual(aiRequestOptions({ timeoutMs: 20_000, maxRetries: 1, signal }), { timeout: 20_000, maxRetries: 1, signal })
    assert.deepEqual(aiRequestOptions({ timeoutMs: 30_000, maxRetries: 0 }), { timeout: 30_000, maxRetries: 0 })
  })
  test('none given: none, so the call is the one made before (the client’s 10 minutes and 2 retries)', () => {
    assert.equal(aiRequestOptions(), undefined)
    assert.equal(aiRequestOptions({}), undefined)
    assert.equal(aiRequestOptions({ timeoutMs: undefined, maxRetries: undefined, signal: undefined }), undefined)
  })
  test('only those given: no `timeout` key without a timeout', () => {
    const options = aiRequestOptions({ timeoutMs: undefined, maxRetries: 0 })
    assert.deepEqual(options, { maxRetries: 0 })
    assert.ok(options && !('timeout' in options))
  })
  test('the timeout in whole milliseconds, at least 1; the retries a whole number, at least 0; no finite number counts as not given', () => {
    assert.deepEqual(aiRequestOptions({ timeoutMs: 19_999.6, maxRetries: 1.5 }), { timeout: 20_000, maxRetries: 1 })
    assert.deepEqual(aiRequestOptions({ timeoutMs: 0, maxRetries: -1 }), { timeout: 1, maxRetries: 0 })
    assert.deepEqual(aiRequestOptions({ timeoutMs: -2_500, maxRetries: 0.5 }), { timeout: 1, maxRetries: 0 })
    assert.equal(aiRequestOptions({ timeoutMs: Number.NaN, maxRetries: Number.POSITIVE_INFINITY }), undefined)
  })
})

describe('what the SDK does with them: the bounds Analyse’s deadline counts on', () => {
  // A request as the PDF reader sends one
  const BODY: Anthropic.MessageCreateParamsNonStreaming = {
    model: 'claude-haiku-4-5-20251001', max_tokens: 512, messages: [{ role: 'user', content: 'Extract key invoice fields.' }],
  }
  // Answers with no pause before a retry (retry-after-ms 0)
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'retry-after-ms': '0' } })
  const answered = () => json(200, {
    id: 'msg_test_1', type: 'message', role: 'assistant', model: BODY.model, stop_reason: 'end_turn', stop_sequence: null,
    content: [{ type: 'text', text: '{}', citations: null }], usage: { input_tokens: 10, output_tokens: 2 },
  })
  const failed = () => json(500, { type: 'error', error: { type: 'api_error', message: 'Internal server error' } })
  // Never answered: the request ends when the SDK aborts it
  const unanswered = (init: RequestInit) => new Promise<Response>((_, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')))
  })

  // The SDK's client, its requests answered by `answer`; the headers of each request sent
  function sdk(answer: (init: RequestInit) => Response | Promise<Response>) {
    const sent: Headers[] = []
    const fetch = async (_url: string | URL | Request, init: RequestInit = {}) => {
      sent.push(new Headers(init.headers))
      return answer(init)
    }
    const client = new Anthropic({ apiKey: 'test-key', baseURL: 'https://api.anthropic.invalid', fetch })
    // The PDF reader's call: the beta messages' create (structured outputs, the fallback beta)
    const reader: PdfReaderMessages = { create: (body, options) => client.beta.messages.create(body, options) as never }
    return { messages: client.messages, reader, sent }
  }

  test('a failed request is sent again maxRetries times; without options the client’s 2 retries, as before', async () => {
    const cases: [AiCallOptions | undefined, number][] = [[{ maxRetries: 1 }, 2], [{ maxRetries: 0 }, 1], [undefined, 3]]
    for (const [opts, sends] of cases) {
      const { messages, sent } = sdk(failed)
      await assert.rejects(messages.create(BODY, aiRequestOptions(opts)), Anthropic.InternalServerError)
      assert.equal(sent.length, sends, JSON.stringify(opts))
    }
  })
  test('the timeout holds for each request: one that timed out is sent again maxRetries times, then APIConnectionTimeoutError', async () => {
    const { messages, sent } = sdk(unanswered)
    await assert.rejects(messages.create(BODY, aiRequestOptions({ timeoutMs: 25, maxRetries: 1 })), Anthropic.APIConnectionTimeoutError)
    assert.deepEqual(sent.map(h => h.get('x-stainless-retry-count')), ['0', '1'])
  })
  test('the signal: an aborted call is never sent again, whatever its retries; one aborted before is not sent at all', async () => {
    const run = new AbortController()
    const { messages, sent } = sdk(init => {
      setTimeout(() => run.abort(), 5)
      return unanswered(init)
    })
    await assert.rejects(messages.create(BODY, aiRequestOptions({ timeoutMs: 20_000, maxRetries: 2, signal: run.signal })), Anthropic.APIUserAbortError)
    assert.equal(sent.length, 1)

    const late = sdk(answered)
    await assert.rejects(late.messages.create(BODY, aiRequestOptions({ signal: AbortSignal.abort() })), Anthropic.APIUserAbortError)
    assert.equal(late.sent.length, 0)
  })
  test('the request says its timeout; without options the client’s 10 minutes — and `timeout: undefined` is refused before anything is sent', async () => {
    const run = sdk(answered)
    await run.messages.create(BODY, aiRequestOptions({ timeoutMs: 20_000, maxRetries: 1 }))
    const before = sdk(answered)
    await before.messages.create(BODY, aiRequestOptions())
    assert.deepEqual([run.sent[0].get('x-stainless-timeout'), before.sent[0].get('x-stainless-timeout')], ['20', '600'])

    const naive = sdk(answered)
    await assert.rejects(naive.messages.create(BODY, { timeout: undefined, maxRetries: 0 }), /timeout must be an integer/)
    await naive.messages.create(BODY, aiRequestOptions({ timeoutMs: undefined, maxRetries: 0 }))
    assert.equal(naive.sent.length, 1)
  })

  // A rate limit whose retry-after the SDK waits out before it looks at the signal again
  const limited = () => new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'x' } }),
    { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '5' } })
  // How long a call took to settle after the signal aborted 20 ms in
  async function settledAfterAbort(call: (signal: AbortSignal) => PromiseLike<unknown>): Promise<{ ms: number; error: unknown }> {
    const run = new AbortController()
    setTimeout(() => run.abort(), 20)
    const t0 = Date.now()
    try {
      await call(run.signal)
      return { ms: Date.now() - t0, error: null }
    } catch (error) {
      return { ms: Date.now() - t0, error }
    }
  }
  const OPTS = { timeoutMs: 20_000, maxRetries: 1 }

  test('untilAborted: a call waiting out a rate limit’s retry-after (5 s) is given up at once when the signal aborts — the SDK alone would wait it out (review GMAIL-05)', async () => {
    const { messages, sent } = sdk(limited)
    const out = await settledAfterAbort(signal => untilAborted(messages.create(BODY, aiRequestOptions({ ...OPTS, signal })), signal))
    assert.ok(out.ms < 500, `${out.ms} ms`)
    assert.ok(out.error instanceof Error && out.error.name === 'AbortError' && out.error.message === 'Request was aborted.', String(out.error))
    assert.equal(sent.length, 1)
  })
  test('untilAborted: settles with the call when it settles first — its answer or its error —, then leaves the signal alone; no signal: the call itself', async () => {
    const run = new AbortController()
    const added: string[] = []
    const removed: string[] = []
    const signal = Object.assign(run.signal, {
      addEventListener: (type: string, fn: EventListener, o?: AddEventListenerOptions) => { added.push(type); EventTarget.prototype.addEventListener.call(run.signal, type, fn, o) },
      removeEventListener: (type: string, fn: EventListener) => { removed.push(type); EventTarget.prototype.removeEventListener.call(run.signal, type, fn) },
    })
    assert.equal(await untilAborted(Promise.resolve(42), signal), 42)
    const failure = new Error('kaputt')
    await assert.rejects(untilAborted(Promise.reject(failure), signal), e => e === failure)
    assert.deepEqual([added, removed], [['abort', 'abort'], ['abort', 'abort']])
    run.abort()
    assert.equal(await untilAborted(Promise.resolve('x')), 'x')
    // aborted before: given up at once
    await assert.rejects(untilAborted(new Promise(() => {}), AbortSignal.abort()), { name: 'AbortError', message: 'Request was aborted.' })
  })
  test('the PDF reader gives up a rate limit’s wait when the search’s signal aborts (review GMAIL-05)', async () => {
    const reads = [
      (signal: AbortSignal) => readPdfInvoice('JVBERi0=', { ...OPTS, signal }, sdk(limited).reader),
    ]
    const outs = await Promise.all(reads.map(settledAfterAbort))
    outs.forEach((out, k) => {
      assert.ok(out.ms < 500, `${k}: ${out.ms} ms`)
      assert.equal((out.error as Error | null)?.name, 'AbortError', String(k))
    })
  })
})
