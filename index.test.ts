import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Both mocks are file-scoped, so they apply to every test below. That is harmless for the pure
// functions, which touch neither the network nor the disk, and it is what keeps the two suites
// that do touch them hermetic: no request leaves the machine, and the "global" settings path
// points somewhere that does not exist, so only the per-project file under test is ever read.
vi.mock("wreq-js", () => ({ fetch: vi.fn() }));
vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => join(tmpdir(), "pi-sws-no-agent-dir"),
  keyHint: (_binding: string, description: string) => `ctrl+o ${description}`,
  // Every element styled as itself, so assertions read the markdown rather than ANSI codes.
  getMarkdownTheme: () =>
    new Proxy({}, { get: () => (text: string) => text }) as Record<
      string,
      (text: string) => string
    >,
}));

import { visibleWidth } from "@earendil-works/pi-tui";
import { parseHTML } from "linkedom";
import { fetch } from "wreq-js";
import piSmartWebSearch, {
  buildSearchUrl,
  fetchReadablePage,
  fetchSearchWithRetry,
  hasFetchTools,
  keepFirstResults,
  loadResultsPerQuery,
  formatStatusBadge,
  renderProgressCard,
  readResultLinks,
  retryTimers,
  DEFAULT_RESULTS_PER_QUERY,
  MAX_RESULTS_PER_QUERY,
  MIN_RESULTS_PER_QUERY,
  type WebSearchDetails,
} from "./index.ts";
import { FETCH_TOOL_NAME, BATCH_FETCH_TOOL_NAME } from "./markdown.ts";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { QueryProgress, SearchResultLink } from "./markdown.ts";

/** The helpers below take a parsed document, matching how fetchReadablePage calls them. */
const parse = (html: string) => parseHTML(html).document;

/** A result anchor as DDG writes it, and the `div.result` wrapper that trimming targets. */
const anchor = (href: string, title: string) => `<a class="result__a" href="${href}">${title}</a>`;
const result = (href: string, title: string) => `<div class="result">${anchor(href, title)}</div>`;

describe("buildSearchUrl", () => {
  it("substitutes {query} with the URL-encoded query", () => {
    expect(buildSearchUrl("hello world")).toBe("https://html.duckduckgo.com/html/?q=hello%20world");
  });

  it("encodes reserved characters", () => {
    expect(buildSearchUrl("a&b=c?d")).toBe("https://html.duckduckgo.com/html/?q=a%26b%3Dc%3Fd");
  });

  it("fills the default DDG template", () => {
    expect(buildSearchUrl("rust traits")).toBe("https://html.duckduckgo.com/html/?q=rust%20traits");
  });
});

describe("readResultLinks", () => {
  it("extracts the title and redirect-unwrapped URL from a result anchor", () => {
    const html = anchor(
      "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x",
      "Example A",
    );
    expect(readResultLinks(parse(html))).toEqual([
      { title: "Example A", url: "https://example.com/a" },
    ]);
  });

  it("keeps a repeated destination URL, because DDG ranked it twice", () => {
    const html =
      anchor("//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.com", "One") +
      anchor("//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.com", "One again");
    expect(readResultLinks(parse(html))).toEqual([
      { title: "One", url: "https://a.com" },
      { title: "One again", url: "https://a.com" },
    ]);
  });

  it("returns every anchor the document still holds", () => {
    const html = Array.from({ length: 12 }, (_, i) => anchor(`https://s${i}.com`, `S${i}`)).join(
      "",
    );
    expect(readResultLinks(parse(html))).toHaveLength(12);
  });

  it("returns [] for a page with no result anchors", () => {
    expect(readResultLinks(parse("<div>no results here</div>"))).toEqual([]);
  });
});

describe("keepFirstResults", () => {
  const page = (count: number) =>
    parse(Array.from({ length: count }, (_, i) => result(`https://s${i}.com`, `S${i}`)).join(""));

  it("keeps the highest-ranked results and drops the rest", () => {
    const document = page(10);
    keepFirstResults(document, 3);
    expect(readResultLinks(document).map((link) => link.url)).toEqual([
      "https://s0.com",
      "https://s1.com",
      "https://s2.com",
    ]);
  });

  it("removes the surplus from the document, not just the link list", () => {
    const document = page(10);
    keepFirstResults(document, 4);
    expect(document.querySelectorAll("div.result")).toHaveLength(4);
  });

  it("leaves a page alone when it has fewer results than the count", () => {
    const document = page(2);
    keepFirstResults(document, 5);
    expect(readResultLinks(document)).toHaveLength(2);
  });

  it("leaves a page with no result elements alone", () => {
    const document = parse("<div>no results here</div>");
    keepFirstResults(document, 5);
    expect(document.querySelectorAll("div")).toHaveLength(1);
  });
});

function okEntry(query: string, links: SearchResultLink[], readableText = "body"): QueryProgress {
  return {
    query,
    status: "done",
    outcome: "success",
    result: {
      ok: true,
      outcome: "success",
      requestedUrl: "",
      finalUrl: "",
      title: "",
      readableText,
      links,
    },
  };
}

function failEntry(
  query: string,
  error: string,
  outcome: "rate-limited" | "http-error" | "fetch-error" = "http-error",
): QueryProgress {
  return {
    query,
    status: "error",
    outcome,
    result: { ok: false, outcome, requestedUrl: "", error },
  };
}

const stubTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

describe("progress card", () => {
  it("summarizes how many queries finished and how they ended", () => {
    const card = renderProgressCard([okEntry("a", []), failEntry("b", "x")], stubTheme, 80);
    expect(card).toContain("2/2 done · ok 1 · err 1");
  });

  it("centers a status label in a fixed-width badge", () => {
    expect(formatStatusBadge("done")).toBe("[   done    ]");
  });

  it("shows each finished query's outcome next to its badge", () => {
    const card = renderProgressCard(
      [
        okEntry("fine", []),
        failEntry("banned", "rate-limited by search engine (HTTP 202 soft-ban)", "rate-limited"),
        failEntry("broken", "HTTP 500 Server Error", "http-error"),
        failEntry("unreachable", "socket hang up", "fetch-error"),
      ],
      stubTheme,
      100,
    );
    const rows = card.split("\n");
    expect(rows[1]).toContain("success");
    expect(rows[2]).toContain("rate-limited · wait ~60s");
    expect(rows[3]).toContain("HTTP error");
    expect(rows[4]).toContain("network/parse error");
  });

  it("shows no outcome for a query that is still queued", () => {
    const queued: QueryProgress = { query: "later", status: "queued", result: undefined };
    const row = renderProgressCard([queued], stubTheme, 80).split("\n")[1] ?? "";
    expect(row).toContain("[  queued   ]");
    expect(row).not.toContain("·");
  });

  it("truncates a query too long for the terminal width", () => {
    const card = renderProgressCard([okEntry("x".repeat(200), [])], stubTheme, 40);
    const queryRow = card.split("\n")[1] ?? "";
    expect(queryRow).toContain("...");
    // Measured in columns: the row carries styling, and an escape sequence occupies none.
    expect(visibleWidth(queryRow)).toBeLessThanOrEqual(40);
  });

  // Narrow terminals squeeze the outcome label first, then drop it; the row must never
  // overflow its width, whatever the outcome.
  it("keeps every row within the terminal width, however narrow", () => {
    const entries = [
      okEntry("a query that is far too long to fit", []),
      failEntry("another long query here", "rate-limited", "rate-limited"),
      failEntry("a third long query", "HTTP 500", "http-error"),
      failEntry("a fourth long query", "boom", "fetch-error"),
      { query: "still waiting", status: "queued", result: undefined } as QueryProgress,
    ];
    for (const width of [24, 30, 40, 55]) {
      for (const line of renderProgressCard(entries, stubTheme, width).split("\n")) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("truncates the outcome label before letting a narrow row overflow", () => {
    const row =
      renderProgressCard([failEntry("q", "rate-limited", "rate-limited")], stubTheme, 24).split(
        "\n",
      )[1] ?? "";
    expect(visibleWidth(row)).toBeLessThanOrEqual(24);
    expect(row).toContain("[   error   ]");
  });

  it("renders an empty card instead of throwing when progressByQuery is undefined", () => {
    expect(renderProgressCard(undefined, stubTheme, 80)).toContain("0/0 done");
  });

  // A CJK character occupies two terminal columns, so eleven of them fill twenty-two.
  it("fits a row to the terminal in columns, not characters", () => {
    const wide = renderProgressCard([okEntry("日本語の検索クエリです", [])], stubTheme, 60);
    for (const line of wide.split("\n")) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(60);
    }
  });
});

describe("hasFetchTools", () => {
  it("is true when either fetch tool is registered", () => {
    expect(hasFetchTools(["read", FETCH_TOOL_NAME])).toBe(true);
    expect(hasFetchTools(["read", BATCH_FETCH_TOOL_NAME])).toBe(true);
    expect(hasFetchTools([FETCH_TOOL_NAME, BATCH_FETCH_TOOL_NAME])).toBe(true);
  });

  it("is false when the package is absent", () => {
    expect(hasFetchTools(["read", "web_search"])).toBe(false);
  });
});

// --- fetchReadablePage, against a mocked network ---

const mockFetch = vi.mocked(fetch);
type FetchResponse = Awaited<ReturnType<typeof fetch>>;

function response(opts: {
  status?: number;
  ok?: boolean;
  statusText?: string;
  url?: string;
  html?: string;
}): FetchResponse {
  return {
    status: opts.status ?? 200,
    ok: opts.ok ?? true,
    statusText: opts.statusText ?? "OK",
    url: opts.url ?? "https://html.duckduckgo.com/html/?q=x",
    text: () => Promise.resolve(opts.html ?? "<html></html>"),
  } as unknown as FetchResponse;
}

describe("fetchReadablePage", () => {
  beforeEach(() => mockFetch.mockReset());

  it("returns extracted text and result links on success", async () => {
    const html =
      '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=1">Result A</a>' +
      "<p>Some readable body content here.</p>";
    mockFetch.mockResolvedValue(response({ html }));

    const result = await fetchReadablePage("https://html.duckduckgo.com/html/?q=x", 10);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.links).toEqual([{ title: "Result A", url: "https://example.com/a" }]);
      expect(typeof result.readableText).toBe("string");
    }
  });

  it("keeps only resultsPerQuery results, in rank order", async () => {
    const html = Array.from(
      { length: 10 },
      (_, i) => `<div class="result"><a class="result__a" href="https://s${i}.com">S${i}</a></div>`,
    ).join("");
    mockFetch.mockResolvedValue(response({ html }));

    const result = await fetchReadablePage("https://html.duckduckgo.com/html/?q=x", 3);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.links.map((link) => link.url)).toEqual([
        "https://s0.com",
        "https://s1.com",
        "https://s2.com",
      ]);
    }
  });

  it("treats HTTP 202 as a rate-limit soft-ban", async () => {
    mockFetch.mockResolvedValue(response({ status: 202 }));
    const result = await fetchReadablePage("https://x", 10);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.outcome).toBe("rate-limited");
      expect(result.error).toMatch(/rate-limited/);
      expect(result.retryAfterSeconds).toBe(60);
    }
  });

  it("reports a non-2xx status as an HTTP error", async () => {
    mockFetch.mockResolvedValue(response({ ok: false, status: 500, statusText: "Server Error" }));
    const result = await fetchReadablePage("https://x", 10);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.outcome).toBe("http-error");
      expect(result.error).toBe("HTTP 500 Server Error");
    }
  });

  it("never throws -- a failure while reading the response comes back as a result", async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      statusText: "OK",
      url: "https://x",
      text: () => Promise.reject(new Error("network boom")),
    } as unknown as FetchResponse);
    const result = await fetchReadablePage("https://x", 10);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.outcome).toBe("fetch-error");
      expect(result.error).toBe("network boom");
    }
  });

  it("marks a good page as a success", async () => {
    mockFetch.mockResolvedValue(response({ html: "<p>readable</p>" }));
    const result = await fetchReadablePage("https://x", 10);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.outcome).toBe("success");
  });
});

// --- fetchSearchWithRetry: one retry for a soft ban, none for anything else ---

describe("fetchSearchWithRetry", () => {
  beforeEach(() => mockFetch.mockReset());

  /** A sleep that records how long it was asked to wait, without waiting. */
  function recordingSleep() {
    const waits: number[] = [];
    const sleep = (milliseconds: number) => {
      waits.push(milliseconds);
      return Promise.resolve();
    };
    return { waits, sleep };
  }

  it("returns a first-attempt success without waiting or retrying", async () => {
    mockFetch.mockResolvedValue(response({ html: "<p>fine</p>" }));
    const { waits, sleep } = recordingSleep();

    const result = await fetchSearchWithRetry("https://x", 10, sleep);

    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it("waits the suggested time, then retries a rate-limited query once", async () => {
    mockFetch
      .mockResolvedValueOnce(response({ status: 202 }))
      .mockResolvedValueOnce(response({ html: "<p>second try works</p>" }));
    const { waits, sleep } = recordingSleep();

    const result = await fetchSearchWithRetry("https://x", 10, sleep);

    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([60_000]);
  });

  it("records the rate-limited outcome when the retry is also soft-banned", async () => {
    mockFetch.mockResolvedValue(response({ status: 202 }));
    const { waits, sleep } = recordingSleep();

    const result = await fetchSearchWithRetry("https://x", 10, sleep);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.outcome).toBe("rate-limited");
    // One retry, not a loop: exactly two requests and one wait went out.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([60_000]);
  });

  it("does not retry an HTTP error", async () => {
    mockFetch.mockResolvedValue(response({ ok: false, status: 500, statusText: "Server Error" }));
    const { waits, sleep } = recordingSleep();

    const result = await fetchSearchWithRetry("https://x", 10, sleep);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.outcome).toBe("http-error");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it("does not retry a network or parsing failure", async () => {
    // The failure comes in as a response whose body read fails, the same shape the
    // fetchReadablePage tests use: a fetch() mock that itself rejects trips vitest's
    // mock-settlement tracking even though fetchReadablePage catches the rejection.
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      statusText: "OK",
      url: "https://x",
      text: () => Promise.reject(new Error("connection reset")),
    } as unknown as FetchResponse);
    const { waits, sleep } = recordingSleep();

    const result = await fetchSearchWithRetry("https://x", 10, sleep);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.outcome).toBe("fetch-error");
      expect(result.error).toBe("connection reset");
    }
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });
});

// --- loadResultsPerQuery, against real temp directories ---

/** Load resultsPerQuery for a throwaway project whose settings.json holds the given contents. */
function loadFrom(settingsJson: string): number {
  const dir = mkdtempSync(join(tmpdir(), "pi-sws-"));
  mkdirSync(join(dir, ".pi"));
  writeFileSync(join(dir, ".pi", "settings.json"), settingsJson);
  try {
    return loadResultsPerQuery(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The common case: a well-formed file configuring only `smartWebSearch`. */
const loadWith = (smartWebSearch: unknown) => loadFrom(JSON.stringify({ smartWebSearch }));

describe("loadResultsPerQuery", () => {
  it("falls back to the default when the project has no settings file", () => {
    expect(loadResultsPerQuery(join(tmpdir(), "pi-sws-nonexistent-project"))).toBe(
      DEFAULT_RESULTS_PER_QUERY,
    );
  });

  it("reads a configured value", () => {
    expect(loadWith({ resultsPerQuery: 8 })).toBe(8);
  });

  it("clamps a value above the maximum DDG returns", () => {
    expect(loadWith({ resultsPerQuery: 50 })).toBe(MAX_RESULTS_PER_QUERY);
  });

  it("clamps zero and negatives up to the minimum", () => {
    expect(loadWith({ resultsPerQuery: 0 })).toBe(MIN_RESULTS_PER_QUERY);
    expect(loadWith({ resultsPerQuery: -3 })).toBe(MIN_RESULTS_PER_QUERY);
  });

  it("floors a fractional value", () => {
    expect(loadWith({ resultsPerQuery: 4.7 })).toBe(4);
  });

  it("ignores a non-numeric value", () => {
    expect(loadWith({ resultsPerQuery: "many" })).toBe(DEFAULT_RESULTS_PER_QUERY);
  });

  it("ignores a section with no resultsPerQuery", () => {
    expect(loadWith({})).toBe(DEFAULT_RESULTS_PER_QUERY);
  });

  it("falls back to the default when the settings file is not valid JSON", () => {
    expect(loadFrom("{ not json")).toBe(DEFAULT_RESULTS_PER_QUERY);
  });
});

// --- The tool itself, registered against a stand-in for pi ---

/**
 * Run the extension's entry point against a stub ExtensionAPI and hand back what it registered.
 * execute, renderResult and the session_start handler are closures inside registerTool, so this
 * is the only way to reach them.
 */
function registerExtension(installedTools: string[] = [FETCH_TOOL_NAME, BATCH_FETCH_TOOL_NAME]) {
  const warnings: string[] = [];
  let tool!: Parameters<ExtensionAPI["registerTool"]>[0];
  let onSessionStart: ((event: unknown, ctx: unknown) => void) | undefined;

  const api = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
      if (event === "session_start") onSessionStart = handler;
    },
    registerTool: (definition: unknown) => {
      tool = definition as typeof tool;
    },
    getAllTools: () => installedTools.map((name) => ({ name })),
  } as unknown as ExtensionAPI;

  piSmartWebSearch(api);

  // registerTool types renderResult as optional; this extension always sets it.
  if (!tool.renderResult) throw new Error("tool did not register a result renderer");
  const { renderResult } = tool;

  const startSession = () =>
    onSessionStart?.({}, { ui: { notify: (message: string) => warnings.push(message) } });

  return { tool, renderResult, startSession, warnings };
}

describe("web_search execute", () => {
  beforeEach(() => mockFetch.mockReset());

  const resultsPage = (count: number) =>
    Array.from({ length: count }, (_, i) => result(`https://s${i}.com`, `S${i}`)).join("") +
    "<p>Some readable prose so the extractor has something to return.</p>";

  it("returns the rendered markdown for every query", async () => {
    mockFetch.mockResolvedValue(response({ html: resultsPage(3) }));
    const { tool } = registerExtension();

    const out = await tool.execute("call-1", { searches: ["one query"] }, undefined, undefined, {
      cwd: tmpdir(),
    } as never);

    const text = (out.content[0] as { text: string }).text;
    expect(text).toContain('## Query: "one query"');
    expect(text).toContain("# Read these pages");
  });

  it("says so in the text when a query failed", async () => {
    mockFetch.mockResolvedValue(response({ ok: false, status: 500, statusText: "Server Error" }));
    const { tool } = registerExtension();

    const out = await tool.execute("call-2", { searches: ["broken"] }, undefined, undefined, {
      cwd: tmpdir(),
    } as never);

    expect((out.content[0] as { text: string }).text).toContain(
      "_search failed: HTTP error (non-2xx response) -- HTTP 500 Server Error_",
    );
  });

  it("retries a rate-limited query once, after the suggested wait", async () => {
    // The retry wait is swapped for a spy so the test observes it instead of living through it.
    const waits: number[] = [];
    const sleepSpy = vi.spyOn(retryTimers, "sleep").mockImplementation((milliseconds: number) => {
      waits.push(milliseconds);
      return Promise.resolve();
    });
    mockFetch
      .mockResolvedValueOnce(response({ status: 202 }))
      .mockResolvedValueOnce(response({ html: resultsPage(2) }));
    const { tool } = registerExtension();

    try {
      const out = await tool.execute("call-retry", { searches: ["banned"] }, undefined, undefined, {
        cwd: tmpdir(),
      } as never);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(waits).toEqual([60_000]);
      const details = out.details as WebSearchDetails;
      expect(details.progressByQuery?.[0]?.outcome).toBe("success");
      expect((out.content[0] as { text: string }).text).toContain('## Query: "banned"');
    } finally {
      sleepSpy.mockRestore();
    }
  });

  it("records a rate-limited outcome when the retry is also soft-banned", async () => {
    const sleepSpy = vi.spyOn(retryTimers, "sleep").mockImplementation(() => Promise.resolve());
    mockFetch.mockResolvedValue(response({ status: 202 }));
    const { tool } = registerExtension();

    try {
      const out = await tool.execute(
        "call-banned",
        { searches: ["banned"] },
        undefined,
        undefined,
        {
          cwd: tmpdir(),
        } as never,
      );

      const details = out.details as WebSearchDetails;
      expect(details.progressByQuery?.[0]?.status).toBe("error");
      expect(details.progressByQuery?.[0]?.outcome).toBe("rate-limited");
      expect((out.content[0] as { text: string }).text).toContain(
        "_search failed: rate-limited by the search engine (HTTP 202 soft-ban)",
      );
      expect((out.content[0] as { text: string }).text).toContain(
        "wait ~60 seconds before retrying",
      );
    } finally {
      sleepSpy.mockRestore();
    }
  });

  it("records each query's outcome on its progress entry", async () => {
    mockFetch
      .mockResolvedValueOnce(response({ html: resultsPage(2) }))
      .mockResolvedValueOnce(response({ ok: false, status: 500, statusText: "Server Error" }));
    const { tool } = registerExtension();

    const out = await tool.execute(
      "call-outcomes",
      { searches: ["good", "bad"] },
      undefined,
      undefined,
      { cwd: tmpdir() } as never,
    );

    const entries = (out.details as WebSearchDetails).progressByQuery ?? [];
    expect(entries.map((entry) => entry.outcome)).toEqual(["success", "http-error"]);
  });

  it("reports progress so the card can animate, ending with every query finished", async () => {
    mockFetch.mockResolvedValue(response({ html: resultsPage(2) }));
    const { tool } = registerExtension();
    const statusesSeen: string[][] = [];

    await tool.execute(
      "call-3",
      { searches: ["alpha", "beta"] },
      undefined,
      (update) => {
        const seen = (update.details as WebSearchDetails | undefined)?.progressByQuery ?? [];
        statusesSeen.push(seen.map((entry) => entry.status));
      },
      { cwd: tmpdir() } as never,
    );

    expect(statusesSeen[0]).toEqual(["queued", "queued"]);
    expect(statusesSeen.at(-1)).toEqual(["done", "done"]);
  });

  it("carries the per-query details the card draws from", async () => {
    mockFetch.mockResolvedValue(response({ html: resultsPage(3) }));
    const { tool } = registerExtension();

    const out = await tool.execute("call-4", { searches: ["q"] }, undefined, undefined, {
      cwd: tmpdir(),
    } as never);

    const details = out.details as WebSearchDetails;
    expect(details.progressByQuery).toHaveLength(1);
    expect(details.progressByQuery?.[0]?.status).toBe("done");
  });
});

describe("web_search renderResult", () => {
  beforeEach(() => mockFetch.mockReset());

  /** Run a real search, then render its result the way the TUI would. */
  async function render(expanded: boolean) {
    mockFetch.mockResolvedValue(
      response({ html: `${result("https://a.com", "Result A")}<p>prose</p>` }),
    );
    const { tool, renderResult } = registerExtension();
    const out = await tool.execute("call", { searches: ["q"] }, undefined, undefined, {
      cwd: tmpdir(),
    } as never);

    const options = { expanded, isPartial: false } as Parameters<typeof renderResult>[1];
    return renderResult(out, options, stubTheme, {} as never)
      .render(80)
      .join("\n");
  }

  it("shows the card and points at the expand key when collapsed", async () => {
    const shown = await render(false);
    expect(shown).toContain("1/1 done");
    expect(shown).toContain("to show results");
    expect(shown).not.toContain("# Read these pages");
  });

  it("keeps the card and adds the model's markdown when expanded", async () => {
    const shown = await render(true);
    expect(shown).toContain("1/1 done");

    // A heading arrives styled, without its hashes, and a link becomes a terminal hyperlink
    // carrying the URL in an escape sequence.
    expect(shown).toContain("Search results by query");
    expect(shown).not.toContain("# Search results by query");
    expect(shown).toContain("Result A");
    expect(shown).toContain("https://a.com");
    expect(shown).not.toContain("[Result A](https://a.com)");
  });

  // The fetch tools put a blank line under their card, and these sit next to each other in a
  // transcript, so the gap is part of matching them.
  it("separates the card from what follows it, expanded or not", async () => {
    for (const expanded of [true, false]) {
      const lines = (await render(expanded)).split("\n");
      const lastCardLine = lines.findIndex((line) => line.includes("[   done    ]"));
      expect(lastCardLine).toBeGreaterThanOrEqual(0);
      expect(lines[lastCardLine + 1]?.trim()).toBe("");
    }
  });
});
