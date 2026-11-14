// ax_scroll {until} on the infinite feed (t7) and ax_observe {find} on the catalog (t3).
import { startSuite, SCORE } from "./server.mjs";
import { Controller } from "../../src/core/controller.js";
import { renderResult } from "../../src/mcp/render.js";
const s = await startSuite(); const c = new Controller();
let run = "find-t7-" + Date.now();
await c.execute("open", { url: `${s.base.parent}/t7?run=${run}`, headless: true });
const author = s.truth(run).t7.feed[s.truth(run).t7.idx].author;
let t0 = Date.now();
let r = await c.execute("scroll", { until: author });
console.log(`--- scroll until ${author} (${Date.now() - t0}ms)\n` + renderResult("scroll", r));
const likeRef = r.observation.text.split(`text "${author}"`)[1].match(/button "Like" \[ref=(e\d+)\]/)[1];
r = await c.execute("click", { target: { ref: likeRef } });
console.log("--- click\n" + renderResult("click", r));
{ const g = s.truth(run).t7; console.log("liked", g.likes, "target", g.feed[g.idx].id, g.feed[g.idx].author, "liked author", g.feed.find(p => p.id === g.likes[0])?.author); }
run = "find-t3-" + Date.now();
await c.execute("navigate", { url: `${s.base.parent}/t3?run=${run}` });
r = await c.execute("observe", { find: "TARGET" });
console.log("--- observe find TARGET\n" + renderResult("observe", r));
await c.execute("close", { browser: true }); s.close(); process.exit(0);
