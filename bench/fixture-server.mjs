/**
 * axuse head-to-head benchmark — fixture server.
 *
 * Deterministic, per-run-seeded task pages. Every state change POSTs to this
 * server, so task success is scored against SERVER-SIDE ground truth, not
 * the model's self-report. Two listeners on different origins (127.0.0.1 and
 * localhost) so T5 can host a genuine cross-origin iframe (OOPIF).
 */
import http from "node:http";
import { once } from "node:events";

// -------- seeded RNG (deterministic per run id) --------
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = (run) => mulberry32(hash(run));
const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const digits = "23456789";
const pick = (r, alphabet, n) => Array.from({ length: n }, () => alphabet[Math.floor(r() * alphabet.length)]).join("");

const state = new Map(); // run → ground truth
function ground(run) {
  if (!state.has(run)) {
    const r = rng(run);
    const colors = ["Red", "Green", "Blue"];
    const targetColor = colors[Math.floor(r() * 3)];
    const t3rows = Array.from({ length: 150 }, (_, i) => ({
      sku: `SKU-${1000 + i}`,
      product: `Widget ${pick(r, letters, 2)}-${pick(r, digits, 3)}`,
      price: (2 + r() * 480).toFixed(2),
      stock: Math.floor(r() * 90) + 1,
    }));
    // Ensure a unique target product name.
    const targetRow = t3rows[Math.floor(r() * t3rows.length)];
    targetRow.product = `Widget TARGET-${pick(r, letters, 3)}`;
    state.set(run, {
      t1: { code: pick(r, letters, 3) + pick(r, digits, 3), claimed: false },
      t2: { valid: false, confirmation: null, name: null, email: null, plan: null },
      t3: { rows: t3rows, target: targetRow },
      t4: {
        color: targetColor, number: String(Math.floor(100 + r() * 900)),
        word: pick(r, letters, 5), token: pick(r, letters, 4) + pick(r, digits, 4),
        step: 0, wrong: 0,
      },
      t5: { code: pick(r, letters, 3) + pick(r, digits, 3), clicked: false },
    });
  }
  return state.get(run);
}

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:880px;margin:24px auto;padding:0 16px}
table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 10px;font-size:14px}
button{padding:6px 14px;margin:4px}input,select{margin:4px}</style></head><body>${body}</body></html>`;

const api = (res, obj) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(obj)); };

/**
 * Browser-only gate for scored action endpoints: browsers always send
 * Origin (on POST) and Sec-Fetch-* headers; curl/Invoke-WebRequest/node
 * fetch-by-default do not. Kills the lazy shell-shortcut path so the
 * benchmark measures the BROWSER tool layers.
 */
function browserOnly(req, res, allowedHost) {
  const origin = String(req.headers.origin ?? "");
  const sec = req.headers["sec-fetch-site"];
  const originOk = origin.includes(allowedHost);
  const secOk = sec !== undefined && sec !== "none";
  if (!originOk && !secOk) {
    res.statusCode = 403;
    return api(res, { error: "browser-only endpoint: complete this action in a real browser" }), false;
  }
  return true;
}

function makeServer(origin /* "parent" | "child" */) {
  return http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const run = u.searchParams.get("run") ?? "";
    if (!run) return api(res, { error: "missing run" });
    const g = ground(run);

    if (origin === "parent") {
      const host = "127.0.0.1";
      if (u.pathname === "/t1") {
        return res.end(page("claim", `
<h1>Claim your code</h1>
<p>Press the button to reveal your personal code.</p>
<button id="claim" onclick="fetch('/api/t1/claim?run=${run}',{method:'POST'}).then(r=>r.json()).then(d=>document.getElementById('out').textContent='code: '+d.code)">Claim code</button>
<div id="out" style="min-height:1em;font-size:20px"></div>`));
      }
      if (u.pathname === "/api/t1/claim" && req.method === "POST") {
        if (!browserOnly(req, res, host)) return;
        g.t1.claimed = true;
        return api(res, { code: g.t1.code });
      }
      if (u.pathname === "/t2") {
        return res.end(page("form", `
<h1>Create account</h1>
<form onsubmit="event.preventDefault();fetch('/api/t2/submit?run=${run}',{method:'POST',body:JSON.stringify({name:f1.value,email:f2.value,plan:sel.value,agree:cb.checked})}).then(r=>r.json()).then(d=>document.getElementById('out').textContent=d.ok?('confirmation: '+d.confirmation):('error: '+d.error))">
<label for="f1">Full name</label><input id="f1"><br>
<label for="f2">Email</label><input id="f2" type="email"><br>
<label for="sel">Plan</label><select id="sel"><option value="">—</option><option>Alpha</option><option>Beta</option><option>Gamma</option></select><br>
<input type="checkbox" id="cb"><label for="cb">I agree</label><br>
<button type="submit">Submit</button>
</form><div id="out" style="min-height:1em"></div>`));
      }
      if (u.pathname === "/api/t2/submit" && req.method === "POST") {
        if (!browserOnly(req, res, host)) return;
        let b = "";
        req.on("data", (d) => (b += d));
        req.on("end", () => {
          const v = JSON.parse(b || "{}");
          g.t2.name = v.name; g.t2.email = v.email; g.t2.plan = v.plan;
          const ok = v.name && String(v.email).includes("@") && v.plan && v.agree === true;
          g.t2.valid = !!ok;
          if (ok) g.t2.confirmation = "CNF-" + hash(run + "t2").toString(36).toUpperCase().slice(0, 8);
          return api(res, ok ? { ok: true, confirmation: g.t2.confirmation } : { ok: false, error: "invalid form" });
        });
        return;
      }
      if (u.pathname === "/t3") {
        const rows = g.t3.rows.map((r) => `<tr><td>${r.sku}</td><td>${r.product}</td><td>${r.price}</td><td>${r.stock}</td></tr>`).join("");
        return res.end(page("catalog", `
<h1>Catalog</h1><p>150 products. Find yours.</p>
<table><thead><tr><th>SKU</th><th>Product</th><th>Price ($)</th><th>Stock</th></tr></thead><tbody>${rows}</tbody></table>`));
      }
      if (u.pathname === "/t4") {
        return res.end(page("wizard", `
<h1>Setup wizard</h1>
<div id="app">loading…</div>
<script>
const RUN=${JSON.stringify(run)};
async function step(){
  const r=await fetch('/api/t4/state?run='+RUN).then(r=>r.json());
  const app=document.getElementById('app');
  if(r.done){app.innerHTML='<p>final token: <b>'+r.token+'</b></p>';return;}
  if(r.step===0){app.innerHTML='<p>Step 1 — pick a color:</p>'+r.options.map(o=>'<button data-c="'+o+'" onclick="pick(\\''+o+'\\')">'+o+'</button>').join('');}
  else if(r.step===1){app.innerHTML='<p>Step 2 — enter the displayed number:</p><p>number: <b>'+r.number+'</b></p><input id="num"><button onclick="num()">Verify</button><p id="err"></p>';}
  else if(r.step===2){app.innerHTML='<p>Step 3 — click the word:</p>'+r.decoys.map(o=>'<button data-w="'+o+'" onclick="word(\\''+o+'\\')">'+o+'</button>').join('');}
  else if(r.step===3){app.innerHTML='<p>Step 4 — finish:</p><button onclick="finish()">Finish</button>';}
}
async function pick(c){const r=await fetch('/api/t4/pick?run='+RUN,{method:'POST',body:JSON.stringify({c})}).then(r=>r.json());if(!r.ok){document.getElementById('app').insertAdjacentHTML('afterbegin','<p style="color:red">wrong choice</p>');}step();}
async function num(){const r=await fetch('/api/t4/num?run='+RUN,{method:'POST',body:JSON.stringify({n:document.getElementById('num').value})}).then(r=>r.json());if(!r.ok){document.getElementById('err').textContent='wrong number';}step();}
async function word(w){const r=await fetch('/api/t4/word?run='+RUN,{method:'POST',body:JSON.stringify({w})}).then(r=>r.json());if(!r.ok){document.getElementById('app').insertAdjacentHTML('afterbegin','<p style="color:red">wrong word</p>');}step();}
async function finish(){await fetch('/api/t4/finish?run='+RUN,{method:'POST'});step();}
step();
</script>`));
      }
      if (u.pathname === "/api/t4/state") {
        return api(res, { step: g.t4.step, done: g.t4.step >= 4, token: g.t4.step >= 4 ? g.t4.token : null,
          number: g.t4.step === 1 ? g.t4.number : null,
          options: ["Red", "Green", "Blue"],
          decoys: g.t4.step === 2 ? [g.t4.word, ...[g.t4.word + "X", "X" + g.t4.word, g.t4.word.toLowerCase()].slice(0, 2)] : [] });
      }
      if (u.pathname === "/api/t4/pick" && req.method === "POST") {
        if (!browserOnly(req, res, host)) return;
        let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
          const v = JSON.parse(b || "{}");
          const ok = v.c === g.t4.color;
          if (ok) g.t4.step = 1; else g.t4.wrong++;
          api(res, { ok });
        });
        return;
      }
      if (u.pathname === "/api/t4/num" && req.method === "POST") {
        if (!browserOnly(req, res, host)) return;
        let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
          const v = JSON.parse(b || "{}");
          const ok = String(v.n).trim() === g.t4.number;
          if (ok) g.t4.step = 2; else g.t4.wrong++;
          api(res, { ok });
        });
        return;
      }
      if (u.pathname === "/api/t4/word" && req.method === "POST") {
        if (!browserOnly(req, res, host)) return;
        let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
          const v = JSON.parse(b || "{}");
          const ok = v.w === g.t4.word;
          if (ok) g.t4.step = 3; else g.t4.wrong++;
          api(res, { ok });
        });
        return;
      }
      if (u.pathname === "/api/t4/finish" && req.method === "POST") {
        if (!browserOnly(req, res, host)) return;
        if (g.t4.step === 3) g.t4.step = 4;
        return api(res, { ok: true });
      }
      if (u.pathname === "/t5") {
        return res.end(page("host", `
<h1>Host page</h1>
<p>The details live in the embedded panel below.</p>
<iframe src="${CHILD_BASE}/t5child?run=${run}" style="width:420px;height:180px;border:1px solid #ccc"></iframe>`));
      }
      if (u.pathname === "/api/state") {
        return api(res, {
          t1: { code: g.t1.code, claimed: g.t1.claimed },
          t2: { valid: g.t2.valid, confirmation: g.t2.confirmation },
          t3: { target: g.t3.target.product, price: g.t3.target.price, stock: g.t3.target.stock },
          t4: { step: g.t4.step, token: g.t4.token, wrong: g.t4.wrong, color: g.t4.color, number: g.t4.number, word: g.t4.word },
          t5: { code: g.t5.code, clicked: g.t5.clicked },
        });
      }
    }

    if (origin === "child") {
      const childHost = new URL(CHILD_BASE).host;
      if (u.pathname === "/t5child") {
        return res.end(page("panel", `
<h2>Secure panel</h2>
<button id="rev" onclick="fetch('${CHILD_BASE}/api/t5/reveal?run=${run}',{method:'POST'}).then(r=>r.json()).then(d=>document.getElementById('out').textContent='code: '+d.code)">Reveal code</button>
<div id="out" style="min-height:1em"></div>`));
      }
      if (u.pathname === "/api/t5/reveal" && req.method === "POST") {
        if (!browserOnly(req, res, childHost)) return;
        g.t5.clicked = true;
        return api(res, { code: g.t5.code });
      }
    }

    res.statusCode = 404;
    res.end("nope");
  });
}

let CHILD_BASE = "";

/** Start both origins; returns bases + close(). */
export async function startFixtures() {
  const child = makeServer("child");
  child.listen(0, "localhost");
  await once(child, "listening");
  CHILD_BASE = `http://localhost:${child.address().port}`;
  const parent = makeServer("parent");
  parent.listen(0, "127.0.0.1");
  await once(parent, "listening");
  const parentBase = `http://127.0.0.1:${parent.address().port}`;
  return {
    parentBase,
    childBase: CHILD_BASE,
    close: () => { child.close(); parent.close(); },
  };
}
