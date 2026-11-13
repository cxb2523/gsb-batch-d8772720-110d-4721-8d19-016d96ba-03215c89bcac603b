import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { executeAutoFetch } from "./auto.js";

/**
 * foura_batch - submit several public URLs in one call.
 *
 * Each URL runs through the exact request path of foura_auto (same SSRF check,
 * same /auto upstream route, same error envelope). Entries run independently:
 * one blocked or timed-out URL never abandons the rest, and the batch itself is
 * never marked isError for a per-URL failure. Only an invalid *batch input*
 * (empty list, more than 50 URLs, a non-http(s) entry) returns the bad_request
 * envelope. The retry list repeats only the failed URLs with their stable
 * codes, ready to be submitted again verbatim.
 */

const MIN_URLS = 1;
const MAX_URLS = 50;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 180_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 8;
const DEFAULT_CONCURRENCY = 3;
const ERROR_SUMMARY_LIMIT = 300;

// The transport-level schema is deliberately permissive: every semantic rule
// (urls present as a 1-50 array of http/https strings, numeric ranges) is
// enforced in the handler so an invalid batch input always comes back as the
// documented tool-level bad_request envelope with structuredContent, rather
// than as an SDK validation error that has no envelope.
const batchInputShape = {
  urls: z
    .unknown()
    .optional()
    .describe("Public target URLs to fetch, 1 to 50 entries, each http or https. Private or reserved targets return ssrf_blocked per entry."),
  timeout_ms: z
    .unknown()
    .optional()
    .describe(`Per-URL time budget in ms forwarded to foura_auto (${MIN_TIMEOUT_MS}-${MAX_TIMEOUT_MS}, default ${DEFAULT_TIMEOUT_MS}). One entry timing out does not stop the others.`),
  concurrency: z
    .unknown()
    .optional()
    .describe(`URLs in flight at once (${MIN_CONCURRENCY}-${MAX_CONCURRENCY}, default ${DEFAULT_CONCURRENCY}). Results always return in input order.`),
};

const BatchItemResultSchema = z.object({
  url: z.string().describe("The URL this entry describes, exactly as submitted."),
  ok: z.boolean().describe("True when the entry delivered content; false when it returned an error envelope."),
  status: z
    .number()
    .int()
    .nullable()
    .describe("HTTP status code from the fetch. 0 means no HTTP response was received; null when no status exists, such as an SSRF block before any request."),
  code: z
    .string()
    .nullable()
    .describe("Stable error code on failure (for example ssrf_blocked, rate_limited, upstream_error, plan_limit_credits). Null on success."),
  error: z
    .string()
    .nullable()
    .describe("Short human-readable error summary on failure, truncated to 300 characters. Null on success."),
  duration_ms: z
    .number()
    .int()
    .nonnegative()
    .describe("Wall-clock time this entry spent, in milliseconds."),
  request_id: z
    .string()
    .optional()
    .describe("FourA's id for the underlying foura_auto call, when reported. Quote it in a support request."),
  credits: z
    .number()
    .optional()
    .describe("Credits the underlying call spent, when reported. Present on failures too."),
});

const BatchRetryItemSchema = z.object({
  url: z.string().describe("A URL that failed, exactly as originally submitted so the list can be re-submitted verbatim."),
  code: z.string().describe("The stable error code from the failed entry (for example ssrf_blocked, rate_limited, upstream_error)."),
});

const batchOutputShape = {
  summary: z
    .object({
      total: z.number().int().nonnegative().describe("Number of URLs submitted."),
      succeeded: z.number().int().nonnegative().describe("Entries that delivered content."),
      failed: z.number().int().nonnegative().describe("Entries that returned an error envelope."),
    })
    .describe("Batch totals. succeeded + failed always equals total."),
  results: z
    .array(BatchItemResultSchema)
    .describe("One result per submitted URL, in input order."),
  retry: z
    .array(BatchRetryItemSchema)
    .describe("Only the failed entries, each with its original URL and stable code, in input order. Empty when every entry succeeded."),
  // Tool-level bad_request envelope fields (only present when the batch input itself is invalid).
  service: z
    .enum(["batch"])
    .optional()
    .describe('Envelope marker: "batch" on a bad_request result for invalid batch input.'),
  code: z
    .string()
    .optional()
    .describe("bad_request when the batch input itself is invalid. Per-URL failures never appear here; they live in results[].code."),
  error: z
    .string()
    .optional()
    .describe("Human-readable reason for a bad_request result."),
};

interface BatchItemResult {
  url: string;
  ok: boolean;
  status: number | null;
  code: string | null;
  error: string | null;
  duration_ms: number;
  request_id?: string;
  credits?: number;
}

interface BatchRetryItem {
  url: string;
  code: string;
}

function summarizeError(message: unknown): string {
  const text = message instanceof Error ? message.message : String(message);
  return text.length > ERROR_SUMMARY_LIMIT ? `${text.slice(0, ERROR_SUMMARY_LIMIT)}...` : text;
}

function badRequest(message: string) {
  return {
    isError: true,
    content: [
      { type: "text" as const, text: `FourA batch - bad request: ${message}` },
    ],
    structuredContent: {
      service: "batch" as const,
      code: "bad_request",
      error: message,
    },
  };
}

/**
 * Run up to `concurrency` entries at a time while writing each result back to
 * its input index, so finish order never changes result order.
 */
async function runWithConcurrency(
  urls: string[],
  concurrency: number,
  timeoutMs: number,
): Promise<BatchItemResult[]> {
  const results: BatchItemResult[] = new Array(urls.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= urls.length) return;
      // The URL is already validated; the non-null assertion mirrors that check.
      const url = urls[index] as string;
      const startedAt = Date.now();
      try {
        const outcome = await executeAutoFetch({ url, timeout_ms: timeoutMs });
        const durationMs = Date.now() - startedAt;
        const sc = outcome.structuredContent ?? {};
        const failed = outcome.isError === true;
        const rawStatus = sc.status;
        results[index] = {
          url,
          ok: !failed,
          // Null when the failure produced no HTTP status at all (for example an
          // SSRF block before any request); 0 when a request ran but got no response.
          status: typeof rawStatus === "number" ? rawStatus : null,
          code: failed
            ? (typeof sc.code === "string" && sc.code.length > 0 ? sc.code : "upstream_error")
            : null,
          error: failed ? summarizeError(sc.error) : null,
          duration_ms: durationMs,
          ...(typeof sc.request_id === "string" ? { request_id: sc.request_id } : {}),
          ...(typeof sc.credits === "number" ? { credits: sc.credits } : {}),
        };
      } catch (e) {
        // executeAutoFetch already converts every expected failure into an envelope.
        // This catch is the last-resort guard so one crashing entry cannot sink the batch.
        results[index] = {
          url,
          ok: false,
          status: 0,
          code: "upstream_error",
          error: summarizeError(e),
          duration_ms: Date.now() - startedAt,
        };
      }
    }
  };

  const workerCount = Math.min(concurrency, urls.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export function registerBatchTool(server: McpServer): void {
  server.registerTool(
    "foura_batch",
    {
      title: "FourA - batch fetch (many URLs, one call, per-URL outcomes)",
      description:
        "Submit 1 to 50 public URLs and get one outcome per URL. Every entry reuses foura_auto's " +
        "request path and SSRF check and runs independently: a blocked or timed-out entry never " +
        "stops the others. Results return in input order with ok, status, a stable error code, an " +
        "error summary and the per-entry duration. The summary gives succeeded/failed counts and " +
        "retry lists only the failed URLs plus their codes, ready to resubmit verbatim. Per-URL " +
        "failures stay inside that entry's result; the batch itself errors only when the input is " +
        "invalid (empty or over-50 list, a non-http(s) URL), returning code bad_request.",
      inputSchema: batchInputShape,
      outputSchema: batchOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      const rawUrls = input.urls;

      if (!Array.isArray(rawUrls) || rawUrls.length < MIN_URLS || rawUrls.length > MAX_URLS) {
        return badRequest(
          `urls must contain between ${MIN_URLS} and ${MAX_URLS} entries; received ${Array.isArray(rawUrls) ? rawUrls.length : 0}`,
        );
      }

      // Every entry must be a string http/https URL. Validate all of them before
      // any fetch starts so a malformed batch never performs partial work.
      for (const candidate of rawUrls) {
        if (typeof candidate !== "string") {
          return badRequest(`urls entries must be http or https URL strings; got: ${String(candidate).slice(0, 200)}`);
        }
        let parsed: URL;
        try {
          parsed = new URL(candidate);
        } catch {
          return badRequest(`urls entries must be valid http or https URLs; got: ${candidate.slice(0, 200)}`);
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return badRequest(
            `urls entries must use http or https; ${candidate} uses ${parsed.protocol}`,
          );
        }
      }

      // Numeric options are checked in the handler (not the transport schema) so a
      // violation returns the bad_request envelope deterministically.
      const rawTimeout = input.timeout_ms;
      const timeoutMs = rawTimeout === undefined ? DEFAULT_TIMEOUT_MS : rawTimeout;
      if (
        !Number.isInteger(timeoutMs)
        || (timeoutMs as number) < MIN_TIMEOUT_MS
        || (timeoutMs as number) > MAX_TIMEOUT_MS
      ) {
        return badRequest(
          `timeout_ms must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}; got ${String(timeoutMs)}`,
        );
      }
      const rawConcurrency = input.concurrency;
      const concurrency = rawConcurrency === undefined ? DEFAULT_CONCURRENCY : rawConcurrency;
      if (
        !Number.isInteger(concurrency)
        || (concurrency as number) < MIN_CONCURRENCY
        || (concurrency as number) > MAX_CONCURRENCY
      ) {
        return badRequest(
          `concurrency must be an integer between ${MIN_CONCURRENCY} and ${MAX_CONCURRENCY}; got ${String(concurrency)}`,
        );
      }

      const urls = rawUrls as string[];
      const results = await runWithConcurrency(
        urls,
        concurrency as number,
        timeoutMs as number,
      );

      const failedEntries = results.filter((entry) => !entry.ok);
      const retry: BatchRetryItem[] = failedEntries.map((entry) => ({
        url: entry.url,
        // A failed entry always carries a stable code by construction.
        code: entry.code ?? "upstream_error",
      }));

      const structured = {
        summary: {
          total: urls.length,
          succeeded: results.length - failedEntries.length,
          failed: failedEntries.length,
        },
        results,
        retry,
      };

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Batch finished: ${structured.summary.succeeded}/${urls.length} succeeded, ` +
              `${structured.summary.failed} failed. Resubmit the ${retry.length} entr${retry.length === 1 ? "y" : "ies"} in retry to continue.`,
          },
        ],
        structuredContent: structured,
      };
    },
  );
}
