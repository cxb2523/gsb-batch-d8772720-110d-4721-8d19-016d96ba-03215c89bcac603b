/**
 * Batch fetching over the real `FirecrawlFetchProvider` with a locally stubbed
 * `fetch`: mixed outcomes, admission-before-network, the concurrency cap, and
 * per-entry cancellation. No Firecrawl credentials and no network leave the
 * process — every response comes from an in-memory stub.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_BATCH_FETCH_CONCURRENCY,
  fetchBatch,
  isBatchFetchComplete,
} from '../src/fetch.ts'
import { FirecrawlFetchProvider } from '../src/fetch-provider.ts'
import type {
  BatchFetchFailure,
  BatchFetchResult,
  BatchFetchSuccess,
} from '../src/batch-fetch.ts'
import type { FirecrawlFetchProviderOptions } from '../src/fetch-provider.ts'
import { FIRECRAWL_DEFAULT_BASE_URL } from '../src/http.ts'

const apiKey = 'fc-test-batch'

function options(overrides: Partial<FirecrawlFetchProviderOptions> = {}): FirecrawlFetchProviderOptions {
  return {
    apiKey,
    baseURL: FIRECRAWL_DEFAULT_BASE_URL,
    format: 'markdown',
    onlyMainContent: true,
    maxAgeMs: 172_800_000,
    waitForMs: 0,
    mobile: false,
    blockAds: true,
    proxy: 'auto',
    timeoutMs: 60_000,
    maxBodyChars: 100_000,
    maxUrlLength: 2048,
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** A successful scrape envelope whose final URL is `${page}/final`. */
function successEnvelope(page: string, markdown = `body of ${page}`) {
  return {
    success: true,
    data: { markdown, metadata: { sourceURL: page, url: `${page}/final`, statusCode: 200 } },
  }
}

/** A Firecrawl upstream-page failure, as delivered on a 200 envelope. */
const upstreamFailure = {
  success: false,
  code: 'SCRAPE_DNS_RESOLUTION_ERROR',
  error: 'DNS resolution failed for hostname "fail.test".',
}

/** Read the scraped page URL out of a stubbed request's JSON body. */
function requestedPage(init: RequestInit | undefined): string {
  return JSON.parse(String(init?.body)).url as string
}

/** Stub `fetch` that routes each scraped URL to a per-page response factory. */
function routingFetch(routes: Record<string, () => Response | Promise<Response>>) {
  return vi.fn(async (input: string | URL, init?: RequestInit) => {
    const page = requestedPage(init)
    const route = routes[page]
    if (route === undefined) throw new Error(`stub received an unexpected URL: ${page}`)
    return route()
  })
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('mixed outcomes', () => {
  it('settles every entry independently, keeps input order, and never batch-throws', async () => {
    const ok1 = 'https://a.test/page'
    const bad = 'https://fail.test/x'
    const illegal = 'file:///etc/passwd'
    const creds = 'https://user:pw@creds.test/'
    const overLong = `https://long.test/${'z'.repeat(2100)}`
    const ok2 = 'https://b.test/page'

    const fetchMock = routingFetch({
      [ok1]: () => jsonResponse(successEnvelope(ok1)),
      [bad]: () => jsonResponse(upstreamFailure),
      [ok2]: () => jsonResponse(successEnvelope(ok2, 'second body')),
    })
    vi.stubGlobal('fetch', fetchMock)

    const results = await fetchBatch(new FirecrawlFetchProvider(options()), [ok1, bad, illegal, creds, overLong, ok2])

    expect(results.map(entry => [entry.url, entry.status])).toEqual([
      [ok1, 'success'],
      [bad, 'failure'],
      [illegal, 'failure'],
      [creds, 'failure'],
      [overLong, 'failure'],
      [ok2, 'success'],
    ])

    // A success carries the final URL, status, body, and truncation flag.
    const first = results[0] as BatchFetchSuccess
    expect(first).toMatchObject({
      url: ok1,
      status: 'success',
      finalUrl: `${ok1}/final`,
      statusCode: 200,
      truncated: false,
    })
    expect(first.body).toEqual({ kind: 'text', content: `body of ${ok1}` })

    // Every non-cancelled failure uses the provider-error vocabulary.
    for (const failed of [results[1], results[2], results[3], results[4]] as BatchFetchFailure[]) {
      expect(failed.errorCode).toBe('WEB_PROVIDER_ERROR')
      expect(failed.errorMessage.length).toBeGreaterThan(0)
    }
    expect((results[1] as BatchFetchFailure).errorMessage).toContain('SCRAPE_DNS_RESOLUTION_ERROR')

    // The illegal and over-long entries never reached the transport; the
    // credential-bearing request went out only for the admitted URLs.
    expect(fetchMock.mock.calls.map(call => requestedPage(call[1]))).toEqual([ok1, bad, ok2])

    expect(isBatchFetchComplete(results)).toBe(false)
  })

  it('reports a complete batch only when every entry succeeded', async () => {
    const fetchMock = routingFetch({
      'https://a.test': () => jsonResponse(successEnvelope('https://a.test')),
      'https://b.test': () => jsonResponse(successEnvelope('https://b.test')),
    })
    vi.stubGlobal('fetch', fetchMock)

    const results = await fetchBatch(new FirecrawlFetchProvider(options()), ['https://a.test', 'https://b.test'])
    expect(results.every(entry => entry.status === 'success')).toBe(true)
    expect(isBatchFetchComplete(results)).toBe(true)
  })

  it('treats a non-2xx page as a successful entry with the page status', async () => {
    vi.stubGlobal('fetch', routingFetch({
      'https://missing.test': () => jsonResponse({
        success: true,
        data: { markdown: '# Missing', metadata: { url: 'https://missing.test', statusCode: 404 } },
      }),
    }))

    const [result] = await fetchBatch(new FirecrawlFetchProvider(options()), ['https://missing.test'])
    expect(result).toMatchObject({ status: 'success', statusCode: 404 })
  })

  it('maps truncation onto the entry', async () => {
    vi.stubGlobal('fetch', routingFetch({
      'https://long.test': () => jsonResponse({
        success: true,
        data: { markdown: 'abcdefghij', metadata: { url: 'https://long.test', statusCode: 200 } },
      }),
    }))

    const [result] = await fetchBatch(
      new FirecrawlFetchProvider(options({ maxBodyChars: 4 })),
      ['https://long.test'],
    )
    expect(result).toMatchObject({ status: 'success', truncated: true })
    expect((result as BatchFetchSuccess).body).toEqual({ kind: 'text', content: 'abcd' })
  })

  it('classifies an HTTP 500 transport failure as WEB_PROVIDER_ERROR, not a throw', async () => {
    vi.stubGlobal('fetch', routingFetch({
      'https://five.test': () => new Response('gateway unavailable', { status: 500 }),
    }))

    const [result] = await fetchBatch(new FirecrawlFetchProvider(options()), ['https://five.test'])
    expect(result).toMatchObject({
      status: 'failure',
      errorCode: 'WEB_PROVIDER_ERROR',
      errorMessage: expect.stringContaining('HTTP 500'),
    })
  })
})

describe('URL admission before any network call', () => {
  it.each([
    ['a file URL', 'file:///etc/passwd'],
    ['an ftp URL', 'ftp://example.com/x'],
    ['a data URL', 'data:text/plain,hi'],
    ['an unparseable string', 'not a url'],
    ['embedded credentials', 'https://user:pass@example.com/'],
  ])('rejects %s as a failure entry without contacting the transport', async (_label, url) => {
    const fetchMock = vi.fn<(input: string | URL, init?: RequestInit) => Promise<Response>>()
    vi.stubGlobal('fetch', fetchMock)

    const [result] = await fetchBatch(new FirecrawlFetchProvider(options()), [url])
    expect(result).toMatchObject({ url, status: 'failure', errorCode: 'WEB_PROVIDER_ERROR' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects an over-long URL as a failure entry without contacting the transport', async () => {
    const fetchMock = vi.fn<(input: string | URL, init?: RequestInit) => Promise<Response>>()
    vi.stubGlobal('fetch', fetchMock)
    const url = `https://a.test/${'x'.repeat(64)}`

    const [result] = await fetchBatch(new FirecrawlFetchProvider(options({ maxUrlLength: 32 })), [url])
    expect(result).toMatchObject({ status: 'failure', errorCode: 'WEB_PROVIDER_ERROR' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('concurrency', () => {
  it.each([0, -1, 1.5, NaN])('rejects a non-positive-integer cap %s before any entry starts', async value => {
    const fetchMock = vi.fn<(input: string | URL, init?: RequestInit) => Promise<Response>>()
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchBatch(new FirecrawlFetchProvider(options()), ['https://a.test'], { concurrency: value }))
      .rejects.toBeInstanceOf(TypeError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('defaults the cap to DEFAULT_BATCH_FETCH_CONCURRENCY', async () => {
    expect(DEFAULT_BATCH_FETCH_CONCURRENCY).toBe(3)
    let current = 0
    let max = 0
    const gates = new Map<string, Deferred<void>>()
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const page = requestedPage(init)
      current += 1
      max = Math.max(max, current)
      const gate = deferred<void>()
      gates.set(page, gate)
      await gate.promise
      current -= 1
      return jsonResponse(successEnvelope(page))
    })
    vi.stubGlobal('fetch', fetchMock)

    const urls = ['https://1.test', 'https://2.test', 'https://3.test', 'https://4.test']
    const batch = fetchBatch(new FirecrawlFetchProvider(options()), urls)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    expect(max).toBe(3)
    // Release every gate as it appears so later slots can start; keep
    // releasing until all four entries have been dispatched and settled.
    const release = setInterval(() => {
      for (const gate of gates.values()) gate.resolve()
    }, 0)
    try {
      const results = await batch
      expect(results.map(entry => entry.url)).toEqual(urls)
      expect(max).toBe(3)
    } finally {
      clearInterval(release)
    }
  })

  it('holds in-flight entries at the explicit cap and preserves order on the way out', async () => {
    let current = 0
    let max = 0
    const gates = new Map<string, Deferred<void>>()
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const page = requestedPage(init)
      current += 1
      max = Math.max(max, current)
      const gate = deferred<void>()
      gates.set(page, gate)
      await gate.promise
      current -= 1
      return jsonResponse(successEnvelope(page))
    })
    vi.stubGlobal('fetch', fetchMock)

    const urls = ['https://1.test', 'https://2.test', 'https://3.test', 'https://4.test', 'https://5.test']
    const batch = fetchBatch(new FirecrawlFetchProvider(options()), urls, { concurrency: 2 })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(max).toBe(2)

    // Release the second slot first: completion order must not reorder results.
    gates.get('https://2.test')!.resolve()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    gates.get('https://1.test')!.resolve()
    gates.get('https://3.test')!.resolve()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5))
    for (const gate of gates.values()) gate.resolve()

    const results = await batch
    expect(results.map(entry => entry.url)).toEqual(urls)
    expect(max).toBe(2)
  })

  it('keeps input order when responses finish out of order', async () => {
    vi.stubGlobal('fetch', routingFetch({
      'https://slow.test': () => new Promise(resolve => {
        setTimeout(() => resolve(jsonResponse(successEnvelope('https://slow.test'))), 30)
      }),
      'https://fast.test': () => jsonResponse(successEnvelope('https://fast.test')),
    }))

    const results = await fetchBatch(
      new FirecrawlFetchProvider(options()),
      ['https://slow.test', 'https://fast.test'],
    )
    expect(results.map(entry => entry.url)).toEqual(['https://slow.test', 'https://fast.test'])
  })
})

describe('per-entry cancellation', () => {
  it('settles a pre-aborted entry as WEB_ABORTED without a network call', async () => {
    const fetchMock = routingFetch({
      'https://b.test': () => jsonResponse(successEnvelope('https://b.test')),
    })
    vi.stubGlobal('fetch', fetchMock)

    const controller = new AbortController()
    controller.abort()
    const results = await fetchBatch(
      new FirecrawlFetchProvider(options()),
      ['https://a.test', 'https://b.test'],
      { signals: [controller.signal, undefined] },
    )

    expect(results[0]).toMatchObject({ url: 'https://a.test', status: 'aborted', errorCode: 'WEB_ABORTED' })
    expect(results[1]).toMatchObject({ status: 'success' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('maps an in-flight abort to WEB_ABORTED while sibling entries still finish', async () => {
    const target = 'https://cancel.test'
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const page = requestedPage(init)
      if (page === target) {
        // Mimic the real fetch: reject with an AbortError when the signal fires.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          }, { once: true })
        })
      }
      return jsonResponse(successEnvelope(page))
    }))

    const batch = fetchBatch(
      new FirecrawlFetchProvider(options()),
      [target, 'https://keep.test'],
      { signals: [controller.signal] },
    )
    controller.abort()
    const results = await batch

    expect(results[0]).toMatchObject({ status: 'aborted', errorCode: 'WEB_ABORTED' })
    expect(results[1]).toMatchObject({ status: 'success' })
    expect(isBatchFetchComplete(results)).toBe(false)
  })

  it('classifies an entry as WEB_ABORTED even when the transport ignores the signal', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(successEnvelope('https://ignored.test'))))

    const batch = fetchBatch(
      new FirecrawlFetchProvider(options()),
      ['https://ignored.test'],
      { signals: [controller.signal] },
    )
    controller.abort()
    const results = await batch

    expect(results[0]).toMatchObject({ status: 'aborted', errorCode: 'WEB_ABORTED' })
  })

  it('scopes each signal to its own entry only', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const page = requestedPage(init)
      if (page === 'https://b.test') {
        // Park until the signal fires, then reject exactly as a real fetch does.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          }, { once: true })
        })
      }
      return jsonResponse(successEnvelope(page))
    }))

    const batch = fetchBatch(
      new FirecrawlFetchProvider(options()),
      ['https://a.test', 'https://b.test'],
      { signals: [undefined, controller.signal] },
    )
    controller.abort()

    const results = await batch
    expect(results[0]).toMatchObject({ status: 'success' })
    expect(results[1]).toMatchObject({ status: 'aborted', errorCode: 'WEB_ABORTED' })
  })
})

describe('empty input', () => {
  it('resolves to an empty, complete list without touching the transport', async () => {
    const fetchMock = vi.fn<(input: string | URL, init?: RequestInit) => Promise<Response>>()
    vi.stubGlobal('fetch', fetchMock)

    const results: BatchFetchResult[] = await fetchBatch(new FirecrawlFetchProvider(options()), [])
    expect(results).toEqual([])
    expect(isBatchFetchComplete(results)).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
