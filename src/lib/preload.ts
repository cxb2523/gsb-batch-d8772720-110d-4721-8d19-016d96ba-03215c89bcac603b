/**
 * Outcome of a single preloaded-report probe.
 *
 * These are fixed enums only: they must never carry CSV contents, file names,
 * URLs, or any per-user data (see docs/analytics.md and the client-only privacy
 * constraint in CONTRIBUTING.md).
 */
export type PreloadOutcome =
  | "success"
  | "not_found"
  | "not_csv"
  | "parse_failed"
  | "fetch_failed";

/** Which preloaded slot was probed. Also a fixed, non-sensitive enum. */
export type PreloadSlot = "primary" | "comparison";

export interface PreloadProbeResult {
  slot: PreloadSlot;
  outcome: PreloadOutcome;
}

/**
 * Human-readable explanations of what happened to a preloaded slot. These are
 * shown in the upload prompt so operators can tell a missing file apart from an
 * HTML fallback page or an unparseable CSV without touching logs.
 *
 * Keyed by slot so the wording matches the file's role (main report vs.
 * previous-month comparison). They deliberately mention neither file names nor
 * any report data.
 */
const OUTCOME_MESSAGES: Record<PreloadSlot, Record<PreloadOutcome, string>> = {
  primary: {
    success: "The built-in usage report loaded successfully.",
    not_found:
      "No built-in usage report was shipped with this site, so you can upload your own CSV below.",
    not_csv:
      "The built-in usage report could not be loaded: the site returned a web page instead of a CSV file. You can upload your own CSV below.",
    parse_failed:
      "The built-in usage report was found but its contents could not be read as a usage report CSV. You can upload your own CSV below.",
    fetch_failed:
      "The built-in usage report could not be retrieved (for example, the network request failed). You can upload your own CSV below.",
  },
  comparison: {
    success: "The built-in previous-month comparison report loaded successfully.",
    not_found:
      "No built-in previous-month comparison report was shipped with this site, so month-over-month comparison is unavailable until you add one.",
    not_csv:
      "The built-in previous-month comparison report could not be loaded: the site returned a web page instead of a CSV file.",
    parse_failed:
      "The built-in previous-month comparison report was found but its contents could not be read as a usage report CSV.",
    fetch_failed:
      "The built-in previous-month comparison report could not be retrieved (for example, the network request failed).",
  },
};

export function preloadOutcomeMessage(slot: PreloadSlot, outcome: PreloadOutcome): string {
  return OUTCOME_MESSAGES[slot][outcome];
}

/**
 * Probe one preloaded CSV slot and classify the result.
 *
 * The classification is deliberately narrow and stable so every attempt leaves
 * an interpretable ending:
 *
 * - `not_found`      - a non-OK HTTP response (e.g. 404); the file is absent
 * - `not_csv`        - an OK response whose content-type is `text/html` (the
 *                      static host's SPA fallback page) rather than a CSV
 * - `parse_failed`   - a CSV response whose contents cannot be parsed
 * - `fetch_failed`   - the request itself failed (network error / abort)
 * - `success`        - fetched and parsed; the parsed report is returned
 *
 * Only the fixed slot/outcome enums are ever logged or sent to analytics - never
 * the response body, a file name, or any per-user data. The parsed report stays
 * in memory on the client, exactly like an uploaded report.
 */
export async function probePreloadedReport<T>(
  slot: PreloadSlot,
  url: string,
  options: {
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    parse: (text: string) => T;
  },
): Promise<{ outcome: PreloadOutcome; report: T | null }> {
  const { signal, fetchImpl = fetch, parse } = options;
  let res: Response;
  try {
    res = await fetchImpl(url, { signal });
  } catch (err) {
    // An AbortError means the component unmounted; surface it the same way so
    // the caller can ignore the result rather than treating it as a probe.
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    return { outcome: "fetch_failed", report: null };
  }

  if (!res.ok) {
    return { outcome: "not_found", report: null };
  }
  if ((res.headers.get("content-type") ?? "").includes("text/html")) {
    return { outcome: "not_csv", report: null };
  }

  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    return { outcome: "fetch_failed", report: null };
  }

  try {
    const report = parse(text);
    return { outcome: "success", report };
  } catch {
    return { outcome: "parse_failed", report: null };
  }
}
