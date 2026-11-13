import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index.js";
import type { Env } from "../src/types.js";
import * as puppeteerLib from "../src/lib/puppeteer.js";
import { MAX_INTERACTION_OUTPUT_BYTES } from "../src/routes/interact.js";
import {
  MAX_INTERACTION_ERROR_BYTES,
  serializedByteLength,
} from "../src/lib/output-limit.js";

let screenshotResult = "base64-image";
let evaluateResult: unknown = null;
let evaluateError: Error | null = null;
let titleResult = "Updated";
let contentResult = "<html>updated</html>";
let clickFailures: Set<string>;
let navigationResolves: boolean;
let currentUrl: string;
let currentPage: ReturnType<typeof buildMockPage> | undefined;
// Per-test overrides consulted when a fresh mock page is built for a request.
let clickOverride: ((selector: string) => Promise<void> | void) | undefined;
let evaluateOverride: ((script: string) => unknown) | undefined;

function buildMockPage() {
  return {
    click: vi.fn(async (selector: string) => {
      if (clickOverride) return clickOverride(selector);
      if (clickFailures.has(selector)) {
        throw new Error(`No node found for selector: ${selector}`);
      }
    }),
    type: vi.fn(async () => {}),
    title: vi.fn(async () => titleResult),
    content: vi.fn(async () => contentResult),
    url: vi.fn(() => currentUrl),
    waitForNavigation: vi.fn(async () => {
      if (navigationResolves) {
        currentUrl = "https://example.com/thank-you";
        return {} as never;
      }
      // Mimic the real helper's timeout path: the promise rejects and the
      // caller's `.catch(() => false)` records no navigation.
      throw new Error("Navigation timeout of 10000 ms exceeded");
    }),
    waitForSelector: vi.fn(async () => null),
    setDefaultTimeout: vi.fn(),
    select: vi.fn(async () => []),
    screenshot: vi.fn(async () => screenshotResult),
    keyboard: {
      press: vi.fn(async () => {}),
    },
    evaluate: vi.fn(async (script: string) => {
      if (evaluateOverride) return evaluateOverride(script);
      if (evaluateError) throw evaluateError;
      if (script.includes("requestSubmit")) {
        return { ok: true, method: "requestSubmit" };
      }
      if (script.includes("document.title")) {
        return "Updated";
      }
      return evaluateResult;
    }),
  };
}

function makeKv(): KVNamespace {
  return {
    get: async () => null,
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
    put: async () => {},
    delete: async () => {},
    list: async () => ({ keys: [], list_complete: true, cursor: "", cacheStatus: null }),
  } as unknown as KVNamespace;
}

function makeR2(): R2Bucket {
  return {
    get: async () => null,
    put: async () => {},
    delete: async () => {},
    list: async () => ({ objects: [], truncated: false }),
    head: async () => null,
  } as unknown as R2Bucket;
}

function buildEnv(): Env {
  return {
    CF_ACCOUNT_ID: "test-account",
    CF_API_TOKEN: "test-token",
    API_KEYS: "valid-key",
    CACHE: makeKv(),
    RATE_LIMITER: { limit: async () => ({ success: true }) } as RateLimit,
    STORAGE: makeR2(),
  };
}

function authHeaders() {
  return { Authorization: "Bearer valid-key", "Content-Type": "application/json" };
}

async function postJson(path: string, body: unknown, env: Env) {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
    }),
    env,
  );
}

describe("interaction routes", () => {
  beforeEach(() => {
    screenshotResult = "base64-image";
    evaluateResult = null;
    evaluateError = null;
    titleResult = "Updated";
    contentResult = "<html>updated</html>";
    clickFailures = new Set();
    navigationResolves = false;
    currentUrl = "https://example.com/next";
    clickOverride = undefined;
    evaluateOverride = undefined;
    vi.spyOn(puppeteerLib, "withBrowser").mockImplementation(async (_env, _body, callback) => {
      const page = buildMockPage();
      currentPage = page;

      return callback({
        page: page as unknown as any,
        browser: {} as any,
      });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 400 when an interaction navigation is blocked", async () => {
    vi.spyOn(puppeteerLib, "withBrowser").mockRejectedValue(
      new puppeteerLib.BlockedNavigationError("URL resolves to a private or reserved IP address"),
    );
    for (const [path, payload] of [
      ["/click", { selector: "a" }],
      ["/type", { selector: "input", text: "hello" }],
      ["/evaluate", { script: "1 + 1" }],
      ["/interact", { actions: [{ action: "click", selector: "a" }] }],
      ["/submit-form", { fields: { "input[name=q]": "x" } }],
    ] as const) {
      const res = await postJson(path, { url: "https://example.com", ...payload }, buildEnv());
      expect(res.status, path).toBe(400);
      expect(await res.json()).toMatchObject({
        error: "URL resolves to a private or reserved IP address",
        status: 400,
      });
    }
  });

  it("POST /click returns page state", async () => {
    const res = await postJson("/click", { url: "https://example.com", selector: "a.next" }, buildEnv());
    expect(res.status).toBe(200);
    const body = await res.json<{ title: string; url: string }>();
    expect(body.title).toBe("Updated");
    expect(body.url).toBe("https://example.com/next");
  });

  it("POST /type returns page state after typing", async () => {
    const res = await postJson(
      "/type",
      { url: "https://example.com", selector: "#email", text: "user@example.com", clear: true },
      buildEnv(),
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ content: string }>();
    expect(body.content).toContain("updated");
  });

  it("rejects invalid interaction inputs before launching a browser", async () => {
    const withBrowser = vi.mocked(puppeteerLib.withBrowser);
    const cases = [
      ["/click", { url: "https://example.com", selector: "   " }],
      ["/type", { url: "https://example.com", selector: "#x", text: "x", clear: "yes" }],
      ["/evaluate", { url: "https://example.com", script: "   " }],
      ["/submit-form", { url: "https://example.com", fields: { "": "value" } }],
    ] as const;

    for (const [path, request] of cases) {
      const res = await postJson(path, request, buildEnv());
      expect(res.status).toBe(400);
    }
    expect(withBrowser).not.toHaveBeenCalled();
  });

  it("rejects Cloudflare-only options that local interaction routes cannot honor", async () => {
    const withBrowser = vi.mocked(puppeteerLib.withBrowser);
    const res = await postJson(
      "/click",
      {
        url: "https://example.com",
        selector: "#button",
        waitForTimeout: 1_000,
      },
      buildEnv(),
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("not supported by interaction endpoints");
    expect(withBrowser).not.toHaveBeenCalled();
  });

  it("POST /evaluate returns the script result", async () => {
    const res = await postJson(
      "/evaluate",
      { url: "https://example.com", script: "document.title" },
      buildEnv(),
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ result: string; type: string }>();
    expect(body.result).toBe("Updated");
    expect(body.type).toBe("string");
  });

  it("POST /evaluate fails closed before returning an oversized result", async () => {
    evaluateResult = "x".repeat(MAX_INTERACTION_OUTPUT_BYTES + 1);
    const res = await postJson(
      "/evaluate",
      { url: "https://example.com", script: "largeValue" },
      buildEnv(),
    );

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      error: "Interaction output byte limit exceeded",
    });
  });

  it("POST /evaluate bounds attacker-controlled error serialization", async () => {
    evaluateError = new Error("\0".repeat(MAX_INTERACTION_ERROR_BYTES * 2));
    const res = await postJson(
      "/evaluate",
      { url: "https://example.com", script: "throwLargeError()" },
      buildEnv(),
    );

    expect(res.status).toBe(500);
    const body = await res.json<{ error: string }>();
    expect(serializedByteLength(body.error)).toBeLessThanOrEqual(MAX_INTERACTION_ERROR_BYTES);
    expect(body.error.length).toBeLessThan(evaluateError.message.length);
  });

  it("POST /click fails closed before returning oversized page content", async () => {
    contentResult = "x".repeat(MAX_INTERACTION_OUTPUT_BYTES + 1);
    const res = await postJson(
      "/click",
      { url: "https://example.com", selector: "a.next" },
      buildEnv(),
    );

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      error: "Interaction output byte limit exceeded",
    });
  });

  it("POST /interact executes action chains", async () => {
    const res = await postJson(
      "/interact",
      {
        url: "https://example.com",
        actions: [
          { action: "type", selector: "#email", text: "user@example.com", clear: true },
          { action: "click", selector: "button[type='submit']" },
          { action: "evaluate", script: "document.title" },
        ],
      },
      buildEnv(),
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ results: Array<{ action: string; ok: boolean }> }>();
    expect(body.results).toEqual([
      { action: "type", ok: true },
      { action: "click", ok: true },
      { action: "evaluate", ok: true, result: "Updated" },
    ]);
  });

  it("POST /interact stops before returning an oversized base64 screenshot", async () => {
    screenshotResult = "x".repeat(MAX_INTERACTION_OUTPUT_BYTES + 1);
    const res = await postJson(
      "/interact",
      {
        url: "https://example.com",
        actions: [
          { action: "screenshot" },
          { action: "click", selector: "#should-not-run" },
        ],
      },
      buildEnv(),
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ results: Array<Record<string, unknown>> }>();
    expect(body.results).toEqual([{
      action: "screenshot",
      ok: false,
      error: "Interaction output byte limit exceeded",
    }]);
  });

  it("POST /interact applies the byte limit cumulatively to evaluate results", async () => {
    evaluateResult = "x".repeat(Math.floor(MAX_INTERACTION_OUTPUT_BYTES / 2));
    const res = await postJson(
      "/interact",
      {
        url: "https://example.com",
        actions: [
          { action: "evaluate", script: "largeValue" },
          { action: "evaluate", script: "largeValue" },
          { action: "click", selector: "#should-not-run" },
        ],
      },
      buildEnv(),
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ results: Array<Record<string, unknown>> }>();
    expect(body.results).toHaveLength(2);
    expect(body.results[0]).toMatchObject({ action: "evaluate", ok: true });
    expect(body.results[1]).toEqual({
      action: "evaluate",
      ok: false,
      error: "Interaction output byte limit exceeded",
    });
  });

  it("POST /interact bounds errors before appending them to action results", async () => {
    evaluateError = new Error("x".repeat(MAX_INTERACTION_ERROR_BYTES * 2));
    const res = await postJson(
      "/interact",
      {
        url: "https://example.com",
        actions: [{ action: "evaluate", script: "throwLargeError()" }],
      },
      buildEnv(),
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ results: Array<{ error?: string }> }>();
    expect(serializedByteLength(body.results[0]?.error)).toBeLessThanOrEqual(
      MAX_INTERACTION_ERROR_BYTES,
    );
  });

  it("POST /interact bounds the complete response envelope", async () => {
    titleResult = "x".repeat(MAX_INTERACTION_OUTPUT_BYTES + 1);
    const res = await postJson(
      "/interact",
      {
        url: "https://example.com",
        actions: [{ action: "click", selector: "#button" }],
      },
      buildEnv(),
    );

    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(
      MAX_INTERACTION_OUTPUT_BYTES,
    );
  });

  it("POST /interact rejects malformed actions before launching a browser", async () => {
    const withBrowser = vi.mocked(puppeteerLib.withBrowser);
    const res = await postJson(
      "/interact",
      { url: "https://example.com", actions: [null, { action: "type", selector: "#x" }] },
      buildEnv(),
    );
    expect(res.status).toBe(400);
    expect(withBrowser).not.toHaveBeenCalled();
  });

  it("POST /submit-form uses requestSubmit-compatible fallback", async () => {
    const res = await postJson(
      "/submit-form",
      {
        url: "https://example.com/form",
        fields: {
          "#email": "user@example.com",
          "#password": "secret",
        },
      },
      buildEnv(),
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ title: string; fields: Array<{ status: string }> }>();
    expect(body.title).toBe("Updated");
    expect(body.fields.every((entry) => entry.status === "filled")).toBe(true);
  });

  it("POST /submit-form reports every filled field and first-form submission on full success", async () => {
    navigationResolves = true;
    const res = await postJson(
      "/submit-form",
      {
        url: "https://example.com/form",
        fields: {
          "#email": "user@example.com",
          "#password": "secret",
        },
      },
      buildEnv(),
    );

    expect(res.status).toBe(200);
    const body = await res.json<{
      fields: Array<{ selector: string; status: string; error?: string }>;
      submission: {
        attempted: boolean;
        trigger: string;
        navigation_observed: boolean;
        error?: string;
      };
      url: string;
    }>();
    expect(body.fields).toEqual([
      { selector: "#email", status: "filled" },
      { selector: "#password", status: "filled" },
    ]);
    expect(body.submission).toMatchObject({
      attempted: true,
      trigger: "first_form",
      navigation_observed: true,
    });
    expect(body.submission.error).toBeUndefined();
    expect(body.url).toBe("https://example.com/thank-you");
    expect(currentPage?.evaluate).toHaveBeenCalledTimes(1);
  });

  it("POST /submit-form continues filling remaining fields when continue_on_error is true", async () => {
    clickFailures.add("#missing");
    navigationResolves = true;
    const res = await postJson(
      "/submit-form",
      {
        url: "https://example.com/form",
        continue_on_error: true,
        fields: {
          "#email": "user@example.com",
          "#missing": "nope",
          "#password": "secret",
        },
        submit_selector: "button[type=submit]",
      },
      buildEnv(),
    );

    expect(res.status).toBe(200);
    const body = await res.json<{
      fields: Array<{ selector: string; status: string; error?: string }>;
      submission: {
        attempted: boolean;
        trigger: string;
        navigation_observed: boolean;
      };
    }>();
    expect(body.fields).toHaveLength(3);
    expect(body.fields[0]).toEqual({ selector: "#email", status: "filled" });
    expect(body.fields[1]).toMatchObject({
      selector: "#missing",
      status: "failed",
    });
    expect(body.fields[1]?.error).toContain("#missing");
    expect(body.fields[2]).toEqual({ selector: "#password", status: "filled" });
    // All three selectors were attempted despite the middle failure.
    expect(currentPage?.click).toHaveBeenCalledWith("button[type=submit]");
    expect(body.submission).toMatchObject({
      attempted: true,
      trigger: "submit_selector",
      navigation_observed: true,
    });
  });

  it("POST /submit-form returns an error status and never submits when every field fails", async () => {
    clickFailures.add("#a");
    clickFailures.add("#b");
    const res = await postJson(
      "/submit-form",
      {
        url: "https://example.com/form",
        continue_on_error: true,
        fields: { "#a": "1", "#b": "2" },
        submit_selector: "button[type=submit]",
      },
      buildEnv(),
    );

    expect(res.status).toBe(500);
    const body = await res.json<{
      error: string;
      fields: Array<{ selector: string; status: string; error?: string }>;
      submission: { attempted: boolean; navigation_observed: boolean };
    }>();
    expect(body.error).toMatch(/not submitted/);
    expect(body.fields).toHaveLength(2);
    expect(body.fields.every((entry) => entry.status === "failed")).toBe(true);
    expect(body.fields[0]?.error).toContain("#a");
    expect(body.submission).toEqual({ attempted: false, navigation_observed: false });
    // The submit button must never be clicked when no field was filled.
    const submitCalls = vi.mocked(currentPage!.click).mock.calls
      .filter(([selector]) => selector === "button[type=submit]");
    expect(submitCalls).toHaveLength(0);
  });

  it("POST /submit-form aborts at the first failure by default and skips the submit", async () => {
    clickFailures.add("#missing");
    const res = await postJson(
      "/submit-form",
      {
        url: "https://example.com/form",
        fields: {
          "#email": "user@example.com",
          "#missing": "nope",
          "#password": "secret",
        },
      },
      buildEnv(),
    );

    expect(res.status).toBe(200);
    const body = await res.json<{
      fields: Array<{ selector: string; status: string; error?: string }>;
      submission: { attempted: boolean; trigger?: string; error?: string };
    }>();
    expect(body.fields[0]).toEqual({ selector: "#email", status: "filled" });
    expect(body.fields[1]).toMatchObject({ selector: "#missing", status: "failed" });
    expect(body.fields[2]).toMatchObject({
      selector: "#password",
      status: "failed",
      error: "Skipped after an earlier field failure",
    });
    expect(body.submission.attempted).toBe(false);
    expect(body.submission.trigger).toBeUndefined();
    expect(body.submission.error).toMatch(/skipped/i);
    // Neither the remaining field nor the form submission was attempted.
    const selectorsClicked = vi.mocked(currentPage!.click).mock.calls.map(([selector]) => selector);
    expect(selectorsClicked).not.toContain("#password");
    expect(currentPage?.evaluate).not.toHaveBeenCalled();
  });

  it("POST /submit-form records no navigation when the submit does not navigate", async () => {
    const res = await postJson(
      "/submit-form",
      {
        url: "https://example.com/form",
        fields: { "#email": "user@example.com" },
        submit_selector: "button.save",
      },
      buildEnv(),
    );

    expect(res.status).toBe(200);
    const body = await res.json<{
      submission: { attempted: boolean; navigation_observed: boolean; trigger: string };
    }>();
    expect(body.submission).toMatchObject({
      attempted: true,
      trigger: "submit_selector",
      navigation_observed: false,
    });
  });

  it("POST /submit-form reports a submission error when the page has no form", async () => {
    evaluateOverride = (script: string) => {
      if (script.includes("requestSubmit")) {
        return { ok: false, error: "No form found on page" };
      }
      return evaluateResult;
    };
    const res = await postJson(
      "/submit-form",
      { url: "https://example.com/form", fields: { "#email": "user@example.com" } },
      buildEnv(),
    );

    expect(res.status).toBe(200);
    const body = await res.json<{
      fields: Array<{ status: string }>;
      submission: {
        attempted: boolean;
        trigger: string;
        navigation_observed: boolean;
        error?: string;
      };
    }>();
    expect(body.fields).toEqual([{ selector: "#email", status: "filled" }]);
    expect(body.submission).toMatchObject({
      attempted: true,
      trigger: "first_form",
      navigation_observed: false,
      error: "No form found on page",
    });
  });

  it("POST /submit-form still returns 200 with per-field detail when a submit click throws", async () => {
    clickOverride = async (selector: string) => {
      if (selector === "button.broken") {
        throw new Error("Submit button is not clickable");
      }
    };
    const res = await postJson(
      "/submit-form",
      {
        url: "https://example.com/form",
        fields: { "#email": "user@example.com" },
        submit_selector: "button.broken",
      },
      buildEnv(),
    );

    expect(res.status).toBe(200);
    const body = await res.json<{
      fields: Array<{ status: string }>;
      submission: { attempted: boolean; error?: string; navigation_observed: boolean };
    }>();
    expect(body.fields).toEqual([{ selector: "#email", status: "filled" }]);
    expect(body.submission.attempted).toBe(true);
    expect(body.submission.error).toContain("not clickable");
    expect(body.submission.navigation_observed).toBe(false);
  });

  it("POST /submit-form rejects a non-boolean continue_on_error", async () => {
    const withBrowser = vi.mocked(puppeteerLib.withBrowser);
    const res = await postJson(
      "/submit-form",
      {
        url: "https://example.com/form",
        fields: { "#email": "x" },
        continue_on_error: "yes",
      },
      buildEnv(),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("continue_on_error must be a boolean");
    expect(withBrowser).not.toHaveBeenCalled();
  });

  it("POST /submit-form maps a missing browser binding to 501", async () => {
    vi.spyOn(puppeteerLib, "withBrowser").mockRejectedValue(
      new puppeteerLib.BrowserBindingUnavailable(),
    );
    const res = await postJson(
      "/submit-form",
      { url: "https://example.com/form", fields: { "#email": "x" } },
      buildEnv(),
    );
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({ status: 501 });
  });

  it("POST /submit-form fails closed with 502 when the result exceeds the output limit", async () => {
    contentResult = "x".repeat(MAX_INTERACTION_OUTPUT_BYTES + 1);
    const res = await postJson(
      "/submit-form",
      { url: "https://example.com/form", fields: { "#email": "x" } },
      buildEnv(),
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      error: "Interaction output byte limit exceeded",
    });
  });
});
