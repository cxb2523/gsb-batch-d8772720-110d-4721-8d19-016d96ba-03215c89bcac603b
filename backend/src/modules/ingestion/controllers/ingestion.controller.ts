import type { Request, Response } from "express";
import {
  runAllScrapers,
  startBackgroundScraperRun,
  RunInProgressError,
} from "../services/ingestion.service.ts";
import { getLatestRun, getRun } from "../services/runRegistry.ts";

/**
 * POST /refresh — run every scraper synchronously and return the full,
 * auditable run summary. HTTP 200 is returned even when individual
 * platforms failed; failures are reported honestly in the summary. A 409 is
 * only returned when another run is already in progress.
 */
export const refreshHackathons = async (req: Request, res: Response) => {
  let summary;
  try {
    summary = await runAllScrapers();
  } catch (error) {
    if (error instanceof RunInProgressError) {
      return res.status(409).json({
        success: false,
        message: "已在运行 / A scraper run is already in progress",
        runId: error.runId,
      });
    }
    throw error;
  }

  return res.status(200).json({
    success: summary.failed === 0,
    message:
      summary.failed === 0
        ? "Hackathons refreshed successfully"
        : `Refresh finished with ${summary.failed} failed platform(s)`,
    data: summary,
  });
};

/**
 * POST /cron/trigger — accept the request immediately and run the scrapers
 * in the background. The returned run id can be polled via the status
 * endpoint. Only one background run is allowed at a time; a duplicate
 * trigger is answered with "already running" (carrying the active run id)
 * and never starts a second run.
 */
export const triggerScraperCron = async (req: Request, res: Response) => {
  let runId: string;
  try {
    runId = startBackgroundScraperRun();
  } catch (error) {
    if (error instanceof RunInProgressError) {
      return res.status(200).json({
        success: false,
        message: "已在运行 / A scraper run is already in progress",
        runId: error.runId,
        status: "running",
      });
    }
    throw error;
  }

  return res.status(200).json({
    success: true,
    message: "Cron job accepted and started",
    runId,
    status: "running",
  });
};

/**
 * GET /runs/latest and GET /runs/:runId — query the status (running /
 * completed) and full summary of the latest or a specific run. Unknown run
 * ids respond with 404.
 */
export const getScraperRunStatus = async (req: Request, res: Response) => {
  const requestedId = req.params.runId;
  const run =
    requestedId === undefined || requestedId === "latest"
      ? getLatestRun()
      : getRun(requestedId);

  if (run === null) {
    return res.status(404).json({
      success: false,
      message: requestedId
        ? `No scraper run found for id '${requestedId}'`
        : "No scraper runs recorded yet",
    });
  }

  return res.status(200).json({
    success: true,
    data: run,
  });
};
