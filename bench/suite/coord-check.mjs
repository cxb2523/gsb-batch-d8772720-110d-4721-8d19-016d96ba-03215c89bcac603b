// Coordinate contract check: screenshot pixels == ax_click {x,y}, even when scrolled.
import { startSuite } from "./server.mjs";
import { Controller } from "../../src/core/controller.js";
const s = await startSuite(); const c = new Controller();
const run = "coord-" + Date.now();
await c.execute("open", { url: `${s.base.parent}/t16?run=${run}`, headless: true });
await c.execute("evaluate", { expression: "document.body.style.paddingBottom='2000px'; scrollTo(0, 60); scrollY" });
const shot = await c.execute("screenshot", {});
const o = (await c.execute("observe", { mode: "full" })).observation.text;
const [bx, by, bw] = o.match(/box=(-?\d+),(-?\d+),(\d+)x/).slice(1).map(Number);
const red = s.truth(run).t16.circles.find((k) => k.color === "red");
const scale = (bw - 2) / 640;
// What a vision model would do: read the circle's pixel position in the screenshot.
const x = bx + 1 + red.x * scale, y = by + 1 + red.y * scale;
const r = await c.execute("click", { target: { x, y } });
console.log("screenshot note:", shot.note);
console.log("canvas line:", o.match(/- canvas[^\n]*/)[0]);
console.log("hit:", s.truth(run).t16.hits);
await c.execute("close", { browser: true }); s.close(); process.exit(0);
