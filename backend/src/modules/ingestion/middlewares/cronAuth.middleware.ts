import type { RequestHandler } from "express";
import { getCronSecret } from "../../../shared/constants/constants.ts";

/**
 * Guards the scraper orchestration endpoints. Requests must carry the
 * `x-cron-secret` header matching the configured cron secret; any missing
 * or mismatching secret is rejected with HTTP 401.
 */
export const requireCronSecret: RequestHandler = (req, res, next) => {
  const secret = req.headers["x-cron-secret"];
  if (typeof secret !== "string" || secret !== getCronSecret()) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  return next();
};
