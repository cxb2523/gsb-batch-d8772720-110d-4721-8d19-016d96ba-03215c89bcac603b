"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import posthog from "posthog-js";
import { parseUsageCsvText, type ParsedReport } from "@/lib/report";
import {
  probePreloadedReport,
  type PreloadOutcome,
  type PreloadSlot,
} from "@/lib/preload";

/**
 * Optional report shipped with the build. Drop a CSV at
 * `public/preloaded-report.csv` and it is fetched on load, parsed, and locked
 * so users cannot upload, replace, or clear it. Absent the file, the app
 * behaves normally. The base path keeps the URL correct under GitHub Pages.
 *
 * A second optional CSV at `public/preloaded-report-previous.csv` is loaded as
 * the previous-month comparison report when (and only when) the primary
 * preloaded report is present; it is locked the same way.
 */
const PRELOADED_REPORT_FILE = "preloaded-report.csv";
const PRELOADED_REPORT_URL = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/${PRELOADED_REPORT_FILE}`;
const PRELOADED_COMPARISON_FILE = "preloaded-report-previous.csv";
const PRELOADED_COMPARISON_URL = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/${PRELOADED_COMPARISON_FILE}`;

/** Per-slot probe outcomes; null means that slot has not been probed yet. */
export interface PreloadOutcomes {
  primary: PreloadOutcome | null;
  comparison: PreloadOutcome | null;
}

interface ReportContextValue {
  report: ParsedReport | null;
  setReport: (report: ParsedReport | null) => void;
  clearReport: () => void;
  /**
   * Optional previous-period report used for month-over-month comparison.
   * Like {@link report}, it is held in memory on the client only and never
   * persisted or sent anywhere.
   */
  comparisonReport: ParsedReport | null;
  setComparisonReport: (report: ParsedReport | null) => void;
  clearComparisonReport: () => void;
  /**
   * True when the report was preloaded with the build. In this mode the user
   * cannot upload, replace, or clear the report.
   */
  locked: boolean;
  /** True while the optional preloaded report is being probed on first load. */
  loading: boolean;
  /**
   * How each preloaded-slot probe ended. Every probe records a fixed enum
   * outcome (see {@link PreloadOutcome}) so failures are never silent; only
   * these non-sensitive enums are ever logged or sent to analytics.
   */
  preloadOutcomes: PreloadOutcomes;
}

const ReportContext = createContext<ReportContextValue | null>(null);

/**
 * Record a probe ending. Privacy: the payload contains only the two fixed
 * enums `slot` and `outcome` - never the CSV contents, a file name, a URL, or
 * any per-user data.
 */
function recordProbeOutcome(slot: PreloadSlot, outcome: PreloadOutcome): void {
  posthog.capture("preloaded_report_probed", { slot, outcome });
}

/**
 * Holds the parsed usage report in memory on the client only.
 * The data never leaves the browser and is not persisted server-side.
 *
 * On mount it probes for an optional preloaded report (see
 * {@link PRELOADED_REPORT_URL}); if present, that report is loaded and locked.
 * Every probe records a classified outcome (see {@link probePreloadedReport})
 * that is surfaced in the UI instead of silently falling back.
 */
export function ReportProvider({ children }: { children: React.ReactNode }) {
  const [report, setReport] = useState<ParsedReport | null>(null);
  const [comparisonReport, setComparisonReport] = useState<ParsedReport | null>(null);
  const [locked, setLocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [preloadOutcomes, setPreloadOutcomes] = useState<PreloadOutcomes>({
    primary: null,
    comparison: null,
  });

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        // Primary slot. Any non-success ending leaves the app in normal upload
        // mode, unlocked, exactly as before - but now with a recorded, visible
        // outcome instead of a silent fallback.
        const primary = await probePreloadedReport<ParsedReport>(
          "primary",
          PRELOADED_REPORT_URL,
          {
            signal: controller.signal,
            parse: (text) => parseUsageCsvText(text, PRELOADED_REPORT_FILE),
          },
        );
        setPreloadOutcomes((prev) => ({ ...prev, primary: primary.outcome }));
        recordProbeOutcome("primary", primary.outcome);

        if (primary.outcome !== "success" || !primary.report) {
          // No usable preloaded report: normal upload mode, never locked. The
          // comparison slot is deliberately never probed in this case.
          return;
        }
        setReport(primary.report);
        setLocked(true);

        // Only probe for the optional previous-month report once the primary
        // preloaded report is in place; a comparison without a primary report
        // has nothing to compare against. Its outcome never changes the locked
        // state of the primary report.
        const comparison = await probePreloadedReport<ParsedReport>(
          "comparison",
          PRELOADED_COMPARISON_URL,
          {
            signal: controller.signal,
            parse: (text) => parseUsageCsvText(text, PRELOADED_COMPARISON_FILE),
          },
        );
        setPreloadOutcomes((prev) => ({ ...prev, comparison: comparison.outcome }));
        recordProbeOutcome("comparison", comparison.outcome);
        if (comparison.outcome === "success" && comparison.report) {
          setComparisonReport(comparison.report);
        }
      } catch {
        // Aborted on unmount (the finally skips state updates); nothing else
        // escapes probePreloadedReport, which classifies its own failures.
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  const value = useMemo<ReportContextValue>(
    () => ({
      report,
      // In locked mode the report is fixed; ignore attempts to change it.
      setReport: locked
        ? () => {}
        : (next) => {
            setReport(next);
            // Clearing or replacing the primary report drops the comparison so
            // the two never get out of sync.
            if (!next) setComparisonReport(null);
          },
      clearReport: locked
        ? () => {}
        : () => {
            setReport(null);
            setComparisonReport(null);
          },
      comparisonReport,
      setComparisonReport: locked ? () => {} : setComparisonReport,
      clearComparisonReport: locked ? () => {} : () => setComparisonReport(null),
      locked,
      loading,
      preloadOutcomes,
    }),
    [report, comparisonReport, locked, loading, preloadOutcomes],
  );

  return <ReportContext.Provider value={value}>{children}</ReportContext.Provider>;
}

export function useReport(): ReportContextValue {
  const ctx = useContext(ReportContext);
  if (!ctx) {
    throw new Error("useReport must be used within a ReportProvider");
  }
  return ctx;
}
