import cron from "node-cron";
import { runAllScrapers, RunInProgressError } from "../../modules/ingestion/index.ts";

cron.schedule("0 3 * * *", async () => {
  console.log("[CRON] Starting nightly refresh at 3:00 AM");
  try {
    const summary = await runAllScrapers();
    console.log(
      `[CRON] Nightly refresh complete (runId=${summary.runId}): ${summary.successful} succeeded, ${summary.failed} failed, cacheInvalidated=${summary.cacheInvalidated}`,
    );
  } catch (error) {
    if (error instanceof RunInProgressError) {
      console.warn(
        `[CRON] Nightly refresh skipped because another run is active (runId=${error.runId})`,
      );
    } else {
      console.error("[CRON] Nightly refresh failed unexpectedly:", error);
    }
  }
});
