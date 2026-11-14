/**
 * axuse example solver plugin — "turnstile-demo" (free for noncommercial use,
 * PolyForm Noncommercial 1.0.0, ships with the
 * repo). A complete, working solver for Cloudflare Turnstile on demo/test
 * pages. It exists to prove the plugin seam end-to-end and to serve as the
 * reference for authoring solver plugins (commercial solvers are drop-in
 * replacements with the same shape).
 *
 * Run it:
 *   node src/cli.js plugins                          # verify it loads
 *   node src/cli.js solve turnstile --url https://demo.turnstile.workers.dev/
 *
 * (Point AXUSE_PLUGINS at this directory to load it without copying:
 *   set AXUSE_PLUGINS=E:\...\axuse\examples\plugin-turnstile-demo )
 */

const TOKEN_EXPR = `(() => {
  const el = document.querySelector('[name="cf-turnstile-response"]');
  return { token: el && el.value ? el.value : "", len: el && el.value ? el.value.length : 0 };
})()`;

const WIDGET_EXPR = `(() => {
  const w = document.querySelector('.cf-turnstile') || document.querySelector('[class*="cf-turnstile"]');
  if (!w) return null;
  const r = w.getBoundingClientRect();
  return r.width > 0 ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null;
})()`;

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function poll(ctx, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const t = await ctx.evaluate(TOKEN_EXPR);
    if (t && t.len > 0) return t.token;
    await sleep(400);
  }
  return null;
}

export const solver = {
  id: "turnstile-demo",
  version: "1.0.0",
  label: "example (free): Turnstile demo-page solver",
  providers: ["turnstile"],
  async solve(provider, ctx, opts = {}) {
    const deadlineMs = opts.deadlineMs ?? 45_000;
    const t0 = Date.now();
    // 1. Fast path: most demo widgets self-solve and fill the token input.
    let token = await poll(ctx, 8000);
    let notes = "non-interactive pass (token appeared without a click)";
    // 2. Interactive: one trusted click on the checkbox anchor.
    if (!token) {
      const w = await ctx.evaluate(WIDGET_EXPR);
      if (!w) {
        return { solved: false, provider, token: null, elapsedMs: Date.now() - t0, notes: "no .cf-turnstile widget on the page" };
      }
      await ctx.click({ x: w.x + 30, y: w.y + 32 }, { settleMs: 800 });
      token = await poll(ctx, Math.max(1000, deadlineMs - (Date.now() - t0) - 1000));
      notes = `interactive widget clicked at (${w.x + 30},${w.y + 32})`;
    }
    return {
      solved: !!token,
      provider,
      token: token ?? null,
      elapsedMs: Date.now() - t0,
      notes: token ? notes : `${notes}, but no token appeared within ${deadlineMs}ms`,
    };
  },
};

export default solver;
