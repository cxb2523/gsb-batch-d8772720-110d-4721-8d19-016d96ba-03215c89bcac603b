---
description: Snapshot a public Facebook page and walk its feed with a reusable, resumable run
---

Snapshot a public Facebook page and its recent feed.

Ask me for the page handle if I have not given it. The handle is the part of the URL after
facebook.com, or the numeric id from a `profile.php?id=` URL.

Run the bundled pipeline rather than calling the tool by hand:

```bash
HASDATA_API_KEY=... node bin/facebook-snapshot.mjs <handle> --max-pages 4 --out snapshots
```

It writes `snapshots/<handle>.snapshot.json` (the complete record) and
`snapshots/<handle>.snapshot.md` (the readable report) after every run, including a run that
stopped partway.

What the run guarantees, and what to report back:

1. One opening call returns `profile`, `photos`, one post and `pagination`. Keep the profile and
   photos there: a call made with `nextPageToken` returns `posts` and `pagination` only.
2. Page forward with the previous response's `nextPageToken` unchanged. Never pass `nextPage`;
   it is a label, not a parameter. Stop when a response arrives without a token.
3. Count the posts actually returned. The opening page carries one post, later pages three; do
   not pad either page to `postsPerPage`.
4. Test for `profile` before reading it. A page that is missing, deleted or private answers 200
   with `error` instead. Report it as unavailable and stop; do not request another token.
5. Retry a 429 or concurrency limit with a backoff. If retries run out, mark that page failed,
   keep the posts already collected, and stop.
6. Quote `followersCount` as the string it is, label included. It is not a number, and converting
   it silently loses the fact that Facebook rounded it.

The JSON carries `profile`, `photos`, `posts`, `stats` (posting cadence, totals and the
highest-engagement posts), `pages[]` with one outcome per page (`success`, `end`, `failed`,
`unavailable` plus a reason), and `calls` with the billable count and credits. When a walk stops
early, `resume.token` holds the token for the next run; pass it back with `--start-token` and the
earlier file with `--prior` to continue without re-paying for pages already read.

If the page posts rarely, say that plainly. A quiet page is a finding, not a gap to fill with
adjectives.
