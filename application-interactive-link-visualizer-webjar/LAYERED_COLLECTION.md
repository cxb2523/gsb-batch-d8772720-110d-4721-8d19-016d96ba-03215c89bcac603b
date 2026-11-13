# Layered link graph collection

The "Linked Pages" panel no longer builds its graph from a single Solr
search. It collects the documents reachable from the currently opened
document layer by layer, so indirect references are not silently missed and
truncated results are reported instead of drawn as if they were complete.

## Components

- `src/linkGraphCollector.ts` — framework-agnostic collection and graph
  building logic, packaged as its own AMD module (`linkGraphCollector.js`)
  and registered in RequireJS through a `org.xwiki.platform.requirejs.module`
  UI extension. It depends on no XWiki or jQuery API: the Solr transport is
  injected as `postSolrQuery`, which makes the whole traversal testable with
  a fake service.
- `src/main.ts` (`visualisationAPI.js`) — unchanged rendering logic, plus a
  renderer/layout registry with `disposeVisualization(containerId)` so the
  panel can release the previous Sigma instance (and its ForceAtlas2 worker)
  before redrawing.
- The panel JavaScript in
  `application-interactive-link-visualizer-ui/.../LinkVisualizerPanel.xml`
  owns the DOM: depth selector (1–3), status line, truncation warning, the
  jQuery Solr bridge and the request sequencing.

## Traversal

The collector runs a breadth-first search:

1. **Layer 0 (bootstrap):** fetch the seed document alone
   (`q=reference:<seed>`). Its outgoing links must be known before the first
   expansion because Solr cannot express "references equal to the links of
   another document". If the seed is missing (deleted, hidden, no view
   right) the collection ends with an empty graph.
2. **Layers 1..N:** for every document in the current frontier, query the
   documents that match any of:
   - `reference:<frontier document>` (the frontier itself),
   - `links:entity:<frontier document>` (back links),
   - `reference:<link of a frontier document>` (forward links, expanded on
     the client from the previously fetched `links` field).
3. The next frontier contains only documents discovered by the layer just
   processed. The loop stops when the configured depth is reached, when a
   layer yields no new document, or when a response is truncated.

Every request goes to the existing `XWiki.SuggestSolrService` `get` endpoint
with the same parameters as before (`outputSyntax=plain`, `media=json`,
`nb`, `input=" "`), document references are escaped with
`escapeQueryChars`, and the field list stays
`title_, reference, links, wiki, spaces, name`.

## Per-layer statistics and truncation

Each layer records `newDocuments`, the cumulative `totalDocuments`, how many
returned rows were already known, and a `truncated` flag. Solr never returns
more rows than `nb`, so a response whose length reaches `nb` is treated as
truncated: the expansion stops immediately (a partial frontier would make
every deeper layer unreliable) and the panel shows a warning containing the
`nb` limit and the layer at which it happened.

## Request sequencing

`LatestRequestRunner` tags every collection run with an increasing token.
Changing the depth invalidates the previous run: when it settles, its
promise rejects with `StaleRequestError` rather than resolving, so a slow
older response can never overwrite the newest graph. The panel swallows
that specific error and leaves the current graph untouched.

## Graph conventions

Unchanged from the previous implementation: node keys are document
references, an edge is created only when its target exists in the collected
result set (dangling links are dropped), and the seed document keeps the
orange color and the larger node size.

## Local verification

`npm run test-local` compiles `linkGraphCollector.ts` and the test harness
under `src/test/` (self-contained, no `@types/node` dependency) and runs it
with Node. The harness uses:

- `src/test/solr-samples/` — hand-crafted Solr JSON responses covering the
  normal layered expansion (seed + three layers) and an `nb` truncation;
- `src/test/fakeSolrService.ts` — a corpus-based fake Solr service (with an
  `nb` row cap) and a scripted service replaying the canned responses.
