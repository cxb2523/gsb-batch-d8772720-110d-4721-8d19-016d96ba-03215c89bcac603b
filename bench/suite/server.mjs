/**
 * axuse benchmark suite v2 — fixture server.
 *
 * 16 deterministic, per-run-seeded web tasks that cover the things real
 * browser agents trip over: forms, big tables, multi-step flows, cross-origin
 * iframes, shadow DOM, infinite scroll, hover menus, JS dialogs, new tabs,
 * async waits, pointer drag, contenteditable, custom comboboxes, pagination
 * and canvas.
 *
 * Scoring is SERVER-SIDE: every state change POSTs here, and each task's
 * pass condition is evaluated against what the server observed — never the
 * agent's self-report alone. Ground truth is only readable with the bench key.
 *
 * Designed to be served over a public HTTPS tunnel (Codex's browser
 * extension refuses localhost/private IPs), so every URL is relative except
 * the cross-origin child, which is injected.
 */
import http from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";

export const BENCH_KEY = process.env.AXBENCH_KEY ?? randomBytes(12).toString("hex");

// ---------------- seeded RNG ----------------
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
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
const L = "ABCDEFGHJKLMNPQRSTUVWXYZ", D = "23456789";
const pick = (r, a, n) => Array.from({ length: n }, () => a[Math.floor(r() * a.length)]).join("");
const code6 = (r) => pick(r, L, 3) + pick(r, D, 3);
const FIRST = ["Ada", "Alan", "Grace", "Linus", "Barbara", "Ken", "Edsger", "Donald", "Frances", "John", "Radia", "Tim", "Margaret", "Dennis", "Bjarne", "Guido", "Anita", "Niklaus", "Leslie", "Shafi"];
const LAST = ["Lovelace", "Turing", "Hopper", "Torvalds", "Liskov", "Thompson", "Dijkstra", "Knuth", "Allen", "McCarthy", "Perlman", "Berners", "Hamilton", "Ritchie", "Stroustrup", "Rossum", "Borg", "Wirth", "Lamport", "Goldwasser"];
const CITIES = ["Zurich", "Zurich Airport", "Zurichberg", "Zug", "Geneva", "Basel", "Bern", "Lausanne", "Lucerne", "Lugano", "Winterthur", "St. Gallen", "Biel", "Thun", "Vienna", "Munich", "Milan", "Lyon", "Paris", "Berlin", "Hamburg", "Prague", "Warsaw", "Madrid", "Lisbon", "Oslo", "Stockholm", "Helsinki", "Dublin", "Amsterdam", "Brussels", "Copenhagen", "Budapest", "Rome", "Turin", "Graz", "Salzburg", "Innsbruck", "Freiburg", "Stuttgart"];
const COUNTRIES = ["Austria", "Belgium", "Denmark", "France", "Germany", "Italy", "Netherlands", "Norway", "Poland", "Portugal", "Spain", "Sweden", "Swaziland", "Switzerland", "Sweden (EU)"];

const SHOP = [
  ["Trail Runner", "Shoes", 129], ["Road Racer", "Shoes", 149], ["Trail Runner GTX", "Shoes", 169], ["City Walker", "Shoes", 99],
  ["Rain Shell", "Jackets", 189], ["Rain Shell Lite", "Jackets", 149], ["Down Parka", "Jackets", 279], ["Wind Vest", "Jackets", 89],
  ["Merino Tee", "Tops", 59], ["Running Tank", "Tops", 35], ["Thermal Crew", "Tops", 65], ["Trail Shorts", "Bottoms", 55],
  ["Hiking Pants", "Bottoms", 95], ["Rain Pants", "Bottoms", 119], ["Trail Socks", "Accessories", 18], ["Running Cap", "Accessories", 25],
].map(([name, cat, price], i) => ({ id: "p" + (i + 1), name, cat, price }));
const COLORS = ["Black", "Blue", "Red"];
export const LOCAL_TASKS = new Set(["t17"]);

const runs = new Map();
function ground(run) {
  if (runs.has(run)) return runs.get(run);
  const r = mulberry32(hash(run));
  // t3 catalog
  const t3rows = Array.from({ length: 150 }, (_, i) => ({ sku: `SKU-${1000 + i}`, product: `Widget ${pick(r, L, 2)}-${pick(r, D, 3)}`, price: (2 + r() * 480).toFixed(2), stock: Math.floor(r() * 90) + 1 }));
  const t3t = t3rows[Math.floor(r() * 150)]; t3t.product = `Widget TARGET-${pick(r, L, 3)}`;
  // t7 feed
  const feed = Array.from({ length: 300 }, (_, i) => ({ id: `p${i}`, author: `@${FIRST[Math.floor(r() * 20)].toLowerCase()}_${pick(r, "abcdefghjkmnpqrstuvwxyz", 4)}`, text: `Post #${i + 1}: ${["shipping update", "weekly notes", "bug triage", "release plan", "design review"][Math.floor(r() * 5)]}` }));
  const t7idx = 170 + Math.floor(r() * 110);
  // t15 orders
  const orders = [];
  for (let i = 0; i < 240; i++) {
    orders.push({ id: `ORD-${5000 + i}`, customer: `${FIRST[Math.floor(r() * 20)]} ${LAST[Math.floor(r() * 20)]}`, status: ["Paid", "Shipped", "Pending", "Paid", "Shipped"][Math.floor(r() * 5)], total: (10 + r() * 900).toFixed(2), code: code6(r) });
  }
  const tgtCustomer = `${FIRST[Math.floor(r() * 20)]} Q. ${LAST[Math.floor(r() * 20)]}`;
  const slots = new Set(); while (slots.size < 4) slots.add(40 + Math.floor(r() * 190));
  const [s0, ...rest] = [...slots];
  orders[s0] = { ...orders[s0], customer: tgtCustomer, status: "Refunded" };
  rest.forEach((s, k) => (orders[s] = { ...orders[s], customer: tgtCustomer, status: ["Paid", "Shipped", "Pending"][k] }));
  // t16 canvas circles
  const colors = ["red", "blue", "green", "orange", "purple"];
  const circles = colors.map((c, i) => ({ color: c, x: 70 + i * 115 + Math.floor(r() * 20), y: 80 + Math.floor(r() * 140), rad: 26 }));
  for (let i = circles.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [circles[i].x, circles[j].x] = [circles[j].x, circles[i].x]; }
  const g = {
    t1: { code: code6(r), claimed: false },
    t2: { valid: false, confirmation: null, got: null },
    t3: { rows: t3rows, target: t3t },
    t4: { color: ["Red", "Green", "Blue"][Math.floor(r() * 3)], number: String(100 + Math.floor(r() * 900)), word: pick(r, L, 5), token: pick(r, L, 4) + pick(r, D, 4), step: 0, wrong: 0 },
    t5: { code: code6(r), clicked: false },
    t6: { ref: code6(r), saved: null },
    t7: { feed, idx: t7idx, likes: [], code: code6(r) },
    t8: { code: code6(r), exported: false, deleted: false },
    t9: { files: ["report-q3.pdf", "old-backup.zip", "notes.txt", "photo.png", "archive-2024.tar"], target: "old-backup.zip", deletes: [], code: code6(r) },
    t10: { code: code6(r), helpViewed: false, verified: false, attempts: 0, receipt: code6(r) },
    t11: { started: null, downloaded: false, early: 0, code: code6(r) },
    t12: { cols: { "To do": ["Write docs", "Fix login bug", "Update deps"], "In progress": ["Refactor API"], Done: ["Set up CI"] }, card: "Fix login bug", code: code6(r) },
    t13: { want: "Release 4.2 fixes the export bug.", got: null, code: code6(r) },
    t14: { got: null, code: code6(r) },
    t15: { orders, customer: tgtCustomer, target: orders[s0].id, viewed: [] },
    t16: { circles, hits: [], code: code6(r) },
    t17: { todos: null, code: code6(r) },
    t18: { cart: [], coupon: null, order: null, orderNo: "ORD-" + pick(r, D, 6) },
    t19: { rows: Array.from({ length: 1200 }, (_, i) => ({ id: `INV-${10000 + i}`, vendor: `${LAST[Math.floor(r() * 20)]} GmbH`, amount: (50 + r() * 9000).toFixed(2) })), idx: 700 + Math.floor(r() * 450), approved: [], code: code6(r) },
    t20: { saved: null, code: code6(r) },
    t21: { attempts: [], created: null, code: code6(r) },
    t22: { got: null, code: code6(r) },
    t23: { upload: null, want: "axbench-avatar-" + pick(r, L, 4).toLowerCase() + ".txt", content: "avatar:" + pick(r, L, 8), code: code6(r) },
  };
  runs.set(run, g);
  return g;
}

// ---------------- page shell ----------------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const page = (title, body, script = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui,sans-serif;max-width:900px;margin:24px auto;padding:0 16px;color:#222}
table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 10px;font-size:14px}
button{padding:6px 14px;margin:4px;cursor:pointer}input,select{margin:4px;padding:4px}.out{min-height:1.4em;font-size:18px;margin-top:8px}</style>
</head><body>${body}<script>
const RUN=new URLSearchParams(location.search).get('run');
async function post(path,body){const r=await fetch(path+(path.includes('?')?'&':'?')+'run='+encodeURIComponent(RUN),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});return r.json();}
${script}</script></body></html>`;

const json = (res, obj, status = 200) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.setHeader("cache-control", "no-store"); res.end(JSON.stringify(obj)); };
const html = (res, s) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.setHeader("cache-control", "no-store"); res.end(s); };

/** Browser-only gate: fetch() from a page always carries Sec-Fetch-*; shells don't. */
function browserOnly(req, res) {
  const site = req.headers["sec-fetch-site"], mode = req.headers["sec-fetch-mode"];
  if (!site || site === "none" || !mode || mode === "navigate") {
    json(res, { error: "browser-only endpoint: complete this action in a real browser page" }, 403);
    return false;
  }
  return true;
}
const readBody = (req) => new Promise((ok) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { try { ok(JSON.parse(b || "{}")); } catch { ok({}); } }); });

// ---------------- task pages ----------------
const P = {};

P.t1 = () => page("Claim", `<h1>Claim your code</h1><p>Press the button to reveal your personal code.</p>
<button id="claim">Claim code</button><div class="out" id="out"></div>`,
`claim.onclick=async()=>{const d=await post('/api/t1/claim');out.textContent='code: '+d.code;};`);

P.t2 = () => page("Create account", `<h1>Create account</h1>
<form id="f"><label for="f1">Full name</label><input id="f1"><br>
<label for="f2">Email</label><input id="f2" type="email"><br>
<label for="sel">Plan</label><select id="sel"><option value="">—</option><option>Alpha</option><option>Beta</option><option>Gamma</option></select><br>
<input type="checkbox" id="cb"><label for="cb">I agree</label><br><button type="submit">Submit</button></form><div class="out" id="out"></div>`,
`f.onsubmit=async(e)=>{e.preventDefault();const d=await post('/api/t2/submit',{name:f1.value,email:f2.value,plan:sel.value,agree:cb.checked});out.textContent=d.ok?('confirmation: '+d.confirmation):('error: '+d.error);};`);

P.t3 = (g) => page("Catalog", `<h1>Catalog</h1><p>150 products.</p><table><thead><tr><th>SKU</th><th>Product</th><th>Price ($)</th><th>Stock</th></tr></thead><tbody>${g.t3.rows.map((x) => `<tr><td>${x.sku}</td><td>${x.product}</td><td>${x.price}</td><td>${x.stock}</td></tr>`).join("")}</tbody></table>`);

P.t4 = () => page("Wizard", `<h1>Setup wizard</h1><div id="app">loading…</div>`, `
async function step(msg){const r=await (await fetch('/api/t4/state?run='+RUN)).json();
if(r.done){app.innerHTML='<p>final token: <b>'+r.token+'</b></p>';return;}
let h=msg?'<p style="color:#b00">'+msg+'</p>':'';
if(r.step===0)h+='<p>Step 1 of 4 — pick the color the server expects. (Hint: it is the color of the sky on a clear day, unless it is not.)</p>'+['Red','Green','Blue'].map(o=>'<button data-c="'+o+'">'+o+'</button>').join('');
if(r.step===1)h+='<p>Step 2 of 4 — enter the displayed number:</p><p>number: <b>'+r.number+'</b></p><input id="num" aria-label="Number"><button id="v">Verify</button>';
if(r.step===2)h+='<p>Step 3 of 4 — click the exact word <b>'+r.word+'</b>:</p>'+r.decoys.map(o=>'<button data-w="'+o+'">'+o+'</button>').join('');
if(r.step===3)h+='<p>Step 4 of 4 — finish:</p><button id="fin">Finish</button>';
app.innerHTML=h;
app.querySelectorAll('[data-c]').forEach(b=>b.onclick=async()=>{const d=await post('/api/t4/pick',{c:b.dataset.c});step(d.ok?'':'wrong choice — try another color');});
app.querySelectorAll('[data-w]').forEach(b=>b.onclick=async()=>{const d=await post('/api/t4/word',{w:b.dataset.w});step(d.ok?'':'wrong word');});
const v=document.getElementById('v');if(v)v.onclick=async()=>{const d=await post('/api/t4/num',{n:document.getElementById('num').value});step(d.ok?'':'wrong number');};
const f=document.getElementById('fin');if(f)f.onclick=async()=>{await post('/api/t4/finish');step();};}
step();`);

P.t5 = (g, base) => page("Host", `<h1>Host page</h1><p>The details live in the embedded secure panel below.</p>
<iframe title="Secure panel" src="${base.child}/t5child?run=${encodeURIComponent(g.__run)}" style="width:440px;height:200px;border:1px solid #ccc"></iframe>`);

P.t6 = () => page("Preferences", `<h1>Notification preferences</h1><notify-settings></notify-settings><div class="out" id="out"></div>`, `
class ToggleSwitch extends HTMLElement{constructor(){super();const s=this.attachShadow({mode:'open'});s.innerHTML='<style>button{width:46px;height:24px;border-radius:12px;border:1px solid #888;background:#ddd}button[aria-checked=true]{background:#2a7}</style><button role="switch" aria-checked="false" aria-label="'+this.getAttribute('label')+'"></button>';this.btn=s.querySelector('button');this.btn.onclick=()=>{this.btn.setAttribute('aria-checked',String(this.btn.getAttribute('aria-checked')!=='true'));};}get on(){return this.btn.getAttribute('aria-checked')==='true';}}
customElements.define('toggle-switch',ToggleSwitch);
class NotifySettings extends HTMLElement{constructor(){super();const s=this.attachShadow({mode:'open'});
s.innerHTML='<style>fieldset{margin:10px 0}</style><fieldset><legend>Channels</legend><label>Email alerts <toggle-switch label="Email alerts"></toggle-switch></label><br><label>SMS alerts <toggle-switch label="SMS alerts"></toggle-switch></label></fieldset><fieldset><legend>Digest frequency</legend><label><input type="radio" name="fq" value="Daily" checked> Daily</label><label><input type="radio" name="fq" value="Weekly"> Weekly</label><label><input type="radio" name="fq" value="Monthly"> Monthly</label></fieldset><button id="save">Save preferences</button>';
s.getElementById('save').onclick=async()=>{const t=s.querySelectorAll('toggle-switch');const fq=s.querySelector('input[name=fq]:checked').value;const d=await post('/api/t6/save',{email:t[0].on,sms:t[1].on,frequency:fq});document.getElementById('out').textContent=d.ok?'Saved. Reference: '+d.ref:'Saved settings do not match what was requested.';};}}
customElements.define('notify-settings',NotifySettings);`);

P.t7 = () => page("Feed", `<h1>Team feed</h1><div id="feed"></div><div id="sentinel" style="height:40px">Loading more…</div><div class="out" id="out" style="position:fixed;top:0;right:12px;background:#ffd;padding:4px 8px"></div>`, `
let next=0,busy=false;async function more(){if(busy)return;busy=true;const r=await (await fetch('/api/t7/page?run='+RUN+'&from='+next)).json();
for(const p of r.items){const d=document.createElement('article');d.style.cssText='border:1px solid #ddd;margin:8px 0;padding:8px';d.innerHTML='<b>'+p.author+'</b><p>'+p.text+'</p><button>Like</button>';d.querySelector('button').onclick=async()=>{const x=await post('/api/t7/like',{id:p.id});document.getElementById('out').textContent=x.code?('Liked! code: '+x.code):'Liked.';};feed.appendChild(d);}
next+=r.items.length;if(!r.more)sentinel.textContent='End of feed';busy=false;}
new IntersectionObserver(e=>{if(e[0].isIntersecting)more();}).observe(sentinel);`);

P.t8 = () => page("Dashboard", `<style>#menu{position:relative;display:inline-block}#sub{display:none;position:absolute;top:100%;left:0;background:#fff;border:1px solid #ccc;min-width:180px;z-index:2}#sub.open{display:block}#sub a{display:block;padding:6px 10px}</style>
<nav><a href="#">Home</a> · <span id="menu"><a href="#" id="acct" aria-haspopup="true" onclick="return false">Account ▾</a><div id="sub" role="menu"><a role="menuitem" href="#" data-a="profile">Profile</a><a role="menuitem" href="#" data-a="export">Export data</a><a role="menuitem" href="#" data-a="delete">Delete account</a></div></span></nav>
<h1>Dashboard</h1><p>Welcome back.</p><div class="out" id="out"></div>`, `
let t;menu.onmouseenter=()=>{clearTimeout(t);sub.classList.add('open');};menu.onmouseleave=()=>{t=setTimeout(()=>sub.classList.remove('open'),250);};
sub.querySelectorAll('a').forEach(a=>a.onclick=async(e)=>{e.preventDefault();const d=await post('/api/t8/'+a.dataset.a);out.textContent=d.msg;});`);

P.t9 = (g) => page("Files", `<h1>Files</h1><table><thead><tr><th>Name</th><th></th></tr></thead><tbody>${g.t9.files.map((f) => `<tr><td>${f}</td><td><button data-f="${f}" aria-label="Delete ${f}">Delete</button></td></tr>`).join("")}</tbody></table><div class="out" id="out"></div>`, `
document.querySelectorAll('[data-f]').forEach(b=>b.onclick=async()=>{const f=b.dataset.f;if(!confirm('Delete '+f+'? This cannot be undone.'))return;const why=prompt('Type the reason for deleting '+f+':');if(why===null)return;const d=await post('/api/t9/delete',{file:f,reason:why});if(d.ok){b.closest('tr').remove();}out.textContent=d.msg;});`);

P.t10 = () => page("Verify", `<h1>Verify your account</h1><p>Your verification code is shown in the <a href="/t10help?run=__RUN__" target="_blank" rel="opener">help center</a> (opens in a new tab). Enter it below.</p>
<input id="code" aria-label="Verification code"><button id="go">Verify</button><div class="out" id="out"></div>`, `
document.querySelector('a').href='/t10help?run='+encodeURIComponent(RUN);go.onclick=async()=>{const d=await post('/api/t10/verify',{code:code.value});out.textContent=d.msg;};`);
P.t10help = () => page("Help center", `<h1>Help center</h1><p>Your verification code is: <b id="c">…</b></p>`, `fetch('/api/t10/help?run='+RUN,{method:'POST'}).then(r=>r.json()).then(d=>c.textContent=d.code);`);

P.t11 = () => page("Reports", `<h1>Reports</h1><button id="gen">Generate report</button><div id="status" class="out"></div><div id="dl"></div><div class="out" id="out"></div>`, `
gen.onclick=async()=>{gen.disabled=true;await post('/api/t11/start');status.textContent='Generating… (this takes a few seconds)';
const iv=setInterval(async()=>{const s=await (await fetch('/api/t11/status?run='+RUN)).json();if(s.ready){clearInterval(iv);status.textContent='Report ready.';dl.innerHTML='<button id="d">Download report</button>';document.getElementById('d').onclick=async()=>{const x=await post('/api/t11/download');out.textContent=x.msg;};}else status.textContent='Generating… '+s.pct+'%';},500);};`);

P.t12 = (g) => page("Board", `<style>.cols{display:flex;gap:12px}.col{flex:1;border:1px solid #ccc;min-height:260px;padding:8px;background:#fafafa}.card{background:#fff;border:1px solid #999;padding:8px;margin:6px 0;cursor:grab;user-select:none;touch-action:none}.drag{opacity:.6}.over{background:#e6f4ff}</style>
<h1>Sprint board</h1><p>Drag cards between columns.</p><div class="cols">${Object.entries(g.t12.cols).map(([c, cards]) => `<section class="col" data-col="${c}" aria-label="${c} column"><h2>${c}</h2>${cards.map((k) => `<div class="card" role="listitem">${k}</div>`).join("")}</section>`).join("")}</div><div class="out" id="out"></div>`, `
let drag=null,ghost=null;
document.addEventListener('pointerdown',e=>{const c=e.target.closest('.card');if(!c)return;drag=c;c.classList.add('drag');c.setPointerCapture?.(e.pointerId);});
document.addEventListener('pointermove',e=>{if(!drag)return;document.querySelectorAll('.col').forEach(x=>x.classList.remove('over'));const el=document.elementsFromPoint(e.clientX,e.clientY).find(x=>x.classList&&x.classList.contains('col'));if(el)el.classList.add('over');});
document.addEventListener('pointerup',async e=>{if(!drag)return;const c=drag;drag=null;c.classList.remove('drag');document.querySelectorAll('.col').forEach(x=>x.classList.remove('over'));
const col=document.elementsFromPoint(e.clientX,e.clientY).find(x=>x.classList&&x.classList.contains('col'));if(!col||col.contains(c))return;col.appendChild(c);const d=await post('/api/t12/move',{card:c.textContent,to:col.dataset.col});out.textContent=d.msg;});`);

P.t13 = () => page("Release notes", `<h1>New release note</h1><div id="ed" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Release note editor" style="border:1px solid #888;min-height:100px;padding:8px"></div>
<button id="pub">Publish</button><div class="out" id="out"></div>`, `pub.onclick=async()=>{const d=await post('/api/t13/publish',{text:ed.innerText});out.textContent=d.msg;};`);

P.t14 = () => page("Shipping", `<style>.lb{border:1px solid #888;max-height:180px;overflow:auto;position:absolute;background:#fff;z-index:3;min-width:220px;margin:0;padding:0;list-style:none}.lb li{padding:4px 8px;cursor:pointer}.lb li:hover{background:#eef}.wrap{position:relative;margin:10px 0}</style>
<h1>Shipping destination</h1>
<div class="wrap"><label id="cl">City</label><br><input id="city" role="combobox" aria-labelledby="cl" aria-autocomplete="list" aria-expanded="false" aria-controls="cityl" autocomplete="off" placeholder="Start typing…"><ul id="cityl" class="lb" role="listbox" hidden></ul></div>
<div class="wrap"><span id="ctl">Country</span><br><button id="country" aria-haspopup="listbox" aria-labelledby="ctl country" aria-expanded="false">Choose…</button><ul id="cl2" class="lb" role="listbox" hidden></ul></div>
<button id="sub">Save destination</button><div class="out" id="out"></div>`, `
const CITIES=${JSON.stringify(CITIES)},COUNTRIES=${JSON.stringify(COUNTRIES)};let cityVal='',countryVal='';
city.oninput=()=>{const q=city.value.trim().toLowerCase();cityVal='';if(!q){cityl.hidden=true;return;}setTimeout(()=>{const m=CITIES.filter(c=>c.toLowerCase().startsWith(q));cityl.innerHTML=m.map(c=>'<li role="option">'+c+'</li>').join('');cityl.hidden=!m.length;city.setAttribute('aria-expanded',String(!!m.length));cityl.querySelectorAll('li').forEach(li=>li.onmousedown=(e)=>{e.preventDefault();cityVal=li.textContent;city.value=cityVal;cityl.hidden=true;city.setAttribute('aria-expanded','false');});},300);};
country.onclick=()=>{cl2.innerHTML=COUNTRIES.map(c=>'<li role="option">'+c+'</li>').join('');cl2.hidden=!cl2.hidden;country.setAttribute('aria-expanded',String(!cl2.hidden));cl2.querySelectorAll('li').forEach(li=>li.onclick=()=>{countryVal=li.textContent;country.textContent=countryVal;cl2.hidden=true;country.setAttribute('aria-expanded','false');});};
sub.onclick=async()=>{const d=await post('/api/t14/save',{city:cityVal,typed:city.value,country:countryVal});out.textContent=d.msg;};`);

P.t15 = () => page("Orders", `<h1>Orders</h1><label for="q">Search customer</label><input id="q" type="search"><table><thead><tr><th>Order</th><th>Customer</th><th>Status</th><th>Total</th><th></th></tr></thead><tbody id="tb"></tbody></table>
<div><button id="prev">Previous</button> <span id="pg"></span> <button id="nxt">Next</button></div><div class="out" id="out"></div>`, `
let pageNo=0,q='',timer;async function load(){const r=await (await fetch('/api/t15/list?run='+RUN+'&page='+pageNo+'&q='+encodeURIComponent(q))).json();
tb.innerHTML=r.rows.map(o=>'<tr><td>'+o.id+'</td><td>'+o.customer+'</td><td>'+o.status+'</td><td>'+o.total+'</td><td><button data-id="'+o.id+'">Details</button></td></tr>').join('');
pg.textContent='Page '+(pageNo+1)+' of '+r.pages;prev.disabled=pageNo===0;nxt.disabled=pageNo>=r.pages-1;
tb.querySelectorAll('button').forEach(b=>b.onclick=async()=>{const d=await post('/api/t15/details',{id:b.dataset.id});out.textContent=d.msg;});}
q_=document.getElementById('q');q_.oninput=()=>{clearTimeout(timer);timer=setTimeout(()=>{q=q_.value;pageNo=0;load();},400);};prev.onclick=()=>{pageNo--;load();};nxt.onclick=()=>{pageNo++;load();};load();`);

P.t16 = (g) => page("Canvas", `<h1>Target practice</h1><p>Click the requested shape on the canvas.</p><canvas id="cv" width="640" height="300" style="border:1px solid #888"></canvas><div class="out" id="out"></div>`, `
const C=${JSON.stringify(g.t16.circles)};const x=cv.getContext('2d');C.forEach(c=>{x.beginPath();x.arc(c.x,c.y,c.rad,0,7);x.fillStyle=c.color;x.fill();});
cv.onclick=async(e)=>{const r=cv.getBoundingClientRect();const d=await post('/api/t16/hit',{x:(e.clientX-r.left)*cv.width/r.width,y:(e.clientY-r.top)*cv.height/r.height});out.textContent=d.msg;};`);

P.t17 = () => page("Todo (dev)", `<h1>Todo — local dev build</h1>
<form id="f"><label for="new">New todo</label><input id="new" autocomplete="off"><button>Add</button></form>
<ul id="list" style="list-style:none;padding:0"></ul><button id="sync">Sync to server</button><div class="out" id="out"></div>`, `
let todos=[];function render(){list.innerHTML=todos.map((t,i)=>'<li><input type="checkbox" id="c'+i+'" '+(t.done?'checked':'')+'><label for="c'+i+'">'+t.text+'</label> <button data-del="'+i+'" aria-label="Delete '+t.text+'">✕</button></li>').join('');
list.querySelectorAll('input').forEach((c,i)=>c.onchange=()=>{todos[i].done=c.checked;});list.querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>{todos.splice(+b.dataset.del,1);render();});}
f.onsubmit=(e)=>{e.preventDefault();const v=document.getElementById('new').value.trim();if(v){todos.push({text:v,done:false});document.getElementById('new').value='';render();}};
sync.onclick=async()=>{const d=await post('/api/t17/sync',{todos});out.textContent=d.msg;};`);

P.t18 = () => page("Shop", `<h1>Outdoor Shop</h1><label for="q">Search</label><input id="q" type="search"> <label for="cat">Category</label><select id="cat"><option value="">All</option>${[...new Set(SHOP.map((p) => p.cat))].map((c) => `<option>${c}</option>`).join("")}</select>
<p><a id="cartlink" href="#">Cart</a></p><ul id="res"></ul>`, `
const SHOP=${JSON.stringify(SHOP)};cartlink.href='/t18cart?run='+encodeURIComponent(RUN);
function render(){const qv=q.value.toLowerCase().trim(),c=cat.value;res.innerHTML=SHOP.filter(p=>(!qv||p.name.toLowerCase().includes(qv))&&(!c||p.cat===c)).map(p=>'<li><a href="/t18p?id='+p.id+'&run='+encodeURIComponent(RUN)+'">'+p.name+'</a> — CHF '+p.price+'</li>').join('')||'<li>No products found.</li>';}
q.oninput=render;cat.onchange=render;render();`);

P.t18p = (g, base, u) => {
  const p = SHOP.find((x) => x.id === u.searchParams.get("id")) ?? SHOP[0];
  return page(p.name, `<p><a href="/t18?run=__R__" id="back">← Back to shop</a> · <a href="/t18cart?run=__R__" id="cl">Cart</a></p><h1>${p.name}</h1><p>CHF ${p.price} · ${p.cat}</p>
<label for="size">Size</label><select id="size"><option value="">Choose size</option><option>S</option><option>M</option><option>L</option></select>
<fieldset><legend>Color</legend>${COLORS.map((c) => `<label><input type="radio" name="color" value="${c}">${c}</label>`).join(" ")}</fieldset>
<label for="qty">Quantity</label><input id="qty" type="number" min="1" value="1" style="width:60px"> <button id="add">Add to cart</button><div class="out" id="out"></div>`,
  `document.querySelectorAll('a').forEach(a=>a.href=a.href.replace('__R__',encodeURIComponent(RUN)));
add.onclick=async()=>{const col=document.querySelector('input[name=color]:checked');if(!size.value||!col){out.textContent='Please choose a size and a color.';return;}const d=await post('/api/t18/add',{id:${JSON.stringify(p.id)},size:size.value,color:col.value,qty:+qty.value});out.textContent=d.msg;};`);
};

P.t18cart = (g) => page("Cart", `<p><a href="/t18?run=__R__">← Continue shopping</a></p><h1>Your cart</h1><table><thead><tr><th>Item</th><th>Size</th><th>Color</th><th>Qty</th><th>Price</th><th></th></tr></thead><tbody id="tb"></tbody></table>
<p id="tot"></p><label for="coupon">Coupon code</label><input id="coupon"><button id="apply">Apply</button><div class="out" id="cmsg"></div><p><a id="co" href="/t18checkout?run=__R__">Proceed to checkout</a></p>`, `
document.querySelectorAll('a').forEach(a=>a.href=a.href.replace('__R__',encodeURIComponent(RUN)));
async function load(){const c=await (await fetch('/api/t18/cart?run='+RUN)).json();tb.innerHTML=c.items.map((it,i)=>'<tr><td>'+it.name+'</td><td>'+it.size+'</td><td>'+it.color+'</td><td><input type="number" min="0" value="'+it.qty+'" aria-label="Quantity of '+it.name+' '+it.size+' '+it.color+'" data-i="'+i+'" style="width:56px"></td><td>CHF '+(it.price*it.qty)+'</td><td><button data-rm="'+i+'" aria-label="Remove '+it.name+' '+it.size+' '+it.color+'">Remove</button></td></tr>').join('');
tot.textContent='Total: CHF '+c.total+(c.coupon?' (coupon '+c.coupon+' applied)':'');
tb.querySelectorAll('input').forEach(x=>x.onchange=async()=>{await post('/api/t18/qty',{i:+x.dataset.i,qty:+x.value});load();});
tb.querySelectorAll('[data-rm]').forEach(b=>b.onclick=async()=>{await post('/api/t18/qty',{i:+b.dataset.rm,qty:0});load();});}
apply.onclick=async()=>{const d=await post('/api/t18/coupon',{code:coupon.value});cmsg.textContent=d.msg;load();};load();`);

P.t18checkout = () => page("Checkout", `<h1>Checkout</h1><form id="f">
<label for="nm">Full name</label><input id="nm" required><br><label for="st">Street</label><input id="st" required><br>
<label for="zip">ZIP</label><input id="zip" required><span id="ziperr" style="color:#b00"></span><br><label for="ci">City</label><input id="ci" required><br>
<label for="ct">Country</label><select id="ct"><option value="">Choose…</option><option>Austria</option><option>Germany</option><option>Switzerland</option></select><br>
<fieldset><legend>Shipping</legend><label><input type="radio" name="ship" value="Standard" checked>Standard (free)</label><label><input type="radio" name="ship" value="Express">Express (CHF 15)</label></fieldset>
<button>Place order</button></form><div class="out" id="out"></div>`, `
f.onsubmit=async(e)=>{e.preventDefault();ziperr.textContent='';if(!/^\\d{4}$/.test(zip.value.trim())){ziperr.textContent=' ZIP must be 4 digits';return;}
const d=await post('/api/t18/order',{name:nm.value,street:st.value,zip:zip.value.trim(),city:ci.value,country:ct.value,ship:document.querySelector('input[name=ship]:checked').value});out.textContent=d.msg;};`);

P.t19 = () => page("Invoices", `<h1>Invoice approvals</h1><p>1,200 pending invoices.</p><div id="vp" role="grid" aria-label="Invoices" aria-rowcount="1200" style="height:420px;overflow:auto;border:1px solid #888;position:relative"><div id="spacer" style="position:relative"></div></div><div class="out" id="out"></div>`, `
const H=34;let rows=[];fetch('/api/t19/rows?run='+RUN).then(r=>r.json()).then(d=>{rows=d.rows;spacer.style.height=(rows.length*H)+'px';draw();});
function draw(){const top=vp.scrollTop,first=Math.max(0,Math.floor(top/H)-3),last=Math.min(rows.length,Math.ceil((top+vp.clientHeight)/H)+3);
spacer.innerHTML=rows.slice(first,last).map((r,k)=>{const i=first+k;return '<div role="row" aria-rowindex="'+(i+1)+'" style="position:absolute;top:'+(i*H)+'px;left:0;right:0;height:'+H+'px;display:flex;gap:16px;align-items:center;padding:0 8px;border-bottom:1px solid #eee"><span role="gridcell" style="width:110px">'+r.id+'</span><span role="gridcell" style="width:180px">'+r.vendor+'</span><span role="gridcell" style="width:100px">'+r.amount+'</span><button data-id="'+r.id+'" aria-label="Approve '+r.id+'">Approve</button></div>';}).join('');
spacer.querySelectorAll('button').forEach(b=>b.onclick=async()=>{const d=await post('/api/t19/approve',{id:b.dataset.id});out.textContent=d.msg;});}
vp.addEventListener('scroll',draw);`);

P.t20 = () => page("Trip dates", `<style>.cal{border:1px solid #888;padding:8px;display:inline-block;background:#fff}.cal table td{padding:0}.cal button{width:36px;margin:1px}</style>
<h1>Plan your trip</h1><div><label for="dep">Departure</label> <input id="dep" readonly placeholder="Pick a date" aria-haspopup="dialog"></div>
<div><label for="ret">Return</label> <input id="ret" readonly placeholder="Pick a date" aria-haspopup="dialog"></div><div id="calhost"></div><button id="save">Save dates</button><div class="out" id="out"></div>`, `
const M=['January','February','March','April','May','June','July','August','September','October','November','December'];let target=null,y=2026,m=9;
function open(inp){target=inp;y=2026;m=9;draw();}
function draw(){const first=new Date(Date.UTC(y,m,1)).getUTCDay(),days=new Date(Date.UTC(y,m+1,0)).getUTCDate();let h='<div class="cal" role="dialog" aria-label="Choose date"><button id="pv" aria-label="Previous month">‹</button> <b id="ml">'+M[m]+' '+y+'</b> <button id="nx" aria-label="Next month">›</button><table><tr>'+['Su','Mo','Tu','We','Th','Fr','Sa'].map(d=>'<th>'+d+'</th>').join('')+'</tr><tr>';
let c=0;for(let i=0;i<first;i++){h+='<td></td>';c++;}for(let d=1;d<=days;d++){h+='<td><button data-d="'+d+'" aria-label="'+M[m]+' '+d+', '+y+'">'+d+'</button></td>';c++;if(c%7===0)h+='</tr><tr>';}h+='</tr></table></div>';calhost.innerHTML=h;
pv.onclick=()=>{m--;if(m<0){m=11;y--;}draw();};nx.onclick=()=>{m++;if(m>11){m=0;y++;}draw();};
calhost.querySelectorAll('[data-d]').forEach(b=>b.onclick=()=>{target.value=y+'-'+String(m+1).padStart(2,'0')+'-'+String(b.dataset.d).padStart(2,'0');calhost.innerHTML='';});}
dep.onclick=()=>open(dep);ret.onclick=()=>open(ret);save.onclick=async()=>{const d=await post('/api/t20/save',{dep:dep.value,ret:ret.value});out.textContent=d.msg;};`);

P.t21 = () => page("Sign up", `<h1>Create your account</h1><form id="f" novalidate>
<label for="u">Username</label><input id="u" autocomplete="off"><span class="err" id="eu" style="color:#b00"></span><br>
<label for="pw">Password</label><input id="pw" type="password"><span class="err" id="ep" style="color:#b00"></span><br>
<label for="pw2">Confirm password</label><input id="pw2" type="password"><span class="err" id="ep2" style="color:#b00"></span><br>
<label for="bd">Date of birth (YYYY-MM-DD)</label><input id="bd"><span class="err" id="eb" style="color:#b00"></span><br>
<input type="checkbox" id="tos"><label for="tos">I accept the terms</label><span class="err" id="et" style="color:#b00"></span><br>
<button>Create account</button></form><div class="out" id="out"></div>`, `
f.onsubmit=async(e)=>{e.preventDefault();document.querySelectorAll('.err').forEach(x=>x.textContent='');const d=await post('/api/t21/signup',{u:u.value,pw:pw.value,pw2:pw2.value,bd:bd.value,tos:tos.checked});
if(d.ok){out.textContent='Welcome! Account code: '+d.code;return;}out.textContent='Please fix the errors above.';for(const [k,v] of Object.entries(d.errors||{}))document.getElementById(k).textContent=' '+v;};`);

P.t22 = (g, base) => page("Portal", `<h1>Partner portal</h1><p>The partner widget is embedded below.</p>
<iframe title="Partner widget" src="${base.child}/t22outer?run=${encodeURIComponent(g.__run)}" style="width:560px;height:330px;border:1px solid #ccc"></iframe>`);

P.t23 = () => page("Profile", `<h1>Profile picture</h1><form id="f"><label for="av">Avatar file</label> <input type="file" id="av"> <button>Upload</button></form><div class="out" id="out"></div>`, `
f.onsubmit=async(e)=>{e.preventDefault();const file=av.files[0];if(!file){out.textContent='Choose a file first.';return;}const text=await file.text();const d=await post('/api/t23/upload',{name:file.name,size:file.size,text:text.slice(0,200)});out.textContent=d.msg;};`);

// ---------------- scoring (server truth) ----------------
export const SCORE = {
  t1: (g, a) => g.t1.claimed && a.includes(g.t1.code),
  t2: (g, a) => g.t2.valid && a.includes(g.t2.confirmation),
  t3: (g, a) => a.includes(g.t3.target.price) && a.includes(String(g.t3.target.stock)),
  t4: (g, a) => g.t4.step >= 4 && a.includes(g.t4.token),
  t5: (g, a) => g.t5.clicked && a.includes(g.t5.code),
  t6: (g, a) => !!g.t6.saved && g.t6.saved.email === true && g.t6.saved.sms === false && g.t6.saved.frequency === "Weekly" && a.includes(g.t6.ref),
  t7: (g, a) => g.t7.likes.length === 1 && g.t7.likes[0] === g.t7.feed[g.t7.idx].id && a.includes(g.t7.code),
  t8: (g, a) => g.t8.exported && !g.t8.deleted && a.includes(g.t8.code),
  t9: (g, a) => g.t9.deletes.length === 1 && g.t9.deletes[0].file === g.t9.target && g.t9.deletes[0].reason.trim().toLowerCase() === "cleanup" && a.includes(g.t9.code),
  t10: (g, a) => g.t10.helpViewed && g.t10.verified && a.includes(g.t10.receipt),
  t11: (g, a) => g.t11.downloaded && a.includes(g.t11.code),
  t12: (g, a) => g.t12.cols.Done.includes(g.t12.card) && a.includes(g.t12.code),
  t13: (g, a) => g.t13.got?.trim() === g.t13.want && a.includes(g.t13.code),
  t14: (g, a) => g.t14.got?.city === "Zurich" && g.t14.got?.country === "Switzerland" && a.includes(g.t14.code),
  t15: (g, a) => g.t15.viewed.includes(g.t15.target) && a.includes(g.t15.orders.find((o) => o.id === g.t15.target).code),
  t16: (g, a) => g.t16.hits.length >= 1 && g.t16.hits.at(-1) === "red" && a.includes(g.t16.code),
  t17: (g, a) => t17ok(g.t17.todos) && a.includes(g.t17.code),
  t18: (g, a) => !!g.t18.order && t18ok(g.t18.order) && a.includes(g.t18.orderNo),
  t19: (g, a) => g.t19.approved.length === 1 && g.t19.approved[0] === g.t19.rows[g.t19.idx].id && a.includes(g.t19.code),
  t20: (g, a) => g.t20.saved?.dep === "2026-12-17" && g.t20.saved?.ret === "2027-01-03" && a.includes(g.t20.code),
  t21: (g, a) => g.t21.created?.trim() === "ada_1815" && a.includes(g.t21.code),
  t22: (g, a) => g.t22.got === "ZH-4471" && a.includes(g.t22.code),
  t23: (g, a) => g.t23.upload?.name === g.t23.want && g.t23.upload?.text === g.t23.content && a.includes(g.t23.code),
};

const T17_WANT = [{ text: "Write release notes", done: false }, { text: "Fix flaky test", done: true }, { text: "Update changelog", done: false }];
function t17ok(t) {
  return Array.isArray(t) && t.length === 3 && T17_WANT.every((w, i) => String(t[i]?.text).trim() === w.text && !!t[i]?.done === w.done);
}
function t18ok(o) {
  const items = o.items.filter((i) => i.qty > 0).map((i) => `${i.name}|${i.size}|${i.color}|${i.qty}`).sort();
  const tr = items.filter((x) => x.startsWith("Trail Runner|"));
  const rs = items.filter((x) => x.startsWith("Rain Shell|"));
  return items.length === 2 && tr[0] === "Trail Runner|M|Blue|2" && rs.length === 1 && /^Rain Shell\|L\|\w+\|1$/.test(rs[0])
    && o.coupon === "SAVE10" && o.ship === "Express" && o.name.trim() === "Ada Lovelace" && o.street.trim() === "Bahnhofstrasse 1"
    && o.zip === "8001" && o.city.trim() === "Zurich" && o.country === "Switzerland";
}

// ---------------- prompts ----------------
export const PROMPTS = {
  t1: (u) => `Open ${u} . Click the button labeled "Claim code" and report the 6-character code that appears. Respond with ONLY the code.`,
  t2: (u) => `Open ${u} . Fill the form: Full name = "Ada Lovelace", Email = "ada@example.com", Plan = "Beta", check "I agree", then click Submit. Respond with ONLY the confirmation ID that appears.`,
  t3: (u) => `Open ${u} . It is a catalog of 150 products. Find the product whose name starts with "Widget TARGET-" and report its price and stock as PRICE|STOCK (e.g. 123.45|67). Respond with ONLY that.`,
  t4: (u) => `Open ${u} . It is a 4-step wizard validated server-side: a wrong choice shows an error and does not advance — find the correct choice and proceed. Complete every step until a final token appears. Respond with ONLY the final token.`,
  t5: (u) => `Open ${u} . The page embeds a cross-origin iframe ("Secure panel"). Click "Reveal code" INSIDE the iframe and report the 6-character code. Respond with ONLY the code.`,
  t6: (u) => `Open ${u} . Set the notification preferences so that Email alerts is ON, SMS alerts is OFF, and Digest frequency is Weekly, then click "Save preferences". Respond with ONLY the reference code shown after saving.`,
  t7: (u, g) => `Open ${u} . It is an infinite-scroll feed (more posts load as you scroll). Find the post written by ${g.t7.feed[g.t7.idx].author} and click its "Like" button (do not like any other post). Respond with ONLY the code shown after liking.`,
  t8: (u) => `Open ${u} . Use the "Account" menu in the top navigation (it opens on hover) and choose "Export data". Respond with ONLY the export code that appears.`,
  t9: (u) => `Open ${u} . Delete the file "old-backup.zip" (and nothing else). The site asks for confirmation and then for a reason — the reason is: cleanup. Respond with ONLY the code shown after deletion.`,
  t10: (u) => `Open ${u} . Get the verification code from the help center link (it opens in a new tab), enter it on the original page and click Verify. Respond with ONLY the receipt code shown after successful verification.`,
  t11: (u) => `Open ${u} . Click "Generate report", wait until the report is ready, then click "Download report". Respond with ONLY the download code shown.`,
  t12: (u) => `Open ${u} . On the sprint board, drag the card "Fix login bug" into the "Done" column. Respond with ONLY the code shown after the move.`,
  t13: (u) => `Open ${u} . Type exactly this text into the release note editor: Release 4.2 fixes the export bug.  — then click Publish. Respond with ONLY the code shown after publishing.`,
  t14: (u) => `Open ${u} . Set the shipping destination: City = Zurich (pick it from the suggestions), Country = Switzerland (from the Country dropdown), then click "Save destination". Respond with ONLY the code shown after saving.`,
  t15: (u, g) => `Open ${u} . Find the order of customer "${g.t15.customer}" whose status is "Refunded" and click its "Details" button. Respond with ONLY the order code shown in the details.`,
  t16: (u) => `Open ${u} . Click the RED circle drawn on the canvas. Respond with ONLY the code shown after a correct hit.`,
  t17: (u) => `Our todo app's local development build is running at ${u} — test it end to end: add three todos in this order: "Write release notes", "Fix flaky test", "Update changelog"; mark "Fix flaky test" as done; then click "Sync to server". Respond with ONLY the code shown after syncing.`,
  t18: (u) => `Open the shop at ${u} and place this order: 2 × "Trail Runner" (exactly that product, not a variant) in size M, color Blue, and 1 × "Rain Shell" (not the Lite) in size L, any color. Apply the coupon code SAVE10 in the cart. Check out with Express shipping to: Ada Lovelace, Bahnhofstrasse 1, 8001 Zurich, Switzerland. Respond with ONLY the order number shown after placing the order.`,
  t19: (u, g) => `Open ${u} . In the invoice list, approve invoice ${g.t19.rows[g.t19.idx].id} (and no other invoice). Respond with ONLY the code shown after approving.`,
  t20: (u) => `Open ${u} . Using the date pickers, set Departure to 17 December 2026 and Return to 3 January 2027, then click "Save dates". Respond with ONLY the code shown after saving.`,
  t21: (u) => `Open ${u} and create an account: username "ada" — if that username is taken, use "ada_1815" instead; password "Analytical#Engine1843" (confirm it too); date of birth 1990-12-10; accept the terms. Fix any errors the form reports until the account is created. Respond with ONLY the account code shown on success.`,
  t22: (u) => `Open ${u} . Inside the embedded partner widget there is a "Branch lookup" form (it is nested one level deeper inside the widget). Enter the branch code ZH-4471 there and submit it. Respond with ONLY the confirmation code that appears.`,
  t23: (u, g, file) => `Open ${u} . Upload the local file ${file} as the avatar and click Upload. Respond with ONLY the code shown after a successful upload.`,
};
export const TASK_IDS = Object.keys(PROMPTS);

// ---------------- server ----------------
function makeServer(role, base) {
  return http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/favicon.ico") { res.statusCode = 204; return res.end(); }
    const run = u.searchParams.get("run") ?? "";
    if (u.pathname === "/healthz") return json(res, { ok: true, role });
    if (!run) return json(res, { error: "missing run" }, 400);
    const g = ground(run); g.__run = run;
    const p = u.pathname, POST = req.method === "POST";

    if (role === "child") {
      if (p === "/t5child") return html(res, page("Secure panel", `<h2>Secure panel</h2><button id="rev">Reveal code</button><div class="out" id="out"></div>`, `rev.onclick=async()=>{const d=await post('/api/t5/reveal');out.textContent='code: '+d.code;};`));
      if (p === "/api/t5/reveal" && POST) { if (!browserOnly(req, res)) return; g.t5.clicked = true; return json(res, { code: g.t5.code }); }
      if (p === "/t22outer") return html(res, page("Partner widget", `<h2>Partner widget</h2><p>Branch services:</p><iframe title="Branch lookup" src="/t22inner?run=${encodeURIComponent(run)}" style="width:480px;height:200px;border:1px dashed #999"></iframe>`));
      if (p === "/t22inner") return html(res, page("Branch lookup", `<h3>Branch lookup</h3><form id="f"><label for="bc">Branch code</label><input id="bc"><button>Look up</button></form><div class="out" id="out"></div>`, `f.onsubmit=async(e)=>{e.preventDefault();const d=await post('/api/t22/lookup',{code:bc.value});out.textContent=d.msg;};`));
      if (p === "/api/t22/lookup" && req.method === "POST") {
        if (!browserOnly(req, res)) return;
        const b = await readBody(req);
        g.t22.got = String(b.code ?? "").trim().toUpperCase();
        return json(res, { msg: g.t22.got === "ZH-4471" ? "Branch Zurich HB found. Confirmation: " + g.t22.code : "Unknown branch code." });
      }
      return json(res, { error: "not found" }, 404);
    }

    if (p === "/api/state") {
      if (u.searchParams.get("key") !== BENCH_KEY) return json(res, { error: "forbidden" }, 403);
      return json(res, g);
    }
    const tid = p.slice(1);
    if (P[tid] && !POST) return html(res, P[tid](g, base, u));

    if (!p.startsWith("/api/")) return json(res, { error: "not found" }, 404);
    // read-only APIs (GET, used by page scripts)
    if (p === "/api/t4/state") return json(res, { step: g.t4.step, done: g.t4.step >= 4, token: g.t4.step >= 4 ? g.t4.token : null, number: g.t4.step === 1 ? g.t4.number : null, word: g.t4.step === 2 ? g.t4.word : null, decoys: g.t4.step === 2 ? [g.t4.word + "S", g.t4.word.toLowerCase(), g.t4.word, g.t4.word.slice(0, 4)].sort() : [] });
    if (p === "/api/t7/page") { const from = Number(u.searchParams.get("from") ?? 0); await new Promise((r) => setTimeout(r, 250)); return json(res, { items: g.t7.feed.slice(from, from + 20).map(({ id, author, text }) => ({ id, author, text })), more: from + 20 < g.t7.feed.length }); }
    if (p === "/api/t11/status") { const el = g.t11.started ? Date.now() - g.t11.started : 0; return json(res, { ready: !!g.t11.started && el >= 5000, pct: Math.min(99, Math.floor(el / 50)) }); }
    if (p === "/api/t15/list") {
      const q = (u.searchParams.get("q") ?? "").toLowerCase().trim(); const pg = Number(u.searchParams.get("page") ?? 0);
      const rows = g.t15.orders.filter((o) => !q || o.customer.toLowerCase().includes(q));
      return json(res, { rows: rows.slice(pg * 20, pg * 20 + 20).map(({ id, customer, status, total }) => ({ id, customer, status, total })), pages: Math.max(1, Math.ceil(rows.length / 20)) });
    }
    if (p === "/api/t18/cart") {
      const items = g.t18.cart.filter((i) => i.qty > 0);
      const sub = items.reduce((a, i) => a + i.price * i.qty, 0);
      return json(res, { items: g.t18.cart, coupon: g.t18.coupon, total: g.t18.coupon ? Math.round(sub * 0.9) : sub });
    }
    if (p === "/api/t19/rows") return json(res, { rows: g.t19.rows });
    if (!POST) return json(res, { error: "method" }, 405);
    if (!browserOnly(req, res)) return;
    const b = await readBody(req);
    switch (p) {
      case "/api/t1/claim": g.t1.claimed = true; return json(res, { code: g.t1.code });
      case "/api/t2/submit": {
        g.t2.got = b;
        const ok = b.name === "Ada Lovelace" && b.email === "ada@example.com" && b.plan === "Beta" && b.agree === true;
        if (ok) { g.t2.valid = true; g.t2.confirmation = "CNF-" + hash(run + "t2").toString(36).toUpperCase().slice(0, 6); }
        return json(res, ok ? { ok: true, confirmation: g.t2.confirmation } : { ok: false, error: "fields do not match the required values" });
      }
      case "/api/t4/pick": { const ok = b.c === g.t4.color; if (ok && g.t4.step === 0) g.t4.step = 1; else if (!ok) g.t4.wrong++; return json(res, { ok }); }
      case "/api/t4/num": { const ok = String(b.n).trim() === g.t4.number; if (ok && g.t4.step === 1) g.t4.step = 2; else if (!ok) g.t4.wrong++; return json(res, { ok }); }
      case "/api/t4/word": { const ok = b.w === g.t4.word; if (ok && g.t4.step === 2) g.t4.step = 3; else if (!ok) g.t4.wrong++; return json(res, { ok }); }
      case "/api/t4/finish": if (g.t4.step === 3) g.t4.step = 4; return json(res, { ok: true });
      case "/api/t6/save": {
        g.t6.saved = { email: b.email, sms: b.sms, frequency: b.frequency };
        const ok = b.email === true && b.sms === false && b.frequency === "Weekly";
        return json(res, ok ? { ok: true, ref: g.t6.ref } : { ok: false });
      }
      case "/api/t7/like": { g.t7.likes.push(b.id); const ok = b.id === g.t7.feed[g.t7.idx].id && g.t7.likes.length === 1; return json(res, ok ? { code: g.t7.code } : {}); }
      case "/api/t8/export": g.t8.exported = true; return json(res, { msg: "Export started. Export code: " + g.t8.code });
      case "/api/t8/delete": g.t8.deleted = true; return json(res, { msg: "Account scheduled for deletion." });
      case "/api/t8/profile": return json(res, { msg: "Profile: (nothing to see here)" });
      case "/api/t9/delete": {
        g.t9.deletes.push({ file: b.file, reason: String(b.reason ?? "") });
        const ok = b.file === g.t9.target && String(b.reason ?? "").trim().toLowerCase() === "cleanup" && g.t9.deletes.length === 1;
        return json(res, { ok: true, msg: ok ? "Deleted. Code: " + g.t9.code : "Deleted " + b.file + "." });
      }
      case "/api/t10/help": g.t10.helpViewed = true; return json(res, { code: g.t10.code });
      case "/api/t10/verify": {
        g.t10.attempts++;
        const ok = String(b.code ?? "").trim().toUpperCase() === g.t10.code && g.t10.helpViewed;
        if (ok) g.t10.verified = true;
        return json(res, { msg: ok ? "Verified! Receipt: " + g.t10.receipt : "Invalid code." });
      }
      case "/api/t11/start": if (!g.t11.started) g.t11.started = Date.now(); return json(res, { ok: true });
      case "/api/t11/download": {
        const ready = g.t11.started && Date.now() - g.t11.started >= 5000;
        if (!ready) { g.t11.early++; return json(res, { msg: "Report not ready." }); }
        g.t11.downloaded = true; return json(res, { msg: "Downloaded. Code: " + g.t11.code });
      }
      case "/api/t12/move": {
        for (const c of Object.values(g.t12.cols)) { const i = c.indexOf(b.card); if (i >= 0) c.splice(i, 1); }
        (g.t12.cols[b.to] ??= []).push(b.card);
        const ok = g.t12.cols.Done.includes(g.t12.card);
        return json(res, { msg: ok ? "Moved. Code: " + g.t12.code : `Moved "${b.card}" to ${b.to}.` });
      }
      case "/api/t13/publish": {
        g.t13.got = String(b.text ?? "");
        const ok = g.t13.got.trim() === g.t13.want;
        return json(res, { msg: ok ? "Published. Code: " + g.t13.code : "Published (text does not match the requested note)." });
      }
      case "/api/t14/save": {
        g.t14.got = { city: b.city, country: b.country, typed: b.typed };
        const ok = b.city === "Zurich" && b.country === "Switzerland";
        return json(res, { msg: ok ? "Saved. Code: " + g.t14.code : !b.city ? "Please pick a city from the suggestions." : "Saved destination " + b.city + ", " + (b.country || "?") + "." });
      }
      case "/api/t15/details": {
        g.t15.viewed.push(b.id);
        const o = g.t15.orders.find((x) => x.id === b.id);
        return json(res, { msg: o ? `${o.id} — ${o.customer} — ${o.status} — order code: ${o.code}` : "unknown order" });
      }
      case "/api/t17/sync": {
        g.t17.todos = Array.isArray(b.todos) ? b.todos.map((t) => ({ text: String(t.text ?? ""), done: !!t.done })) : null;
        return json(res, { msg: t17ok(g.t17.todos) ? "Synced. Code: " + g.t17.code : `Synced ${g.t17.todos?.length ?? 0} todos.` });
      }
      case "/api/t18/add": {
        const prod = SHOP.find((x) => x.id === b.id);
        if (!prod || !["S", "M", "L"].includes(b.size) || !COLORS.includes(b.color) || !(b.qty >= 1)) return json(res, { msg: "Could not add to cart." });
        const ex = g.t18.cart.find((i) => i.name === prod.name && i.size === b.size && i.color === b.color);
        if (ex) ex.qty += Math.floor(b.qty); else g.t18.cart.push({ name: prod.name, price: prod.price, size: b.size, color: b.color, qty: Math.floor(b.qty) });
        return json(res, { msg: `Added ${Math.floor(b.qty)} × ${prod.name} (${b.size}, ${b.color}) to the cart.` });
      }
      case "/api/t18/qty": { const it = g.t18.cart[b.i]; if (it) it.qty = Math.max(0, Math.floor(b.qty)); return json(res, { ok: true }); }
      case "/api/t18/coupon": {
        const ok = String(b.code ?? "").trim().toUpperCase() === "SAVE10";
        if (ok) g.t18.coupon = "SAVE10";
        return json(res, { msg: ok ? "Coupon SAVE10 applied: 10% off." : "Invalid coupon." });
      }
      case "/api/t18/order": {
        if (!g.t18.cart.some((i) => i.qty > 0)) return json(res, { msg: "Your cart is empty." });
        g.t18.order = { items: g.t18.cart.map((i) => ({ ...i })), coupon: g.t18.coupon, ship: b.ship, name: String(b.name ?? ""), street: String(b.street ?? ""), zip: String(b.zip ?? ""), city: String(b.city ?? ""), country: String(b.country ?? "") };
        return json(res, { msg: "Thank you! Order number: " + g.t18.orderNo });
      }
      case "/api/t19/approve": {
        g.t19.approved.push(b.id);
        const ok = b.id === g.t19.rows[g.t19.idx].id && g.t19.approved.length === 1;
        return json(res, { msg: ok ? "Approved. Code: " + g.t19.code : `Approved ${b.id}.` });
      }
      case "/api/t20/save": {
        g.t20.saved = { dep: b.dep, ret: b.ret };
        const ok = b.dep === "2026-12-17" && b.ret === "2027-01-03";
        return json(res, { msg: ok ? "Saved. Code: " + g.t20.code : `Saved ${b.dep || "?"} → ${b.ret || "?"}.` });
      }
      case "/api/t21/signup": {
        g.t21.attempts.push(b.u);
        const errors = {};
        if (!b.u) errors.eu = "Username is required.";
        else if (["ada", "admin", "root"].includes(String(b.u).toLowerCase())) errors.eu = `"${b.u}" is already taken.`;
        const pw = String(b.pw ?? "");
        if (pw.length < 12 || !/\d/.test(pw) || !/[^A-Za-z0-9]/.test(pw)) errors.ep = "At least 12 characters, with a digit and a symbol.";
        if (pw !== b.pw2) errors.ep2 = "Passwords do not match.";
        const bd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(b.bd ?? ""));
        if (!bd) errors.eb = "Use the format YYYY-MM-DD.";
        else if (2026 - Number(bd[1]) < 18) errors.eb = "You must be at least 18.";
        if (!b.tos) errors.et = "You must accept the terms.";
        if (Object.keys(errors).length) return json(res, { ok: false, errors });
        g.t21.created = String(b.u);
        return json(res, { ok: true, code: g.t21.code });
      }
      case "/api/t23/upload": {
        g.t23.upload = { name: String(b.name ?? ""), size: b.size, text: String(b.text ?? "") };
        const ok = g.t23.upload.name === g.t23.want && g.t23.upload.text === g.t23.content;
        return json(res, { msg: ok ? "Avatar updated. Code: " + g.t23.code : `Uploaded ${g.t23.upload.name} — that is not the requested file.` });
      }
      case "/api/t16/hit": {
        const c = g.t16.circles.find((c) => (b.x - c.x) ** 2 + (b.y - c.y) ** 2 <= (c.rad + 2) ** 2);
        g.t16.hits.push(c ? c.color : "miss");
        return json(res, { msg: c?.color === "red" ? "Hit! Code: " + g.t16.code : c ? "That was " + c.color + "." : "Missed." });
      }
    }
    return json(res, { error: "not found" }, 404);
  });
}

/**
 * Start parent + child servers. `publicBase` lets a tunnel front them:
 * pass { parent: "https://a.trycloudflare.com", child: "https://b..." }.
 */
export async function startSuite({ parentPort = 0, childPort = 0, publicBase } = {}) {
  const base = { parent: "", child: "" };
  const child = makeServer("child", base); child.listen(childPort, "127.0.0.1"); await once(child, "listening");
  const parent = makeServer("parent", base); parent.listen(parentPort, "127.0.0.1"); await once(parent, "listening");
  base.parent = publicBase?.parent ?? `http://127.0.0.1:${parent.address().port}`;
  base.child = publicBase?.child ?? `http://localhost:${child.address().port}`;
  return {
    base, parentPort: parent.address().port, childPort: child.address().port,
    setPublic(pb) { Object.assign(base, pb); },
    truth: (run) => ground(run),
    close: () => { child.close(); parent.close(); },
  };
}

export { ground };
