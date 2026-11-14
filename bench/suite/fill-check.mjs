// ax_fill check on the suite's form (t2) and combobox/dropdown (t14) tasks.
import { startSuite, SCORE } from "./server.mjs";
import { Controller } from "../../src/core/controller.js";
const s = await startSuite();
const c = new Controller();
const ref = (txt, re) => txt.match(new RegExp(re.source + String.raw`[^\n]*\[ref=(e\d+)\]`))[1];

let run = "fill-t2-" + Date.now();
let o = (await c.execute("open", { url: `${s.base.parent}/t2?run=${run}`, headless: true })).observation.text;
let r = await c.execute("fill", {
  fields: [
    { ref: ref(o, /textbox "Full name"/), value: "Ada Lovelace" },
    { ref: ref(o, /textbox "Email"/), value: "ada@example.com" },
    { ref: ref(o, /combobox "Plan"/), value: "Beta" },
    { ref: ref(o, /checkbox "I agree"/), value: true },
  ],
  submit: ref(o, /button "Submit"/),
});
console.log("t2 fill result:\n" + r.observation.text);
console.log("t2 server:", s.truth(run).t2.valid);

run = "fill-t14-" + Date.now();
o = (await c.execute("navigate", { url: `${s.base.parent}/t14?run=${run}` })).observation.text;
r = await c.execute("fill", {
  fields: [{ ref: ref(o, /combobox "City"/), value: "Zurich" }, { ref: ref(o, /button "Country/), value: "Switzerland" }],
  submit: ref(o, /button "Save destination"/),
});
console.log("t14 fill result:\n" + r.observation.text);
console.log("t14 server:", JSON.stringify(s.truth(run).t14.got));
await c.execute("close", { browser: true }); s.close(); process.exit(0);
