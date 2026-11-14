---
description: Benchmark what a role pays across a whole Glassdoor market, page by page
argument-hint: [role] [market] [sort] [domain] [max pages]
---

Benchmark what a role pays across a market, not just the first page Glassdoor returns.

Ask me for the role and the market if I have not given them, in the shape `data engineer` and `Austin, TX`. Also ask, or infer from what I said:

- `sort`: `recent` or `relevant`; leave it off to keep Glassdoor's own order
- `domain`: a regional Glassdoor site such as `www.glassdoor.co.uk`; leave it off for the US site
- `max pages`: how far to walk. Default 5. Every page costs 10 credits, so say the cost out loud before a long walk: N pages is up to 10N credits, and failed pages are not billed.

Then run the collector in this plugin rather than calling the listing tool once yourself. From the plugin root (it is the directory holding `commands/`; `$CLAUDE_PLUGIN_ROOT` when the client sets it):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/salary-benchmark.mjs" \
  --keyword "<role>" --location "<market>" \
  [--sort recent|relevant] [--domain <site>] [--max-pages N] [--json]
```

If `CLAUDE_PLUGIN_ROOT` is not set, run `scripts/salary-benchmark.mjs` relative to this plugin's root. If you cannot find the script at all, say so and stop; do not fall back to a single listing call and present it as a market benchmark.

The collector implements the paging contract, so do not hand-roll it from tool responses:

1. Page one sends `keyword`, `location`, and the optional `sort` and `domain`, with no token.
2. After page one, the only thing that advances the walk is the token the previous page returned in `pagination.otherPages`, sent as `nextPageToken`. Every other parameter stays unchanged. No page number is ever constructed or sent.
3. The walk stops when the token is missing, when a token repeats one already used, when a page returns zero postings, or at `--max-pages`. A page that fails after retries also stops the walk.
4. HTTP 429, or a response carrying `concurrency_limit`, is retried at increasing intervals, up to five retries. A 401 fails at once and is never retried. Other errors and other non-2xx statuses stop the page.
5. A failed page never discards the pages already collected. The collector still returns the grouped statistics; it exits non-zero and labels the coverage incomplete.

Read the report it prints and relay it in this shape:

- **Coverage first.** For every page, give its number, its outcome, how many postings it carried and the running total. The four page outcomes are: it succeeded, it was an empty page, it was rate limited and abandoned after the retries, or it failed another way (including a rejected key, which fails on the first response). Say separately why the walk ended: the listing offered no further token, a token repeated, the page cap was reached, or a page failed. Then state how many pages were collected of the plan and whether the result is complete for the query or truncated. Never say "the market" when the walk stopped early; say which pages the figures cover. A page count of 2 out of 5 is not a market summary.
- **Salary sets, never merged.** Split by `salary.source` (`EMPLOYER_PROVIDED` versus `ESTIMATED`), and within each source keep `HOURLY` and `ANNUAL` apart. Give low, median and high per set, the number of postings behind it, and how many carried no salary at all. A posting whose `min`, `median` and `max` are equal is one stated figure, so count it as one point. Never average an hourly figure into an annual one unless I explicitly ask for a conversion, and say what rate you used if you do.
- **Employers at both ends.** Name the employers paying most and least within each set, with their `rating` and the `ageInDays` of the posting.
- **Cost.** State how many pages were billed and the total credits at 10 credits a page; a retried or failed page is not billed.

A failed page never zeroes the report: the statistics over the pages that succeeded are still reported, and the collector exits non-zero so an unattended run can tell partial coverage from full. Relay the partial figures with the coverage caveat rather than withholding them.

Attribute the figures to Glassdoor and say plainly that `ESTIMATED` entries are Glassdoor's model rather than reported pay. If the walk came back incomplete, say which of the stop conditions it hit, and only offer to rerun with a larger `--max-pages` when the page cap was the cause; a rejection or a sustained throttle needs the key or the plan's concurrency looked at first.

Do not open the detail tool unless I ask what a specific posting requires. The listing already carries the pay, and each detail call costs as much as a whole page of postings.
