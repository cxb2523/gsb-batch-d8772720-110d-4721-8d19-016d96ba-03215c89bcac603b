# Local Solr response samples

These files are hand-crafted samples of the JSON arrays returned by the
`XWiki.SuggestSolrService` `get` endpoint (`media=json`). They are consumed by
`../linkGraphCollector.test.ts` through the fake Solr service defined in
`fakeSolrService.ts`, to verify the layered (BFS) collection and the `nb`
truncation handling without any running XWiki / Solr instance.

The fixtures model a small wiki (seed = `document:xwiki:Main.Root`):

```
                    +--> D3 (leaf)
R (Root) --> D1 --> D2
 |                  ^
 +--> D2 (also directly links to D2)
 |
 +--> D4 --(back link only)------------+
                                       |
T (Truncated) has 3 extra neighbors X1, X2, X3 that exceed the nb=3 limit.
```

## Files

- `layered/seed.json` — bootstrap response returning the seed document on its
  own (the collector fetches it before expanding so its outgoing links are
  known).
- `layered/layer-1.json` — response of the depth-1 query (R, D1, D2, D4).
- `layered/layer-2.json` — response expanding the depth-1 frontier (D1, D2, D4):
  adds D3, keeps already known documents.
- `layered/layer-3.json` — response expanding the depth-2 frontier (D3): only
  known documents come back, so the traversal stops with no new document.
- `truncated/seed.json` — bootstrap response of the truncation scenario.
- `truncated/layer-1.json` — response of a query limited to `nb=3` returning
  exactly 3 rows, which must be detected as truncated and stop the expansion.

Each document keeps the same field list as requested by the panel
(`title_, reference, links, wiki, spaces, name`). Link values use the real
`entity:` prefix used by XWiki Solr.
