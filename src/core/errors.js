/**
 * axuse — typed error model.
 *
 * Lineage: ZCode's typed CUA errors (STALE_STATE / ELEMENT_UNAVAILABLE /
 * sideEffect:"none"|"uncertain" / actionSent / retry hints). A blind
 * `throw new Error(...)` loses exactly the information an agent loop needs
 * to decide "retry, re-observe, or give up" — so every failure here is a
 * structured fact, not a string.
 */

/** Error codes are a frozen vocabulary shared by core, MCP layer and docs. */
export const Codes = Object.freeze({
  COMMAND_REJECTED: "COMMAND_REJECTED", // bad params — fix the call, do not retry as-is
  LAUNCH_FAILED: "LAUNCH_FAILED",
  ATTACH_FAILED: "ATTACH_FAILED",
  NO_BROWSER: "NO_BROWSER", // nothing open yet → ax_open first
  NO_TAB: "NO_TAB",
  REF_NOT_FOUND: "REF_NOT_FOUND", // ref is from a stale observation → re-observe
  STALE_STATE: "STALE_STATE", // caller state_id predates current page state → re-observe
  ELEMENT_HIDDEN: "ELEMENT_HIDDEN",
  BAD_COORDS: "BAD_COORDS",
  DIALOG_OPEN: "DIALOG_OPEN", // a JS dialog is blocking → ax_dialog
  SCREENSHOT_BUDGET_EXCEEDED: "SCREENSHOT_BUDGET_EXCEEDED",
  EVALUATE_FAILED: "EVALUATE_FAILED",
  TIMEOUT: "TIMEOUT",
  NAVIGATION_IN_PROGRESS: "NAVIGATION_IN_PROGRESS",
  DESKTOP_DRIVER_UNAVAILABLE: "DESKTOP_DRIVER_UNAVAILABLE",
  DESKTOP_OP_FAILED: "DESKTOP_OP_FAILED",
  DESKTOP_PERMISSION_REQUIRED: "DESKTOP_PERMISSION_REQUIRED",
  PLUGIN_LOAD_FAILED: "PLUGIN_LOAD_FAILED", // a plugin dir failed to load — fix the plugin, not the call
  NO_SOLVER: "NO_SOLVER", // no loaded plugin solves this provider → install one
  SOLVER_FAILED: "SOLVER_FAILED", // a solver ran and gave up — see its result facts
  INTERNAL: "INTERNAL",
});

/** What the agent should do after a failure. */
export const Retry = Object.freeze({
  REOBSERVE: "reobserve", // state changed under you — call ax_observe, then re-plan
  RETRY: "retry", // same call will likely succeed now
  NEVER: "never", // fix inputs or give up
});

/** Whether a side-effecting action definitely reached the page. */
export const ActionSent = Object.freeze({
  SENT: "sent",
  POSSIBLY_SENT: "possibly_sent", // dispatch timed out after send — state unknown
  NOT_SENT: "not_sent",
});

export class AxError extends Error {
  /**
   * @param {keyof typeof Codes} code
   * @param {string} message
   * @param {{hint?: string, retry?: keyof typeof Retry, sideEffect?: "none"|"uncertain", facts?: object}} [extra]
   *   facts: extra machine-readable fields surfaced verbatim (e.g. tab_id of
   *   a tab the failed call created, so the caller can still close it).
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "AxError";
    this.code = code;
    this.hint = extra.hint;
    this.retry = extra.retry;
    this.sideEffect = extra.sideEffect ?? "none";
    if (extra.facts) this.facts = extra.facts;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.retry ? { retry: this.retry } : {}),
      side_effect: this.sideEffect,
      ...(this.facts ?? {}),
    };
  }
}

/** Convenience: throw a typed error. */
export function fail(code, message, extra) {
  throw new AxError(code, message, extra);
}
