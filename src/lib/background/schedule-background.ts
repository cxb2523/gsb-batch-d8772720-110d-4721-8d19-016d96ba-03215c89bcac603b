import { after } from "next/server";

export type BackgroundTask = () => Promise<void> | void;

/**
 * Schedules background work (e.g. cache warming, DB persistence) to run
 * after the HTTP response has been sent to the client.
 *
 * In Next.js / Vercel serverless environments, this delegates to Next.js's
 * native `after()` API to ensure the serverless function is not frozen
 * or terminated before the background task finishes.
 *
 * If called outside of a Next.js request context (such as during Vitest unit tests,
 * CLI scripts, or background workers), it gracefully executes the task immediately.
 *
 * @param task The synchronous or asynchronous function to execute in the background.
 */
export function scheduleBackground(task: BackgroundTask): void {
  try {
    after(task);
  } catch {
    // Fallback for non-request environments (e.g., tests, CLI runners)
    void task();
  }
}
