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
      { index: 0, url: "https://example.com", title: "Example", status: "opened", ref_count: 3, excerpt: "heading \"Example\"" },
      { index: 1, url: "https://bad.example", status: "error", phase: "open", error: { code: "NAVIGATION_IN_PROGRESS", message: "blocked", hint: "inspect the page" } },
      { index: 2, url: "ftp://files.example/x", status: "skipped", reason: "unsupported scheme (expected http(s):, file:, about:, data: or blob:)" },
      { index: 3, url: "https://slow-close.example", title: "Leftover", status: "opened", ref_count: 1, close_error: { code: "INTERNAL", message: "tab would not close" } },
    ],
  });
  assert.match(report, /2 opened, 1 failed, 1 skipped/);
  assert.match(report, /heading \"Example\"/);
  assert.match(report, /NAVIGATION_IN_PROGRESS/);
  assert.match(report, /inspect the page/);
  assert.match(report, /Phase: open \(page never loaded\)/);
  assert.match(report, /Status: skipped/);
  assert.match(report, /unsupported scheme/);
  assert.match(report, /Cleanup warning: closing the tab afterwards failed/);
});
