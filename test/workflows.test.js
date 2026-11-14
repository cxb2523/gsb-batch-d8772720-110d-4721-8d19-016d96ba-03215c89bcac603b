import { test } from "node:test";
import assert from "node:assert/strict";
import { extractUrls, renderUrlReport } from "../src/workflows/url-batch.js";

test("url batch workflow extracts and de-duplicates Markdown links", () => {
  const urls = extractUrls("[one](https://example.com/a)\nhttps://example.com/a\nhttps://example.com/b.");
  assert.deepEqual(urls, ["https://example.com/a", "https://example.com/b"]);
});

test("url batch workflow renders honest status and excerpts", () => {
  const report = renderUrlReport({
    backend: "extension",
    source: "sources.md",
    results: [
      { url: "https://example.com", title: "Example", status: "opened", ref_count: 3, excerpt: "heading \"Example\"" },
      { url: "https://bad.example", status: "error", error: { code: "NAVIGATION_IN_PROGRESS", message: "blocked", hint: "inspect the page" } },
    ],
  });
  assert.match(report, /1 opened, 1 failed/);
  assert.match(report, /heading \"Example\"/);
  assert.match(report, /NAVIGATION_IN_PROGRESS/);
  assert.match(report, /inspect the page/);
});
