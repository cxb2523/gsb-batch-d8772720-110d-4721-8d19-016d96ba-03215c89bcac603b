import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import posthog from "posthog-js";
import { ThemeProvider, BaseStyles } from "@primer/react";
import { ReportProvider, useReport } from "@/components/report-provider";

// PostHog is mocked so no analytics leave the test process; assertions below
// verify it only ever receives the fixed slot/outcome enums.
vi.mock("posthog-js", () => ({
  default: { capture: vi.fn() },
}));

const PRIMARY_URL = "/preloaded-report.csv";
const COMPARISON_URL = "/preloaded-report-previous.csv";

const PRIMARY_CSV = [
  "date,product,sku,quantity",
  "2026-01-01,copilot,copilot_premium_request,5",
  "2026-01-02,copilot,copilot_premium_request,7",
  "2026-01-03,copilot,copilot_premium_request,9",
].join("\n");

const COMPARISON_CSV = [
  "date,product,sku,quantity",
  "2025-12-01,copilot,copilot_premium_request,3",
  "2025-12-02,copilot,copilot_premium_request,4",
].join("\n");

// A response that is OK and labelled CSV but cannot be parsed as a usage
// report because it has no date column.
const UNPARSEABLE_CSV = "foo,bar\n1,2\n";

function csvResponse(body: string, init?: ResponseInit): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/csv" },
    ...init,
  });
}

function htmlResponse(): Response {
  return new Response("<!doctype html><html><body>fallback</body></html>", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function notFoundResponse(): Response {
  return new Response("not found", { status: 404 });
}

/** Surfaces the provider's internal state as plain text for assertions. */
function ProbeReader() {
  const { report, comparisonReport, locked, loading, preloadOutcomes } = useReport();
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="locked">{String(locked)}</span>
      <span data-testid="report-rows">{report ? report.rowCount : "none"}</span>
      <span data-testid="comparison-rows">
        {comparisonReport ? comparisonReport.rowCount : "none"}
      </span>
      <span data-testid="primary-outcome">{preloadOutcomes.primary ?? "null"}</span>
      <span data-testid="comparison-outcome">{preloadOutcomes.comparison ?? "null"}</span>
    </div>
  );
}

function renderProvider() {
  return render(
    <ThemeProvider colorMode="day">
      <BaseStyles>
        <ReportProvider>
          <ProbeReader />
        </ReportProvider>
      </BaseStyles>
    </ThemeProvider>,
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
});

describe("ReportProvider preload probing", () => {
  it("loads and locks both reports on success and records a success per slot", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === COMPARISON_URL ? csvResponse(COMPARISON_CSV) : csvResponse(PRIMARY_CSV),
    );

    renderProvider();

    await waitFor(() =>
      expect(screen.getByTestId("primary-outcome")).toHaveTextContent("success"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("comparison-outcome")).toHaveTextContent("success"),
    );

    expect(screen.getByTestId("locked")).toHaveTextContent("true");
    expect(screen.getByTestId("report-rows")).toHaveTextContent("3");
    expect(screen.getByTestId("comparison-rows")).toHaveTextContent("2");
    expect(screen.getByTestId("loading")).toHaveTextContent("false");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, PRIMARY_URL, expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(2, COMPARISON_URL, expect.any(Object));

    expect(posthog.capture).toHaveBeenCalledWith("preloaded_report_probed", {
      slot: "primary",
      outcome: "success",
    });
    expect(posthog.capture).toHaveBeenCalledWith("preloaded_report_probed", {
      slot: "comparison",
      outcome: "success",
    });
  });

  it("falls back to upload mode, unlocked, on a 404 and never probes the comparison slot", async () => {
    fetchMock.mockResolvedValue(notFoundResponse());

    renderProvider();

    await waitFor(() =>
      expect(screen.getByTestId("primary-outcome")).toHaveTextContent("not_found"),
    );

    expect(screen.getByTestId("locked")).toHaveTextContent("false");
    expect(screen.getByTestId("report-rows")).toHaveTextContent("none");
    // The comparison slot is never probed when the primary report fails.
    expect(screen.getByTestId("comparison-outcome")).toHaveTextContent("null");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(PRIMARY_URL, expect.any(Object));
    expect(posthog.capture).toHaveBeenCalledTimes(1);
    expect(posthog.capture).toHaveBeenCalledWith("preloaded_report_probed", {
      slot: "primary",
      outcome: "not_found",
    });
  });

  it("classifies an HTML fallback page as not_csv and never probes the comparison slot", async () => {
    fetchMock.mockResolvedValue(htmlResponse());

    renderProvider();

    await waitFor(() =>
      expect(screen.getByTestId("primary-outcome")).toHaveTextContent("not_csv"),
    );

    expect(screen.getByTestId("locked")).toHaveTextContent("false");
    expect(screen.getByTestId("comparison-outcome")).toHaveTextContent("null");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(posthog.capture).toHaveBeenCalledWith("preloaded_report_probed", {
      slot: "primary",
      outcome: "not_csv",
    });
  });

  it("classifies an unparseable CSV as parse_failed and never probes the comparison slot", async () => {
    fetchMock.mockResolvedValue(csvResponse(UNPARSEABLE_CSV));

    renderProvider();

    await waitFor(() =>
      expect(screen.getByTestId("primary-outcome")).toHaveTextContent("parse_failed"),
    );

    expect(screen.getByTestId("locked")).toHaveTextContent("false");
    expect(screen.getByTestId("report-rows")).toHaveTextContent("none");
    expect(screen.getByTestId("comparison-outcome")).toHaveTextContent("null");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(posthog.capture).toHaveBeenCalledWith("preloaded_report_probed", {
      slot: "primary",
      outcome: "parse_failed",
    });
  });

  it("keeps the primary report loaded and locked when the comparison report 404s", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === COMPARISON_URL ? notFoundResponse() : csvResponse(PRIMARY_CSV),
    );

    renderProvider();

    await waitFor(() =>
      expect(screen.getByTestId("primary-outcome")).toHaveTextContent("success"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("comparison-outcome")).toHaveTextContent("not_found"),
    );

    expect(screen.getByTestId("locked")).toHaveTextContent("true");
    expect(screen.getByTestId("report-rows")).toHaveTextContent("3");
    expect(screen.getByTestId("comparison-rows")).toHaveTextContent("none");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(posthog.capture).toHaveBeenCalledWith("preloaded_report_probed", {
      slot: "comparison",
      outcome: "not_found",
    });
  });

  it("records not_csv for an HTML comparison response without disturbing the locked primary report", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === COMPARISON_URL ? htmlResponse() : csvResponse(PRIMARY_CSV),
    );

    renderProvider();

    await waitFor(() =>
      expect(screen.getByTestId("comparison-outcome")).toHaveTextContent("not_csv"),
    );
    expect(screen.getByTestId("primary-outcome")).toHaveTextContent("success");
    expect(screen.getByTestId("locked")).toHaveTextContent("true");
    expect(screen.getByTestId("comparison-rows")).toHaveTextContent("none");
  });

  it("records parse_failed for an unparseable comparison CSV without disturbing the primary report", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === COMPARISON_URL
        ? csvResponse(UNPARSEABLE_CSV)
        : csvResponse(PRIMARY_CSV),
    );

    renderProvider();

    await waitFor(() =>
      expect(screen.getByTestId("comparison-outcome")).toHaveTextContent("parse_failed"),
    );
    expect(screen.getByTestId("locked")).toHaveTextContent("true");
    expect(screen.getByTestId("report-rows")).toHaveTextContent("3");
  });

  it("aborts in-flight probes when unmounted", () => {
    const abortSpy = vi.spyOn(AbortController.prototype, "abort");
    fetchMock.mockReturnValue(new Promise(() => {}));

    const { unmount } = renderProvider();
    unmount();

    expect(abortSpy).toHaveBeenCalled();
    abortSpy.mockRestore();
  });

  it("only ever sends fixed slot/outcome enums to analytics - never CSV data or file names", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === COMPARISON_URL ? notFoundResponse() : csvResponse(PRIMARY_CSV),
    );

    renderProvider();
    await waitFor(() =>
      expect(screen.getByTestId("comparison-outcome")).toHaveTextContent("not_found"),
    );

    const calls = vi.mocked(posthog.capture).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [event, properties] of calls) {
      expect(event).toBe("preloaded_report_probed");
      expect(properties).toBeTruthy();
      const props = properties as Record<string, unknown>;
      expect(Object.keys(props).sort()).toEqual(["outcome", "slot"]);
      expect(["primary", "comparison"]).toContain(props.slot);
      expect([
        "success",
        "not_found",
        "not_csv",
        "parse_failed",
        "fetch_failed",
      ]).toContain(props.outcome);
      // No CSV contents, file names, or URLs may appear in the payload.
      expect(JSON.stringify(props)).not.toMatch(/\.csv|copilot|2026-|preloaded/i);
    }
  });
});
