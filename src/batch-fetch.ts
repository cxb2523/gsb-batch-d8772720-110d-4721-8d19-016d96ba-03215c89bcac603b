/**
 * Batch retrieval on top of the existing Firecrawl fetch provider: given a
 * list of URLs, run each through the same single-page fetch path and settle
 * every entry independently. One bad or cancelled URL never sinks the batch —
 * the batch itself does not throw for a per-entry failure; it returns an
 * ordered outcome list the caller can audit entry by entry.
 *
 * No model-visible tool is added here, and the single-page `web_fetch` path is
 * untouched: this module only orchestrates calls into a `WebFetchProvider`.
 * @module @firecrawl/dsh-firecrawl/batch-fetch
 */

import type { WebFetchProvider, WebFetchResult } from '@deepseek-ai/dsh-web'
import { isAbortError } from './http.ts'

/** Default maximum number of entries fetched at once. */
export const DEFAULT_BATCH_FETCH_CONCURRENCY = 3

/** How one batch entry ended; a closed three-state vocabulary. */
export type BatchFetchStatus = 'success' | 'failure' | 'aborted'

/** Per-entry outcome shared by every state: the URL as originally requested. */
interface BatchFetchEntryBase {
  /** The URL exactly as it appeared in the input list, for position-wise comparison. */
  readonly url: string
  readonly status: BatchFetchStatus
}

/** A retrieved page. A non-2xx page is still a success — the status is resource state. */
export interface BatchFetchSuccess extends BatchFetchEntryBase {
  readonly status: 'success'
  /** The final URL after redirects Firecrawl followed. */
  readonly finalUrl: string
  /** HTTP status code of the fetched response. */
  readonly statusCode: number
  /** Decoded body, in the same closed vocabulary a single-page fetch returns. */
  readonly body: WebFetchResult['body']
  /** True when the provider capped the decoded body. */
  readonly truncated: boolean
}

/** An entry the provider could not retrieve. The batch itself never throws for this. */
export interface BatchFetchFailure extends BatchFetchEntryBase {
  readonly status: 'failure'
  /** Always `WEB_PROVIDER_ERROR`, the same catch-all the single-page path raises. */
  readonly errorCode: 'WEB_PROVIDER_ERROR'
  /** Human-readable failure detail, taken from the provider's error where possible. */
  readonly errorMessage: string
}

/** An entry whose own cancellation signal fired before a result was produced. */
export interface BatchFetchAborted extends BatchFetchEntryBase {
  readonly status: 'aborted'
  /** Always `WEB_ABORTED`, matching the single-page channel's cancellation code. */
  readonly errorCode: 'WEB_ABORTED'
  readonly errorMessage: string
}

/** The discriminated union of the three possible per-entry outcomes. */
export type BatchFetchResult = BatchFetchSuccess | BatchFetchFailure | BatchFetchAborted

/** Options for {@link fetchBatch}; every field is optional. */
export interface BatchFetchOptions {
  /**
   * Maximum number of entries in flight at once. Must be a positive integer;
   * defaults to {@link DEFAULT_BATCH_FETCH_CONCURRENCY}. An invalid value is a
   * programming error and rejects the whole call before any entry starts.
   */
  readonly concurrency?: number
  /**
   * Per-entry cancellation signals, indexed in parallel with the URL list:
   * `signals[i]` cancels only `urls[i]`. A missing entry means that URL is not
   * individually cancellable.
   */
  readonly signals?: readonly (AbortSignal | undefined)[]
}

/**
 * Fetch a batch of URLs through an existing fetch provider, never letting one
 * entry's failure become a batch-level throw.
 *
 * Admission is the provider's own: an invalid (non-http(s), over-long, or
 * credential-carrying) URL is rejected inside `provider.fetch` BEFORE any
 * credential-bearing request leaves the process, and settles here as a failure
 * entry with no network call. Cancellation settles as `WEB_ABORTED`; every
 * other per-entry failure settles as `WEB_PROVIDER_ERROR`.
 *
 * @param provider - the fetch provider each entry runs through.
 * @param urls - the URLs to fetch, in caller order.
 * @param options - optional concurrency cap and per-entry abort signals.
 * @returns one outcome per input URL, in exactly the input order.
 */
export async function fetchBatch(
  provider: WebFetchProvider,
  urls: readonly string[],
  options: BatchFetchOptions = {},
): Promise<BatchFetchResult[]> {
  const concurrency = resolveConcurrency(options.concurrency)
  const results: BatchFetchResult[] = new Array<BatchFetchResult>(urls.length)
  let next = 0

  // A fixed pool of workers drains a shared cursor, so at most `concurrency`
  // provider calls are ever in flight while each slot writes its own position.
  const workers = Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
    while (true) {
      const index = next
      if (index >= urls.length) return
      next += 1
      const url = urls[index]
      if (url === undefined) throw new TypeError('batch URL list contains a hole')
      results[index] = await fetchOne(provider, url, options.signals?.[index])
    }
  })

  await Promise.all(workers)
  return results
}

/**
 * True when every entry succeeded — the batch-level completeness check. A
 * single failure or abort makes the batch incomplete even though the call
 * itself resolved.
 */
export function isBatchFetchComplete(results: readonly BatchFetchResult[]): boolean {
  return results.every(result => result.status === 'success')
}

/** Validate the concurrency option the same way the providers validate counts. */
function resolveConcurrency(concurrency: number | undefined): number {
  if (concurrency === undefined) return DEFAULT_BATCH_FETCH_CONCURRENCY
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new TypeError(`concurrency must be a positive integer, received ${String(concurrency)}`)
  }
  return concurrency
}

/** Settle exactly one URL, classifying every outcome into the batch vocabulary. */
async function fetchOne(
  provider: WebFetchProvider,
  url: string,
  signal: AbortSignal | undefined,
): Promise<BatchFetchResult> {
  // A signal already aborted before the entry starts must not race the
  // provider's admission check — cancellation wins, and nothing is requested.
  if (isAborted(signal)) return abortedEntry(url)

  try {
    const result = await provider.fetch({ url }, signal)
    // Defensive re-check: a transport that ignores its signal still resolves,
    // but the caller asked for cancellation, so the entry is an abort.
    if (isAborted(signal)) return abortedEntry(url)
    return {
      url,
      status: 'success',
      finalUrl: result.url,
      statusCode: result.statusCode,
      body: result.body,
      truncated: result.truncated,
    }
  } catch (error: unknown) {
    if (isAbortLike(error, signal)) return abortedEntry(url)
    // Every non-cancellation per-entry failure — transport errors, Firecrawl's
    // own failures, and local WEB_INVALID_URL admission rejections — is a
    // failure ENTRY under the provider-error vocabulary, never a batch throw.
    return {
      url,
      status: 'failure',
      errorCode: 'WEB_PROVIDER_ERROR',
      errorMessage: describeError(error),
    }
  }
}

/** True when the thrown value is the abort the entry's own signal requested. */
function isAbortLike(error: unknown, signal: AbortSignal | undefined): boolean {
  return isAbortError(error)
    || (hasCode(error, 'WEB_ABORTED'))
    || isAborted(signal)
}

/** True when an optional per-entry signal is present and already aborted. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** Narrow a thrown value to anything carrying the seam's error `code`. */
function hasCode(error: unknown, code: string): error is { readonly code: string } {
  return typeof error === 'object' && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === code
}

/** Build the uniform aborted entry for a cancelled URL. */
function abortedEntry(url: string): BatchFetchAborted {
  return {
    url,
    status: 'aborted',
    errorCode: 'WEB_ABORTED',
    errorMessage: `Firecrawl fetch aborted: ${url}`,
  }
}

/** Pull a readable message off whatever the provider threw. */
function describeError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  return String(error)
}
