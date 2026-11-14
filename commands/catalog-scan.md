---
description: Reproducible, resumable Shopify catalogue scan by collection, with a per-page outcome record and summary
---

Scan a Shopify storefront one collection at a time and leave an auditable, resumable record of every page pulled.

Ask me for the store URL if I have not given it. The domain is enough.

## What to run

The deterministic flow lives in this package, so prefer the local runner over re-implementing the
loop by hand:

```bash
node bin/catalog-scan.mjs https://www.example.com --output catalog-scan.json
# after a rate-limit or non-Shopify failure, continue from the same record:
node bin/catalog-scan.mjs --resume catalog-scan.json
```

The runner writes the JSON checkpoint after every collection (so a killed process loses at most the
collection in flight) plus a companion `.md` report. Exit code 2 means one or more collections
need another run; 0 means everything reached its short page. When running inside an MCP client
without a shell, follow the same rules below against the tools directly and produce the record
shape the runner produces.

## Collection rules

1. Call `hasdata_shopify_collections_getCollections` with the `url` first and report each
   collection with its `products_count`, so the shape of the catalogue is visible before anything
   is pulled. A count of zero is a staged or seasonal collection, not a failure.
2. Check that a response carries a `products` or `collections` array rather than an `error`
   string. A URL that is not a classic Shopify storefront still answers 200 with
   `requestMetadata.status` reading `ok`, so retry a store you know is Shopify on its
   `https://<shop>.myshopify.com` address before reporting it has nothing.
3. For every collection, call `hasdata_shopify_products_getProducts` with the `url`, the
   collection's `handle` passed as `collection`, `limit` fixed at **250**, and `page` starting at
   **1**. Process collections one at a time (the free tier allows one concurrent request).
4. Keep paging until a page comes back short (fewer than 250 products) or empty. There is no
   pagination block; page length is the only stop signal.

## Failure handling — never abort the round

- A body with no `products` array (an `error` string, or any other shape) is a **non-Shopify**
  outcome for that collection. Record it, note that the collection should be retried as
  `https://<shop>.myshopify.com`, and move to the next collection.
- HTTP **429**, or any response containing `concurrency_limit`, is a rate limit. Retry the same
  page with an increasing backoff (1s, 2s, 4s, 8s), at most **5 attempts**. If every attempt is
  rate limited, record the page as a **rate-limited failure**, note that the collection must
  resume at that page, and continue with the next collection. One failed collection never stops
  the others.

## The record

Emit (and, with the runner, checkpoint to JSON) a per-page outcome list. Every page row carries:

- `collection` — the collection handle
- `page` — the page number
- `outcome` — one of `success`, `empty`, `non_shopify`, `rate_limited`
- `products_on_page` — products returned by this page (0 for every non-success outcome)
- `cumulative_products` — running total of products collected for the collection
- `attempts` — how many calls the page took (retries included)

On each successful page, parse every variant `price` and `compare_at_price` to a **number** first
(they arrive as strings; text sorting puts `"9.00"` above `"16.00"`) and record the page's numeric
`price_min`, `price_max` and the count of discounted variants. A `compare_at_price` of `null` is
not a discount; a discount requires a non-null compare price strictly above the current price.

Also keep:

- a **sold-out list**: every product whose `variants` array is non-empty and whose variants all
  report `available === false`, with its collection handle, product `handle`, `title`, `vendor`
  and `product_type`
- a per-collection summary: pages pulled, product count, collection-wide price range, discounted
  variant count, outcome counts, failure reason, and whether the collection needs another run
- a top-line total over the whole round and an explicit list of the collections that need a
  resume run, each with the page or URL to resume from

## Resuming

A resume run reads the checkpoint and, for each collection: a collection already marked complete
is skipped without spending calls; a rate-limited collection keeps its successful pages and
continues at the failed page with the cumulative total preserved; a non-Shopify collection restarts
at page 1, normally against the `myshopify.com` address. The original `started_at` is preserved so
the record describes one logical scan.

## Output field names

These are the store's published fields in Shopify's own snake_case. Quote them as they are and do
not rename them. Strip the HTML out of `body_html` before quoting any description, and remember
the price lives on the variant, never on the product.
