/**
 * Scripted oracle: solves every suite task through axuse's public command
 * surface (no LLM). Proves (1) each task is solvable, (2) server scoring is
 * correct, (3) axuse can actuate each capability the suite exercises.
 *   node bench/suite/oracle.mjs [--tasks t1,t7]
 */
import { startSuite, TASK_IDS, SCORE } from "./server.mjs";
import { Controller } from "../../src/core/controller.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const tmp = join(homedir(), ".axbench-tmp", "oracle-files"); mkdirSync(tmp, { recursive: true });
let shopUrl = "";

const only = process.argv.includes("--tasks") ? process.argv[process.argv.indexOf("--tasks") + 1].split(",") : TASK_IDS;
const s = await startSuite();
const c = new Controller();
let opened = false;
const full = async () => (await c.execute("observe", { mode: "full", max_nodes: 2000, max_chars: 200000 })).observation.text;
const ref = (txt, re) => { const m = txt.match(new RegExp(re.source + String.raw`[^\n]*\[ref=((?:f\d+:)?e\d+)\]`)); if (!m) throw new Error("no ref for " + re); return m[1]; };
const click = (r) => c.execute("click", { target: { ref: r }, settle_ms: 200 });
const grab = (txt, re) => (txt.match(re) ?? [])[1] ?? "";

const solvers = {
  async t1(t) { await click(ref(t, /button "Claim code"/)); return grab(await full(), /code: (\w{6})/); },
  async t2(t) {
    await c.execute("type", { target: { ref: ref(t, /textbox "Full name"/) }, text: "Ada Lovelace" });
    await c.execute("type", { target: { ref: ref(t, /textbox "Email"/) }, text: "ada@example.com" });
    await c.execute("select", { ref: ref(t, /combobox "Plan"/), value: "Beta" });
    await click(ref(t, /checkbox "I agree"/));
    await click(ref(t, /button "Submit"/));
    return grab(await full(), /confirmation: (CNF-\w+)/);
  },
  async t3(t) { const m = t.match(/Widget TARGET-\w+ \| ([\d.]+) \| (\d+)/); return `${m[1]}|${m[2]}`; },
  async t4(t) {
    for (const col of ["Red", "Green", "Blue"]) { await click(ref(await full(), new RegExp(`button "${col}"`))); if (/number:/.test(await full())) break; }
    let x = await full(); const num = grab(x, /number: (\d+)/);
    await c.execute("type", { target: { ref: ref(x, /textbox "Number"/) }, text: num }); await click(ref(await full(), /button "Verify"/));
    x = await full(); const w = grab(x, /click the exact word (\w+)/);
    await click(ref(x, new RegExp(`button "${w}"`))); await click(ref(await full(), /button "Finish"/));
    return grab(await full(), /final token: (\w+)/);
  },
  async t5(t) { await click(ref(t, /button "Reveal code"/)); return grab(await full(), /code: (\w{6})/); },
  async t6(t) {
    await click(ref(t, /switch "Email alerts"/)); await click(ref(t, /radio "Weekly"/)); await click(ref(t, /button "Save preferences"/));
    return grab(await full(), /Reference: (\w{6})/);
  },
  async t7(t, g) {
    const author = g.t7.feed[g.t7.idx].author;
    for (let i = 0; i < 40; i++) {
      const x = await full();
      const m = x.match(new RegExp(`text "${author}"[\\s\\S]*?button "Like"[^\\n]*\\[ref=(e\\d+)\\]`));
      if (m) { await click(m[1]); return grab(await full(), /code: (\w{6})/); }
      await c.execute("scroll", { direction: "down", amount: 6, settle_ms: 500 });
    }
  },
  async t8(t) {
    await c.execute("hover", { target: { ref: ref(t, /link "Account/) } });
    await click(ref(await full(), /menuitem "Export data"/));
    return grab(await full(), /Export code: (\w{6})/);
  },
  async t9(t) {
    const r = await c.execute("click", { target: { ref: ref(t, /button "Delete old-backup.zip"/) } });
    await c.execute("dialog", { answer: "accept" });
    await c.execute("dialog", { answer: "accept", prompt_text: "cleanup" });
    return grab(await full(), /Code: (\w{6})/);
  },
  async t10(t) {
    await click(ref(t, /link "help center"/));
    const tabs = await c.execute("tabs", {});
    const help = tabs.tabs.find((x) => /t10help/.test(x.url));
    const origin = tabs.tabs.find((x) => /\/t10\?/.test(x.url));
    let code;
    if (help) {
      const o = await c.execute("observe", { tab_id: help.tab_id, mode: "full" });
      code = grab(o.observation.text, /verification code is: (\w{6})/);
      await c.execute("close", { tab_id: help.tab_id });
    }
    const x = (await c.execute("observe", { tab_id: origin.tab_id, mode: "full" })).observation.text;
    await c.execute("type", { tab_id: origin.tab_id, target: { ref: ref(x, /textbox "Verification code"/) }, text: code ?? "" });
    await c.execute("click", { tab_id: origin.tab_id, target: { ref: ref(x, /button "Verify"/) }, settle_ms: 300 });
    return grab((await c.execute("observe", { tab_id: origin.tab_id, mode: "full" })).observation.text, /Receipt: (\w{6})/);
  },
  async t11(t) {
    await click(ref(t, /button "Generate report"/));
    await c.execute("wait_for", { expression: "!!document.getElementById('d')", timeout_ms: 15000 });
    await click(ref(await full(), /button "Download report"/));
    return grab(await full(), /Code: (\w{6})/);
  },
  async t12(t) {
    await c.execute("drag", { from: { ref: ref(t, /listitem "Fix login bug"/) }, to: { ref: ref(t, /region "Done column"/) }, settle_ms: 400 });
    return grab(await full(), /Code: (\w{6})/);
  },
  async t13(t) {
    await c.execute("type", { target: { ref: ref(t, /textbox "Release note editor"/) }, text: "Release 4.2 fixes the export bug." });
    await click(ref(await full(), /button "Publish"/));
    return grab(await full(), /Code: (\w{6})/);
  },
  async t14(t) {
    await c.execute("type", { target: { ref: ref(t, /combobox "City"/) }, text: "Zurich", settle_ms: 600 });
    await click(ref(await full(), /option "Zurich"/));
    await click(ref(await full(), /button "Country/));
    await click(ref(await full(), /option "Switzerland"/));
    await click(ref(await full(), /button "Save destination"/));
    return grab(await full(), /Code: (\w{6})/);
  },
  async t15(t, g) {
    await c.execute("type", { target: { ref: ref(t, /searchbox "Search customer"/) }, text: g.t15.customer, settle_ms: 900 });
    const x = await full();
    const m = x.match(/row "(ORD-\d+) \| [^|]+\| Refunded[^\n]*\n\s*- button "Details" \[ref=(e\d+)\]/);
    await click(m[2]);
    return grab(await full(), /order code: (\w{6})/);
  },
  async t16(t, g) {
    // Oracle reads geometry from ground truth; an agent reads the screenshot.
    const box = t.match(/canvas \(box=(\d+),(\d+),(\d+)x(\d+)/).slice(1).map(Number);
    const red = g.t16.circles.find((k) => k.color === "red");
    const sx = (box[2] - 2) / 640, sy = (box[3] - 2) / 300;
    await c.execute("click", { target: { x: box[0] + 1 + red.x * sx, y: box[1] + 1 + red.y * sy }, settle_ms: 300 });
    return grab(await full(), /Code: (\w{6})/);
  },
  async t17(t) {
    for (const item of ["Write release notes", "Fix flaky test", "Update changelog"]) {
      await c.execute("type", { target: { ref: ref(await full(), /textbox "New todo"/) }, text: item, submit: true });
    }
    await click(ref(await full(), /checkbox "Fix flaky test"/));
    await click(ref(await full(), /button "Sync to server"/));
    return grab(await full(), /Code: (\w{6})/);
  },
  async t18(t) {
    const buy = async (name, size, color, qty) => {
      await c.execute("navigate", { url: shopUrl });
      let x = await full();
      await click(ref(x, new RegExp(`link "${name}"`)));
      x = await full();
      await c.execute("fill", { fields: [
        { ref: ref(x, /combobox "Size"/), value: size },
        { ref: ref(x, new RegExp(`radio "${color}"`)), value: true },
        { ref: ref(x, /spinbutton "Quantity"/), value: String(qty) },
      ], submit: ref(x, /button "Add to cart"/) });
    };
    await buy("Trail Runner", "M", "Blue", 2);
    await buy("Rain Shell", "L", "Black", 1);
    await click(ref(await full(), /link "Cart"/));
    let x = await full();
    await c.execute("fill", { fields: [{ ref: ref(x, /textbox "Coupon code"/), value: "SAVE10" }], submit: ref(x, /button "Apply"/) });
    await click(ref(await full(), /link "Proceed to checkout"/));
    x = await full();
    await c.execute("fill", { fields: [
      { ref: ref(x, /textbox "Full name"/), value: "Ada Lovelace" }, { ref: ref(x, /textbox "Street"/), value: "Bahnhofstrasse 1" },
      { ref: ref(x, /textbox "ZIP"/), value: "8001" }, { ref: ref(x, /textbox "City"/), value: "Zurich" },
      { ref: ref(x, /combobox "Country"/), value: "Switzerland" }, { ref: ref(x, /radio "Express/), value: true },
    ], submit: ref(x, /button "Place order"/) });
    return grab(await full(), /Order number: (ORD-\d+)/);
  },
  async t19(t, g) {
    const id = g.t19.rows[g.t19.idx].id;
    const r = await c.execute("scroll", { until: id });
    await click(ref(r.observation.text, new RegExp(`button "Approve ${id}"`)));
    return grab(await full(), /Code: (\w{6})/);
  },
  async t20(t) {
    const pick = async (field, monthsAhead, label) => {
      await click(ref(await full(), new RegExp(`textbox "${field}"`)));
      for (let i = 0; i < monthsAhead; i++) await click(ref(await full(), /button "Next month"/));
      await click(ref(await full(), new RegExp(`button "${label}"`)));
    };
    await pick("Departure", 2, "December 17, 2026");
    await pick("Return", 3, "January 3, 2027");
    await click(ref(await full(), /button "Save dates"/));
    return grab(await full(), /Code: (\w{6})/);
  },
  async t21(t) {
    const fill = async (u) => {
      const x = await full();
      return c.execute("fill", { fields: [
        { ref: ref(x, /textbox "Username"/), value: u }, { ref: ref(x, /textbox "Password"/), value: "Analytical#Engine1843" },
        { ref: ref(x, /textbox "Confirm password"/), value: "Analytical#Engine1843" }, { ref: ref(x, /textbox "Date of birth/), value: "1990-12-10" },
        { ref: ref(x, /checkbox "I accept the terms"/), value: true },
      ], submit: ref(x, /button "Create account"/) });
    };
    await fill("ada");
    if (/already taken/.test(await full())) await fill("ada_1815");
    return grab(await full(), /Account code: (\w{6})/);
  },
  async t22(t) {
    const x = await full();
    await c.execute("fill", { fields: [{ ref: ref(x, /textbox "Branch code"/), value: "ZH-4471" }], submit: ref(x, /button "Look up"/) });
    return grab(await full(), /Confirmation: (\w{6})/);
  },
  async t23(t, g) {
    const file = join(tmp, g.t23.want);
    writeFileSync(file, g.t23.content);
    await c.execute("upload", { ref: ref(t, /button "Avatar file"/), paths: [file] });
    await click(ref(await full(), /button "Upload"/));
    return grab(await full(), /Code: (\w{6})/);
  },
};

let pass = 0;
for (const t of only) {
  const run = `oracle-${t}-${Date.now().toString(36)}`;
  const url = `${s.base.parent}/${t}?run=${run}`;
  const t0 = Date.now();
  try {
    const r = opened ? await c.execute("navigate", { url, settle_ms: 400 }) : await c.execute("open", { url, headless: true, settle_ms: 400 });
    opened = true;
    await new Promise((ok) => setTimeout(ok, 300));
    shopUrl = url;
    const ans = await solvers[t](await full(), s.truth(run));
    const ok = SCORE[t](s.truth(run), String(ans ?? ""));
    pass += ok;
    console.log(`${ok ? "PASS" : "FAIL"} ${t} answer=${ans} ${Date.now() - t0}ms`);
  } catch (e) {
    console.log(`FAIL ${t} ${e.message}`);
  }
}
console.log(`oracle: ${pass}/${only.length}`);
await c.execute("close", { browser: true }); s.close(); process.exit(0);
