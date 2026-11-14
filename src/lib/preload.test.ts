import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  preloadOutcomeMessage,
  probePreloadedReport,
  type PreloadOutcome,
} from "@/lib/preload";

function mockResponse({
  ok = true,
  status = 200,
  contentType = "text/csv",
  body = "date,product\n2026-01-01,copilot\n",
}: {
  ok?: boolean;
  status?: number;
  contentType?: string;
  body?: string;
} = {}): Response {
  return {
    ok,
    status,
    headers: new Headers({ "content-type": contentType }),
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

function fetchOnce(res?: Response, err?: unknown): typeof fetch {
  return vi.fn(async () => {
    if (err) throw err;
    return res as Response;
  }) as unknown as typeof fetch;
}

const VALID_CSV = "date,product,sku,quantity\n2026-01-01,copilot,sku,1\n";
const parse = vi.fn((text: string) => {
  if (!text.includes("date")) throw new Error("no date column");
  return { rows: text.length };
});

beforeEach(() => {
  parse.mockClear();
});

describe("probePreloadedReport", () => {
  it("returns success with the parsed report for a valid CSV", async () => {
    const fetchImpl = fetchOnce(mockResponse({ body: VALID_CSV }));
    const result = await probePreloadedReport("primary", "/preloaded-report.csv", {
      fetchImpl,
      parse,
    });

    expect(result.outcome).toBe("success");
    expect(result.report).toEqual({ rows: VALID_CSV.length });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("classifies a 404 (non-OK response) as not_found and never parses", async () => {
    const fetchImpl = fetchOnce(mockResponse({ ok: false, status: 404 }));
    const result = await probePreloadedReport("primary", "/missing.csv", {
      fetchImpl,
      parse,
    });

    expect(result).toEqual({ outcome: "not_found", report: null });
    expect(parse).not.toHaveBeenCalled();
  });

  it("classifies any non-OK status as not_found", async () => {
    const fetchImpl = fetchOnce(mockResponse({ ok: false, status: 500 }));
    const result = await probePreloadedReport("primary", "/missing.csv", {
      fetchImpl,
      parse,
    });

    expect(result.outcome).toBe("not_found");
  });

  it("classifies an HTML fallback page (text/html content-type) as not_csv", async () => {
    const fetchImpl = fetchOnce(
      mockResponse({ contentType: "text/html; charset=utf-8", body: "<html></html>" }),
    );
    const result = await probePreloadedReport("primary", "/fallback", {
      fetchImpl,
      parse,
    });

    expect(result).toEqual({ outcome: "not_csv", report: null });
    expect(parse).not.toHaveBeenCalled();
  });

  it("classifies a CSV that fails to parse as parse_failed", async () => {
    const fetchImpl = fetchOnce(mockResponse({ body: "not,a,valid,report\n1,2,3,4\n" }));
    const result = await probePreloadedReport("primary", "/broken.csv", {
      fetchImpl,
      parse,
    });

    expect(result).toEqual({ outcome: "parse_failed", report: null });
  });

  it("classifies a network failure as fetch_failed", async () => {
    const fetchImpl = fetchOnce(undefined, new TypeError("Failed to fetch"));
    const result = await probePreloadedReport("primary", "/unreachable.csv", {
      fetchImpl,
      parse,
    });

    expect(result).toEqual({ outcome: "fetch_failed", report: null });
  });

  it("rethrows an AbortError so unmounted probes are not recorded", async () => {
    const abort = new DOMException("The operation was aborted.", "AbortError");
    const fetchImpl = fetchOnce(undefined, abort);
    await expect(
      probePreloadedReport("primary", "/aborted.csv", { fetchImpl, parse }),
    ).rejects.toThrow("aborted");
  });

  it("passes the AbortSignal through to fetch", async () => {
    const fetchImpl = fetchOnce(mockResponse());
    const controller = new AbortController();
    await probePreloadedReport("primary", "/x.csv", {
      fetchImpl,
      parse,
      signal: controller.signal,
    });

    expect(fetchImpl).toHaveBeenCalledWith("/x.csv", { signal: controller.signal });
  });
});

describe("preloadOutcomeMessage", () => {
  const outcomes: PreloadOutcome[] = [
    "success",
    "not_found",
    "not_csv",
    "parse_failed",
    "fetch_failed",
  ];

  it("provides plain-language copy for every slot and outcome", () => {
    for (const slot of ["primary", "comparison"] as const) {
      for (const outcome of outcomes) {
        const message = preloadOutcomeMessage(slot, outcome);
        expect(typeof message).toBe("string");
        expect(message.length).toBeGreaterThan(0);
      }
    }
  });

  it("never includes the file name in user-facing outcome copy", () => {
    for (const slot of ["primary", "comparison"] as const) {
      for (const outcome of outcomes) {
        expect(preloadOutcomeMessage(slot, outcome)).not.toMatch(/\.csv/i);
      }
    }
  });
});
