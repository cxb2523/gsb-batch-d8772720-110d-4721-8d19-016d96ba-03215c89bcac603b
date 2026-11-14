import { describe, expect, it, vi } from "vitest";
import { SpidraClient } from "../client.js";
import { HttpClient } from "../lib/http.js";
import { CrawlResource } from "../resources/crawl.js";
import { catchError, jsonResponse, sequenceFetch } from "./helpers.js";

const POLL = { pollInterval: 1 };

function makeClient(fetchImpl: typeof fetch) {
  return new SpidraClient({ apiKey: "spd_test", baseUrl: "https://api.test", fetch: fetchImpl, backoffFactor: 1 });
}

/** The crawl resource on its own, so `allPages()` can be exercised without submitting a job. */
function makeCrawl(fetchImpl: typeof fetch) {
  return new CrawlResource(
    new HttpClient({ apiKey: "spd_test", baseUrl: "https://api.test", fetch: fetchImpl, backoffFactor: 1 })
  );
}

/** A crawl page as `/crawl/:jobId/pages` returns it, with `data` as JSON text like the API stores it. */
function page(n: number) {
  return {
    id: `p${n}`,
    url: `https://x.com/${n}`,
    status: "success" as const,
    data: JSON.stringify({ n }),
    error_message: null,
    html: null,
    markdown: null,
    created_at: "",
  };
}

/** `count` pages starting after `from`, so ids and numbers stay unique across batches. */
function pages(from: number, count: number) {
  return Array.from({ length: count }, (_, i) => page(from + i));
}

function batch(body: Record<string, unknown>) {
  return jsonResponse(200, body);
}

/** URLs of every `pages` request fetch saw, in call order. */
function pagesUrls(fetchMock: ReturnType<typeof sequenceFetch>) {
  return fetchMock.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.includes("/pages"));
}

describe("allPages", () => {
  it("keeps reading batches until an empty one when the response has no pagination metadata", async () => {
    const fetchMock = sequenceFetch(
      batch({ pages: pages(0, 1000) }),
      batch({ pages: pages(1000, 1000) }),
      batch({ pages: [] })
    );
    const crawl = makeCrawl(fetchMock);

    const result = await crawl.allPages("big");

    expect(result).toHaveLength(2000);
    expect(result[0].id).toBe("p0");
    expect(result[1999].id).toBe("p1999");
    expect(pagesUrls(fetchMock)).toEqual([
      "https://api.test/crawl/big/pages?offset=0&limit=1000",
      "https://api.test/crawl/big/pages?offset=1000&limit=1000",
      "https://api.test/crawl/big/pages?offset=2000&limit=1000",
    ]);
  });

  it("stops after a short batch instead of asking for another one", async () => {
    const fetchMock = sequenceFetch(batch({ pages: pages(0, 300) }));
    const crawl = makeCrawl(fetchMock);

    const result = await crawl.allPages("short");

    expect(result).toHaveLength(300);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pagesUrls(fetchMock)).toEqual(["https://api.test/crawl/short/pages?offset=0&limit=1000"]);
  });

  it("stops exactly at `total` without an out-of-range request", async () => {
    const fetchMock = sequenceFetch(
      batch({ pages: pages(0, 1000), total: 1500 }),
      batch({ pages: pages(1000, 500), total: 1500 })
    );
    const crawl = makeCrawl(fetchMock);

    const result = await crawl.allPages("total");

    expect(result).toHaveLength(1500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pagesUrls(fetchMock)).toEqual([
      "https://api.test/crawl/total/pages?offset=0&limit=1000",
      "https://api.test/crawl/total/pages?offset=1000&limit=1000",
    ]);
  });

  it("reports each batch's index, size, running total and whether it ended the read", async () => {
    const fetchMock = sequenceFetch(
      batch({ pages: pages(0, 1000) }),
      batch({ pages: pages(1000, 1000) }),
      batch({ pages: [] })
    );
    const crawl = makeCrawl(fetchMock);
    const onBatch = vi.fn();

    await crawl.allPages("big", onBatch);

    expect(onBatch.mock.calls.map(([progress]) => progress)).toEqual([
      { batchIndex: 1, batchSize: 1000, totalRead: 1000, isLast: false },
      { batchIndex: 2, batchSize: 1000, totalRead: 2000, isLast: false },
      { batchIndex: 3, batchSize: 0, totalRead: 2000, isLast: true },
    ]);
  });

  it("marks a short batch as the last one without a following request", async () => {
    const fetchMock = sequenceFetch(batch({ pages: pages(0, 300) }));
    const crawl = makeCrawl(fetchMock);
    const onBatch = vi.fn();

    await crawl.allPages("short", { onBatch });

    expect(onBatch).toHaveBeenCalledTimes(1);
    expect(onBatch).toHaveBeenCalledWith({ batchIndex: 1, batchSize: 300, totalRead: 300, isLast: true });
  });

  it("marks the batch that reaches `total` as the last one", async () => {
    const fetchMock = sequenceFetch(
      batch({ pages: pages(0, 1000), total: 1500 }),
      batch({ pages: pages(1000, 500), total: 1500 })
    );
    const crawl = makeCrawl(fetchMock);
    const onBatch = vi.fn();

    await crawl.allPages("total", onBatch);

    expect(onBatch.mock.calls.map(([progress]) => progress)).toEqual([
      { batchIndex: 1, batchSize: 1000, totalRead: 1000, isLast: false },
      { batchIndex: 2, batchSize: 500, totalRead: 1500, isLast: true },
    ]);
  });

  it("stops the read and rejects with the callback's error, returning no pages", async () => {
    const failure = new Error("caller gave up");
    const fetchMock = sequenceFetch(
      batch({ pages: pages(0, 1000) }),
      batch({ pages: pages(1000, 1000) }),
      batch({ pages: pages(2000, 1000) })
    );
    const crawl = makeCrawl(fetchMock);
    const onBatch = vi.fn(({ batchIndex }: { batchIndex: number }) => {
      if (batchIndex === 2) throw failure;
    });

    const err = await catchError(crawl.allPages("big", onBatch));

    expect(err).toBe(failure);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("crawl() truncated result", () => {
  it("completes a truncated crawl, parsing page data and reporting each batch", async () => {
    const fetchMock = sequenceFetch(
      jsonResponse(202, { status: "queued", jobId: "big" }),
      jsonResponse(200, {
        status: "completed",
        result: [{ url: "https://x.com/0" }],
        totalPages: 2000,
        resultTruncated: true,
      }),
      batch({ pages: pages(0, 1000), total: 2000 }),
      batch({ pages: pages(1000, 1000), total: 2000 })
    );
    const client = makeClient(fetchMock);
    const onBatch = vi.fn();

    const job = await client.crawl({ baseUrl: "https://x.com", crawlInstruction: "all" }, { ...POLL, onBatch });

    expect(job.result).toHaveLength(2000);
    expect(job.result[0]).toEqual({
      url: "https://x.com/0",
      title: undefined,
      data: { n: 0 },
      html: null,
      markdown: null,
    });
    expect(job.result[1999].data).toEqual({ n: 1999 });
    expect(job.resultTruncated).toBe(false);
    expect(onBatch.mock.calls.map(([progress]) => progress)).toEqual([
      { batchIndex: 1, batchSize: 1000, totalRead: 1000, isLast: false },
      { batchIndex: 2, batchSize: 1000, totalRead: 2000, isLast: true },
    ]);
    expect(pagesUrls(fetchMock)).toEqual([
      "https://api.test/crawl/big/pages?offset=0&limit=1000",
      "https://api.test/crawl/big/pages?offset=1000&limit=1000",
    ]);
  });

  it("keeps non-JSON page data as text when completing a truncated result", async () => {
    const fetchMock = sequenceFetch(
      jsonResponse(202, { status: "queued", jobId: "mixed" }),
      jsonResponse(200, { status: "completed", result: [], resultTruncated: true }),
      batch({
        pages: [
          { ...page(1), data: JSON.stringify({ n: 1 }) },
          { ...page(2), data: "not json" },
        ],
      })
    );
    const client = makeClient(fetchMock);

    const job = await client.crawl({ baseUrl: "https://x.com", crawlInstruction: "all" }, POLL);

    expect(job.result[0].data).toEqual({ n: 1 });
    expect(job.result[1].data).toBe("not json");
  });

  it("rejects without returning pages when the per-batch callback throws", async () => {
    const failure = new Error("stop midway");
    const fetchMock = sequenceFetch(
      jsonResponse(202, { status: "queued", jobId: "big" }),
      jsonResponse(200, { status: "completed", result: [], resultTruncated: true }),
      batch({ pages: pages(0, 1000) }),
      batch({ pages: pages(1000, 1000) })
    );
    const client = makeClient(fetchMock);
    const onBatch = vi.fn(({ batchIndex }: { batchIndex: number }) => {
      if (batchIndex === 2) throw failure;
    });

    const err = await catchError(
      client.crawl({ baseUrl: "https://x.com", crawlInstruction: "all" }, { ...POLL, onBatch })
    );

    expect(err).toBe(failure);
    // submit + one status poll + both page batches: the third batch is never requested
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(pagesUrls(fetchMock)).toHaveLength(2);
  });
});
