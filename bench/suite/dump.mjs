import { writeFileSync } from "node:fs";
import { startSuite, TASK_IDS } from "./server.mjs";
import { Controller } from "../../src/core/controller.js";
const s = await startSuite();
const c = new Controller();
let first = true;
for (const t of TASK_IDS) {
  const url = `${s.base.parent}/${t}?run=dump-${t}`;
  const r = first ? await c.execute("open", { url, headless: true }) : await c.execute("navigate", { url });
  first = false;
  const txt = r.observation?.text ?? JSON.stringify(r).slice(0, 2000);
  writeFileSync(new URL(`./out/${t}.txt`, import.meta.url), txt);
  console.log(t, txt.length, "chars");
}
await c.execute("close", { browser: true }); s.close(); process.exit(0);
