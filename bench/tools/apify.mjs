// One Apify actor run (the market leader's own actor for the site): start, wait, read the dataset.
// Cost is the run's own usageTotalUsd, as Apify bills it.

const BASE = "https://api.apify.com/v2";

async function call(fetchImpl, token, method, path, body) {
  const response = await fetchImpl(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Apify ${response.status}: ${json.error?.message || "request failed"}`);
  return json;
}

export async function runApify({ task, config, keys, fetchImpl = fetch, sleep, now = Date.now, maxWaitMs = 10 * 60 * 1000 }) {
  const wait = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const started = now();
  let { data: run } = await call(fetchImpl, keys.apify, "POST", `/acts/${config.actor}/runs`, config.input);
  // Poll until the actor ends or the wait ceiling is hit; past the ceiling the run is a timeout,
  // not a success, and the actor run id is kept as ref so it can be read on Apify later.
  let timedOut = false;
  while (!["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(run.status)) {
    if (now() - started >= maxWaitMs) { timedOut = true; break; }
    await wait(2000);
    ({ data: run } = await call(fetchImpl, keys.apify, "GET", `/actor-runs/${run.id}`));
  }
  const items = !timedOut && run.status === "SUCCEEDED"
    ? await call(fetchImpl, keys.apify, "GET", `/datasets/${run.defaultDatasetId}/items?clean=true&limit=${task.limit}`)
    : [];
  // Some actors return one object holding the rows (a profile with its latestPosts): read them from there.
  const rows = config.rows_from ? (items[0]?.[config.rows_from] ?? []) : items;
  return {
    ok: !timedOut && run.status === "SUCCEEDED",
    status: timedOut ? "timeout" : run.status,
    seconds: (now() - started) / 1000,
    output: rows.slice(0, task.limit),
    usd: Number(run.usageTotalUsd ?? 0),
    spent: { usd: Number(run.usageTotalUsd ?? 0) },
    tokens: 0,
    ref: run.id,
    error: timedOut
      ? `still ${String(run.status).toLowerCase()} when the ${Math.round(maxWaitMs / 60000)} min wait limit was reached`
      : run.status === "SUCCEEDED" ? null : run.statusMessage || null,
  };
}
