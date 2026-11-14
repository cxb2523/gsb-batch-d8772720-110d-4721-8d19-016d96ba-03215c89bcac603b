// Ad-hoc latency profiler for individual axuse commands against suite pages.
import { startSuite } from "./server.mjs";
import { Controller } from "../../src/core/controller.js";
const s = await startSuite();
const c = new Controller();
const T = async (label, p) => {
  const t0 = Date.now();
  try {
    const r = await p;
    console.log(label, Date.now() - t0, "ms", JSON.stringify(r).slice(0, 300));
    return r;
  } catch (e) {
    console.log(label, "THREW", Date.now() - t0, "ms", e.code, e.message, String(e.stack).slice(0, 400));
    return {};
  }
};
let r = await T("open", c.execute("open", { url: `${s.base.parent}/t12?run=p1`, headless: true }));
const txt = r.observation.text;
const a = txt.match(/listitem "Fix login bug" \[ref=(e\d+)\]/)[1], b = txt.match(/region "Done column" \[ref=(e\d+)\]/)[1];
await T("drag", c.execute("drag", { from: { ref: a }, to: { ref: b } }));
await T("observe", c.execute("observe", {}));
await T("observe-full", c.execute("observe", { mode: "full", max_nodes: 2000, max_chars: 200000 }));
r = await T("nav t10", c.execute("navigate", { url: `${s.base.parent}/t10?run=p2` }));
const l = r.observation?.text?.match(/link "help center"[^\n]*\[ref=(e\d+)\]/)?.[1];
await T("click link", c.execute("click", { target: { ref: l } }));
await new Promise((ok) => setTimeout(ok, 1500));
await T("tabs", c.execute("tabs", {}));
await c.execute("close", { browser: true });
s.close();
process.exit(0);
