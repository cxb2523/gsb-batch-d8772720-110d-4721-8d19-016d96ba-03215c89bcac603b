/** Fixture HTTP server for gated plugin tests (first-party, in-repo,
 *  deterministic — gated tests never depend on third-party uptime except
 *  where a spec explicitly names a public demo).
 *
 *  Routes (each a tiny, honest stand-in for the real-world surface the
 *  plugin drives — same shapes, none of the flakiness):
 *    /vault-demo          sets a cookie + Web Storage; shows logged-in state
 *    /net-demo            heavy page: 25 ad/tracker subresources (each with
 *                         an artificial delay) + 5 first-party + /api/data.json
 *    /download/file.bin   deterministic attachment download (known sha256)
 *    /download/html.pdf   an HTML error page disguised as a download
 *    /print/report.html   tall authenticated-style page (multi-page PDF)
 *    /auth/*              fixture IdP: login → TOTP → consent → logged-in
 *    /webauthn-demo       WebAuthn registration + assertion playground
 *    /portal/*           fixture portal: login, paginated invoices, exports
 *    /store/*             fixture store: checkout, confirmation, drift modes
 *    /ats/*               fixture ATS: nested iframes, screening tree, review
 *    /commerce/*          fixture store admin: grid, listing form, disputes
 *    /maps/*              fixture maps tenant: virtualized feed, detail cards
 */

import http from "node:http";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const FIXTURE_BYTES = 512 * 1024; // /download/file.bin size
export function fixtureFileSha256() {
  return createHash("sha256").update(Buffer.alloc(FIXTURE_BYTES, 7)).digest("hex");
}

const PAGE = (title, body, head = "") => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>${head}</head>
<body>${body}</body></html>`;

/* ------------------------------------------------------------- vault demo */

const vaultDemo = PAGE("vault demo", `
  <h1>session-vault demo site</h1>
  <div id="state">checking…</div>
  <script>
    // The site's own session logic: logged-in state = cookie + storage item.
    const m = document.cookie.match(/(?:^|; )sv_session=([^;]+)/);
    const token = m && m[1];
    if (token) {
      localStorage.setItem("sv_last_seen", String(Date.now()));
      sessionStorage.setItem("sv_hits", String(Number(sessionStorage.getItem("sv_hits") || 0) + 1));
      document.getElementById("state").textContent = "logged in as " + token;
      window.__authEvents = 0;
    } else {
      document.getElementById("state").textContent = "logged out";
    }
  </script>`);

/* -------------------------------------------------------------- net demo */

// 25 delayed "ad/tracker" subresources + 5 first-party ones + one JSON API.
const netAdResources = Array.from({ length: 25 }, (_, i) =>
  `/ad-${i}.js?host=${i % 2 ? "doubleclick" : "googlesyndication"}.example`);
const netFirstParty = ["/site-0.js", "/site-1.js", "/site-2.js", "/site-3.js", "/site-4.js"];
const netDemo = PAGE("heavy demo", `
  <h1>heavy page</h1><div id="content">loaded</div>
  ${[...netAdResources, ...netFirstParty].map((s) => `<script src="${s}"></script>`).join("\n")}
  <script>fetch("/api/data.json").then(r => r.json()).then(j => { document.getElementById("content").textContent = j.note; });</script>`);

/* ------------------------------------------------------------- IdP (auth) */

// A throwaway identity: password "hunter2butthrowaway", TOTP seed in the test.
export const FIXTURE_IDP = {
  email: "agent@example.test",
  password: "hunter2butthrowaway",
  userCode: "u-4711",
};
const idpSessions = new Map(); // sid → { stage }

const idpLogin = PAGE("fixture IdP — sign in", `
  <h1>Sign in</h1>
  <form method="POST" action="/auth/login">
    <label>Email <input name="email" type="email" autocomplete="username" required></label><br>
    <label>Password <input name="password" type="password" autocomplete="current-password" required></label><br>
    <button type="submit" name="action" value="signin">Next</button>
  </form>`, `<meta name="viewport" content="width=device-width">`);

const idpOtp = (hint) => PAGE("fixture IdP — 2FA", `
  <h1>Two-factor verification</h1>
  <p id="otp-hint">${hint}</p>
  <form method="POST" action="/auth/otp">
    <label>Verification code <input name="code" inputmode="numeric" autocomplete="one-time-code" required></label>
    <button type="submit" name="action" value="verify">Verify</button>
  </form>`);

const idpConsent = PAGE("fixture IdP — consent", `
  <h1>Grant access</h1>
  <p>axuse test client wants to access: <code id="scopes">profile, documents.read</code></p>
  <form method="POST" action="/auth/consent">
    <button type="submit" name="action" value="allow">Allow</button>
    <button type="submit" name="action" value="deny">Deny</button>
  </form>`);

const idpDone = PAGE("fixture IdP — signed in", `
  <h1>Signed in</h1>
  <p id="who">agent@example.test</p>
  <img id="avatar" alt="avatar" src="/auth/avatar.svg" width="24" height="24">
  <a id="exit" href="/auth/logout">Sign out</a>`);

const webauthnDemo = PAGE("WebAuthn demo", `
  <h1>WebAuthn demo (fixture)</h1>
  <button id="register">Register passkey</button>
  <button id="login" disabled>Login with passkey</button>
  <div id="status">idle</div>
  <script type="module">
    window.__moduleRan = true;
    const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
    const un64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
    const setStatus = (t) => document.getElementById("status").textContent = t;
    document.getElementById("register").addEventListener("click", async () => {
      try {
        const cred = await navigator.credentials.create({
          publicKey: {
            challenge: crypto.getRandomValues(new Uint8Array(32)),
            rp: { name: "axuse fixture" }, user: { id: new TextEncoder().encode("u1"), name: "fixture-user", displayName: "Fixture User" },
            pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
            authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
          },
        });
        window.__credentialId = b64(cred.rawId);
        setStatus("registered: " + window.__credentialId.slice(0, 16) + "…");
        document.getElementById("login").disabled = false;
      } catch (e) { setStatus("register failed: " + e.message); }
    });
    document.getElementById("login").addEventListener("click", async () => {
      try {
        await navigator.credentials.get({
          publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), allowCredentials: [{ type: "public-key", id: un64(window.__credentialId) }], userVerification: "preferred" },
        });
        setStatus("assertion OK");
      } catch (e) { setStatus("assertion failed: " + e.message); }
    });
  </script>`);

/* ------------------------------------------------------------ fixtures */

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => resolve(data));
  });
}
const formParams = (body) => new URLSearchParams(body);

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

/** Start the fixture server. @returns {Promise<{url:string, port:number, close():Promise<void>, requestCount():number, seenUrls():string[]}>} */
export function startFixtureServer({ port = 0 } = {}) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const p = url.pathname;
    seen.push(`${req.method} ${p}`);

    try {
      /* -------------------------------------------------------- vault */
      if (p === "/vault-demo") {
        const token = (url.searchParams.get("as") || "sv-demo-token-1");
        return send(res, 200, vaultDemo, {
          "set-cookie": `sv_session=${token}; Path=/; Max-Age=3600; SameSite=Lax`,
        });
      }

      /* ---------------------------------------------------------- net */
      if (p === "/net-demo") return send(res, 200, netDemo);
      if (p === "/api/data.json") {
        const body = JSON.stringify({ note: "clean json from the platform's own endpoint", items: [1, 2, 3] });
        return send(res, 200, body, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      }
      if (p.startsWith("/ad-") || p.startsWith("/track/")) {
        await new Promise((ok) => setTimeout(ok, 120)); // heavy third-party stand-in
        return send(res, 200, "/* ad pixel */", { "content-type": "application/javascript" });
      }
      if (/^\/site-\d+\.js$/.test(p)) {
        return send(res, 200, "/* first-party */", { "content-type": "application/javascript" });
      }

      /* ---------------------------------------------------- downloads */
      if (p === "/download/file.bin") {
        const buf = Buffer.alloc(FIXTURE_BYTES, 7);
        return send(res, 200, buf, {
          "content-type": "application/octet-stream",
          "content-length": buf.length,
          "content-disposition": `attachment; filename="report-${FIXTURE_BYTES}.bin"`,
        });
      }
      if (p === "/download/html.pdf") {
        // The classic portal failure: an HTML error page disguised as a PDF download.
        const body = "<!doctype html><html><body><h1>Session expired</h1><p>Please sign in again.</p></body></html>";
        return send(res, 200, body, {
          "content-type": "text/html; charset=utf-8",
          "content-disposition": `attachment; filename="invoice-2026-09.pdf"`,
        });
      }
      if (p === "/download/slow.bin") {
        // A genuinely slow large download: 40 x 256 KB chunks at 350 ms =
        // ~10 MB over ~14 s — long enough that deadline-cancel fires
        // mid-stream and partial bytes must be cleaned up after the ack.
        const chunk = Buffer.alloc(256 * 1024, 7);
        const total = 40;
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": total * chunk.length, "content-disposition": 'attachment; filename="slow-10mb.bin"' });
        for (let i = 0; i < total; i++) {
          await new Promise((ok) => setTimeout(ok, 350));
          if (!res.write(chunk)) await new Promise((ok) => res.once("drain", ok));
        }
        return res.end();
      }

      /* -------------------------------------------------------- print */
      if (p === "/print/report.html") {
        const body = PAGE("Statement 2026-09", `
          <h1>Utility statement — September 2026</h1>
          ${Array.from({ length: 60 }, (_, i) => `<section style="break-inside:avoid"><h3>Line item ${i + 1}</h3><p>usage ${i + 1} kWh — $${(i + 1) * 1.25}</p></section>`).join("\n")}
          <p id="total">Total due: $2,295.00</p>`);
        return send(res, 200, body);
      }

      /* ------------------------------------------------------ auth IdP */
      if (req.method === "POST" && p === "/auth/login") {
        const raw = await readBody(req);
        const params = formParams(raw);
        const email = params.get("email");
        const password = params.get("password");
        if (process.env.AXUSE_fixture_DEBUG) (await import("node:fs")).appendFileSync("fixture-debug.log", `POST /auth/login email=${JSON.stringify(email)} match=${email === FIXTURE_IDP.email}/${password === FIXTURE_IDP.password}\n`);
        if (email === FIXTURE_IDP.email && password === FIXTURE_IDP.password) {
          return send(res, 200, idpOtp("Enter the 6-digit code from your authenticator app."));
        }
        return send(res, 200, PAGE("fixture IdP — sign in", `
          <h1>Sign in</h1><p id="error" role="alert">Wrong email or password. Try again.</p>
          <form method="POST" action="/auth/login">
            <label>Email <input name="email" type="email" required></label><br>
            <label>Password <input name="password" type="password" required></label><br>
            <button type="submit" name="action" value="signin">Next</button>
          </form>`));
      }
      if (p === "/auth/login") return send(res, 200, idpLogin);
      if (p === "/auth" || p === "/auth/") {
        return send(res, 302, "", { location: "/auth/login" });
      }
      if (req.method === "POST" && p === "/auth/otp") {
        const sid = `sid-${Math.random().toString(36).slice(2, 10)}`;
        idpSessions.set(sid, { stage: "consent" });
        return send(res, 200, idpConsent, { "set-cookie": `idp_flow=${sid}; Path=/; HttpOnly` });
      }
      if (req.method === "POST" && p === "/auth/consent") {
        const sid = (req.headers.cookie || "").match(/idp_flow=([^;]+)/)?.[1];
        const action = formParams(await readBody(req)).get("action");
        if (!sid || !idpSessions.has(sid)) return send(res, 200, PAGE("expired", "<h1>Flow expired</h1>"));
        if (action !== "allow") return send(res, 200, PAGE("denied", "<h1>Access denied</h1>"));
        idpSessions.set(sid, { stage: "done" });
        return send(res, 200, idpDone, { "set-cookie": `idp_flow=${sid}; Path=/; HttpOnly` });
      }
      if (p === "/auth/avatar.svg") {
        return send(res, 200, `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="12" fill="#4a7"/></svg>`, { "content-type": "image/svg+xml" });
      }
      if (p === "/auth/done") return send(res, 200, idpDone);
      if (p === "/webauthn-demo") return send(res, 200, webauthnDemo);

      /* ------------------------------------------------- portal (06) */
      if (req.method === "POST" && p === "/portal/login") {
        const f = formParams(await readBody(req));
        if (f.get("user") === "ops@acme.test" && f.get("password") === "portal-pass-1") {
          return send(res, 302, "", { location: "/portal/invoices", "set-cookie": "portal_session=ok; Path=/; HttpOnly" });
        }
        return send(res, 200, PAGE("Fixture portal", `<h1>Acme Supplier Portal</h1><p role="alert">Invalid credentials</p>
          <form method="POST" action="/portal/login"><label>User <input name="user"></label><label>Password <input name="password" type="password"></label><button>Sign in</button></form>`));
      }
      if (p === "/portal/login" || p === "/portal/") {
        return send(res, 200, PAGE("Fixture portal", `
          <h1>Acme Supplier Portal</h1>
          <form method="POST" action="/portal/login">
            <label>User <input name="user" required></label>
            <label>Password <input name="password" type="password" required></label>
            <button type="submit">Sign in</button>
          </form>`));
      }
      if (p === "/portal/invoices") {
        const cookie = req.headers.cookie || "";
        if (!cookie.includes("portal_session=ok")) return send(res, 302, "", { location: "/portal/" });
        const page = Math.max(1, Math.min(3, Number(url.searchParams.get("p") || 1)));
        const all = portalInvoices();
        const slice = all.slice((page - 1) * 4, page * 4);
        const body = PAGE(`Invoices — page ${page}`, `
          <h1>Invoices</h1><p id="pager">Page ${page} of 3</p>
          <table id="inv-table">
            <thead><tr><th>Document</th><th>Date</th><th>Total</th></tr></thead>
            <tbody>${slice.map((r) => `<tr><td>${r.document}</td><td>${r.date}</td><td class="total">${r.total}</td></tr>`).join("")}</tbody>
          </table>
          <nav>${page > 1 ? `<a id="prev" href="/portal/invoices?p=${page - 1}">Previous</a>` : ""} ${page < 3 ? `<a id="next" href="/portal/invoices?p=${page + 1}">Next</a>` : ""}</nav>
          <a id="export-csv" href="/portal/export.csv">Export CSV</a>
          <a id="export-pdf" href="/portal/export.pdf">Export PDF</a>`);
        return send(res, 200, body);
      }
      if (p === "/portal/export.csv") {
        if (!(req.headers.cookie || "").includes("portal_session=ok")) return send(res, 302, "", { location: "/portal/" });
        const body = "document,date,total\n" + portalInvoices().map((r) => `${r.document},${r.date},${r.total}`).join("\n") + "\n";
        return send(res, 200, body, { "content-type": "text/csv", "content-disposition": 'attachment; filename="invoices.csv"' });
      }
      if (p === "/portal/export.pdf") {
        if (!(req.headers.cookie || "").includes("portal_session=ok")) return send(res, 302, "", { location: "/portal/" });
        const body = `%PDF-1.4\n%fixture-portal-export\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\nxref\n0 4\ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n9\n%%EOF\n`;
        return send(res, 200, body, { "content-type": "application/pdf", "content-disposition": 'attachment; filename="invoices.pdf"' });
      }

      /* ------------------------------------------------- store (07) */
      if (p === "/store/checkout") {
        const wrong = url.searchParams.get("wrong") === "1";
        const total = wrong ? "1,840.00" : "1,240.00";
        return send(res, 200, PAGE("Checkout", `
          <h1>Checkout</h1>
          <p class="total" id="total">Total: $${total}</p>
          <form method="POST" action="${url.searchParams.get("delayed") === "1" ? "/store/pay-delayed" : "/store/pay"}">
            <button id="pay" type="submit">Pay $${total}</button>
          </form>`));
      }
      if (p === "/store/pay" && req.method === "POST") {
        const confirm = `#${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
        return send(res, 200, PAGE("Confirmation", `<h1>Payment received</h1><p id="confirmation">Confirmation ${confirm}</p>`));
      }
      if (p === "/store/pay-delayed" && req.method === "POST") {
        const confirm = `#${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
        await new Promise((ok) => setTimeout(ok, 3000)); // the "possibly_sent" settle case
        return send(res, 200, PAGE("Confirmation", `<h1>Payment received</h1><p id="confirmation">Confirmation ${confirm}</p>`));
      }
      if (p === "/store/rollback") {
        return send(res, 200, PAGE("Order", `<h1>Order in progress</h1><button id="cancel">Cancel order</button>`));
      }

      /* --------------------------------------------------- ats (10) */
      if (p === "/ats/apply") {
        // The stage frame is served from a *different origin* (frames_base
        // http://localhost:P vs the page's http://127.0.0.1:P) so the fixture
        // exercises the real OOPIF frame machinery — the entry ticket per
        // spec 10 (nested cross-origin iframes).
        const base = url.searchParams.get("frames_base") || "";
        return send(res, 200, PAGE("Workday-shaped application", `
          <h1>Job application — Senior Widget Engineer</h1>
          <iframe id="stage-frame" src="${base}/ats/frame/personal" title="Application stage"></iframe>`));
      }
      if (p.startsWith("/ats/frame/")) {
        const stage = p.slice("/ats/frame/".length).split("?")[0];
        const q = url.searchParams;
        if (stage === "personal") {
          return send(res, 200, PAGE("Personal", `
            <h2>Your information</h2>
            <form>
              <label>First name <input id="wd-input-first" name="0" data-identity="first_name" required></label>
              <label>Last name <input id="wd-input-last" name="1" data-identity="last_name" required></label>
              <label>Email <input id="wd-input-email" name="2" data-identity="email" required></label>
              <button id="next" type="button" onclick="location.href='/ats/frame/resume?x='+(window.__x=(window.__x||0)+1)">Next</button>
            </form>
            <script>
              // Stage state persists client-side (Workday-shaped behavior):
              // the review stage reads it back for the anti-typo gate.
              document.getElementById("wd-input-first").addEventListener("input", (e) => sessionStorage.setItem("ats_first", e.target.value));
              document.getElementById("wd-input-email").addEventListener("input", (e) => sessionStorage.setItem("ats_email", e.target.value));
            </script>`));
        }
        if (stage === "resume") {
          return send(res, 200, PAGE("Resume", `
            <h2>Resume</h2>
            <input id="wd-file-resume" type="file" name="resume" data-identity="resume">
            <button id="next" type="button" onclick="location.href='/ats/frame/screening?x='+(window.__x=(window.__x||0)+1)">Next</button>`));
        }
        if (stage === "screening") {
          const withSalary = q.get("salary") === "1";
          return send(res, 200, PAGE("Screening", `
            <h2>Screening questions</h2>
            <form>
              <fieldset><legend>How many years of widget experience?</legend>
                <select data-question="years_experience"><option value="">Select</option><option value="5">5</option><option value="8">8</option></select></fieldset>
              <fieldset><legend>Are you legally authorized to work in this country?</legend>
                <input type="radio" name="authorized" data-question="authorized" value="yes"> Yes
                <input type="radio" name="authorized" data-question="authorized" value="no"> No</fieldset>
              <fieldset><legend>Will you now or in the future require sponsorship?</legend>
                <input type="radio" name="sponsorship" data-question="sponsorship" value="yes"> Yes
                <input type="radio" name="sponsorship" data-question="sponsorship" value="no"> No</fieldset>
              ${withSalary ? `<fieldset><legend>What are your salary expectations?</legend><input data-question="salary_expectation"></fieldset>` : ""}
              <button id="next" type="button" onclick="location.href='/ats/frame/review?x='+(window.__x=(window.__x||0)+1)">Next</button>
            </form>`));
        }
        if (stage === "review") {
          return send(res, 200, PAGE("Review", `
            <h2>Review your application</h2>
            <dl id="review">
              <dt data-field="first_name">First name</dt><dd id="v-first"></dd>
              <dt data-field="email">Email</dt><dd id="v-email"></dd>
            </dl>
            <button id="submit" type="button" onclick="location.href='/ats/frame/done?x='+(window.__x=(window.__x||0)+1)">Submit application</button>
            <script>
              // Values survive via sessionStorage within the fixture flow.
              document.getElementById("v-first").textContent = sessionStorage.getItem("ats_first") || "";
              document.getElementById("v-email").textContent = sessionStorage.getItem("ats_email") || "";
            </script>`));
        }
        if (stage === "done") {
          return send(res, 200, PAGE("Applied", `<h1>Application submitted</h1><p id="confirmation">Confirmation R-${Math.floor(Math.random() * 900000 + 100000)}</p>`));
        }
      }

      /* ----------------------------------------------- commerce (12) */
      if (p === "/commerce/admin") {
        return send(res, 200, PAGE("Store admin", `
          <h1>Products</h1>
          <table id="catalog"><thead><tr><th>SKU</th><th>Name</th><th>Price</th><th>Qty</th></tr></thead>
          <tbody>${commerceRows().map((r) => `<tr data-sku="${r.sku}"><td>${r.sku}</td><td>${r.name}</td><td class="price">${r.price}</td><td class="qty">${r.qty}</td></tr>`).join("")}</tbody></table>
          <a id="new-listing" href="/commerce/listing">New listing</a>
          <a id="dispute" href="/commerce/dispute">Disputes</a>`));
      }
      if (p === "/commerce/listing") {
        return send(res, 200, PAGE("New listing", `
          <h1>New listing</h1>
          <form id="listing-form">
            <label>Title <input name="title"></label>
            <label>Price <input name="price"></label>
            <label>Description <textarea name="description"></textarea></label>
            <button id="publish" type="button">Publish</button>
            <p id="validation-error" role="alert" hidden></p>
          </form>
          <script>
            document.getElementById("publish").addEventListener("click", () => {
              const f = document.getElementById("listing-form");
              // Planted validation error: title < 3 chars → named-field error loop.
              if (f.title.value.trim().length < 3) {
                const e = document.getElementById("validation-error");
                e.hidden = false;
                e.textContent = "Title must be at least 3 characters (field: title)";
                return;
              }
              location.href = "/commerce/listed";
            });
          </script>`));
      }
      if (p === "/commerce/listed") {
        return send(res, 200, PAGE("Listed", `<h1>Listing published</h1><p id="case">case-778899</p>`));
      }
      if (p === "/commerce/dispute") {
        return send(res, 200, PAGE("Dispute", `
          <h1>Dispute case D-2026-113</h1>
          <form>
            <label>Evidence note <textarea name="note"></textarea></label>
            <button id="submit-dispute" type="button">Submit evidence</button>
          </form>
          <script>
            document.getElementById("submit-dispute").addEventListener("click", () => {
              if (document.querySelector("textarea[name=note]").value.trim().length < 5) return;
              location.href = "/commerce/dispute-done";
            });
          </script>`));
      }
      if (p === "/commerce/dispute-done") {
        return send(res, 200, PAGE("Dispute", `<h1>Evidence submitted</h1><p id="case">case-778899</p>`));
      }

      /* ------------------------------------- AG Grid infinite model (08) */
      if (p === "/grid/infinite") {
        // The OFFICIAL AG Grid infinite-row-model example (the vendor's
        // documented configuration + datasource pattern, the vendor's library
        // from the vendor's CDN), hosted first-party because the v36 docs
        // site lazy-mounts examples only on human interaction.
        return send(res, 200, PAGE("AG Grid infinite model", `
          <div id="grid" style="height:480px;width:860px"></div>
          <div id="mark">unloaded</div>
          <script src="https://cdn.jsdelivr.net/npm/ag-grid-community@36.2.0/dist/ag-grid-community.min.js"></script>
          <script>
            (window => {
              try {
                window.__mark = "ag=" + typeof window.agGrid;
                const AG = window.agGrid;
                AG.ModuleRegistry.registerModules([AG.AllCommunityModule]);
                const dataSource = {
                  rowCount: undefined,
                  getRows: (params) => {
                    if (!window.__paramsProbe) window.__paramsProbe = Object.keys(params).join(",");
                    const respond = params.onSuccess ?? params.success ?? params.successCallback;
                    setTimeout(() => {
                      const start = params.startRow;
                      const rows = [];
                      for (let i = start; i < start + 100; i++) {
                        if (i >= 1000) break;
                        rows.push({
                          athlete: "Athlete " + (i + 1),
                          age: 20 + (i % 15),
                          country: "Country " + (i % 60),
                          year: 2000 + (i % 20),
                          sport: "Sport " + (i % 10),
                          total: 1 + (i % 30),
                        });
                      }
                      const lastRow = rows.length < 100 ? start + rows.length : -1;
                      respond(rows, lastRow);
                    }, 40);
                  },
                };
                const api = AG.createGrid(document.getElementById("grid"), {
                  columnDefs: [
                    { field: "athlete" }, { field: "age" }, { field: "country" },
                    { field: "year" }, { field: "sport" }, { field: "total" },
                  ],
                  defaultColDef: { flex: 1, minWidth: 100, sortable: false },
                  rowBuffer: 0, rowModelType: "infinite", cacheBlockSize: 100,
                  maxConcurrentDatasourceRequests: 1, infiniteInitialRowCount: 1000,
                  maxBlocksInCache: 10,
                });
                api.updateGridOptions({ datasource: dataSource });
                document.getElementById("mark").textContent = "grid created";
              } catch (e) {
                document.getElementById("mark").textContent = "err: " + e.message;
              }
            })(window);
          </script>`));
      }

      /* ------------------------------------ streamed app canvas (13) */
      if (p === "/remote/app") {
        // A "streamed enterprise app" in a canvas: the record-replay driver's
        // stand-in for an HTML5 gateway. State is page-fact backed (the same
        // thing a VDI delivers visually); drift variant moves the button.
        const drift = url.searchParams.get("drift") === "1";
        const btnX = drift ? 520 : 120;
        return send(res, 200, PAGE("Legacy ERP (streamed)", `
          <h1 id="title">Legacy ERP — Customer Master</h1>
          <canvas id="screen" width="800" height="600" style="width:800px;height:600px;border:1px solid #888"></canvas>
          <!-- Real HTML5 gateways trap keyboard in a hidden contenteditable —
               trusted Input.insertText lands here (per-key keydown too). -->
          <div id="trap" contenteditable="true" style="position:absolute;left:-9999px;top:0"></div>
          <div id="state"></div>
          <script>
            window.__events = [];
            window.__screen = { form: "main", customer: "", order: "", qty: "", status: "idle" };
            const canvas = document.getElementById("screen");
            const trap = document.getElementById("trap");
            const ctx = canvas.getContext("2d");
            const fields = { customer: { x: 300, y: 150, label: "Customer" }, order: { x: 300, y: 200, label: "Order" }, qty: { x: 300, y: 250, label: "Qty" } };
            const button = { x: ${btnX}, y: 330, w: 160, h: 34, label: "Confirm" };
            let focus = null;
            const draw = () => {
              ctx.fillStyle = "#f4f4f4"; ctx.fillRect(0, 0, 800, 600);
              ctx.fillStyle = "#222"; ctx.font = "16px sans-serif";
              ctx.fillText("Legacy ERP — Customer Master", 30, 40);
              for (const [k, f] of Object.entries(fields)) {
                ctx.fillStyle = focus === k ? "#ffd" : "#fff";
                ctx.fillRect(f.x, f.y - 18, 300, 26);
                ctx.strokeStyle = "#888"; ctx.strokeRect(f.x, f.y - 18, 300, 26);
                ctx.fillStyle = "#222"; ctx.fillText(f.label + ":", 140, f.y);
                ctx.fillText(window.__screen[k] || "", f.x + 6, f.y);
              }
              ctx.fillStyle = "#4a7"; ctx.fillRect(button.x, button.y, button.w, button.h);
              ctx.fillStyle = "#fff"; ctx.fillText(button.label, button.x + 50, button.y + 22);
              ctx.fillStyle = "#666"; ctx.fillText("status: " + window.__screen.status, 30, 580);
            };
            draw();
            const css = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.x, y: e.clientY - r.y }; };
            canvas.addEventListener("pointerdown", (e) => {
              if (!e.isTrusted) return;
              const p = css(e);
              window.__events.push({ kind: "click", ...p });
              const over = fields[Object.keys(fields).find((k) => p.x >= fields[k].x - 20 && p.x <= fields[k].x + 320 && p.y >= fields[k].y - 24 && p.y <= fields[k].y + 12)];
              if (over) focus = Object.keys(fields).find((k) => fields[k] === over);
              if (p.x >= button.x && p.x <= button.x + button.w && p.y >= button.y && p.y <= button.y + button.h) {
                window.__screen.status = "confirmed #" + String(Math.floor(Math.random() * 900000) + 100000);
              }
              trap.focus();
              draw();
            });
            const commit = (text, via) => {
              if (!focus) return;
              window.__events.push({ kind: "type", text, via, focus });
              window.__screen[focus] = String(window.__screen[focus] || "") + text;
              draw();
            };
            trap.addEventListener("keydown", (e) => {
              if (!e.isTrusted || !focus) return;
              // Text chars arrive via beforeinput (below); keydown owns only
              // the non-printable keys (Backspace = erase).
              if (e.key === "Backspace") { window.__screen[focus] = String(window.__screen[focus] || "").slice(0, -1); draw(); }
            });
            trap.addEventListener("beforeinput", (e) => {
              if (e.inputType === "insertText" && e.data) { e.preventDefault(); commit(e.data, "beforeinput"); }
            });
            // CDP Input.insertText (the bulk-trusted channel gateways prefer)
            // fires the "input" event with inputType insertText WITHOUT a
            // beforeinput — commit it too (preventDefault on beforeinput
            // suppresses the input event, so this path only fires for the
            // bulk channel). NOTE: no backticks here — we are inside the
            // server's template literal.
            trap.addEventListener("input", (e) => {
              if (e.inputType === "insertText" && e.data) commit(e.data, "input-insertText");
            });
          </script>`));
      }

      /* ------------------------------------------ slider challenge (04) */      if (p === "/slider-challenge") {
        // A DataDome-shaped slider: drag the handle onto the target notch;
        // graded like the real ones (terminal position + trajectory shape
        // observed). A successful drop issues the clearance cookie.
        const notch = 220 + Math.floor(Math.random() * 440); // px offset inside the 700px track
        return send(res, 200, PAGE("Slider challenge", `
          <h1>Verify you are human</h1>
          <div class="slider-track" id="track" style="position:relative;width:700px;height:40px;background:#eee">
            <div class="slider-target" id="target" style="position:absolute;left:${notch}px;top:0;width:40px;height:40px;background:#dfe"></div>
            <div class="slider-handle btn slider-drag" id="handle" style="position:absolute;left:0;top:0;width:40px;height:40px;background:#4a7;cursor:grab"></div>
          </div>
          <div id="msg">Slide to verify</div>
          <script>
            window.__trajectory = [];
            const handle = document.getElementById("handle");
            const target = document.getElementById("target");
            let drag = null;
            const t0 = Date.now();
            handle.addEventListener("pointerdown", (e) => {
              if (!e.isTrusted) return "rejected";
              drag = { startX: e.clientX, handleLeft: handle.offsetLeft, events: 0, monodrome: [] };
              handle.setPointerCapture(e.pointerId);
            });
            handle.addEventListener("pointermove", (e) => {
              if (!drag) return;
              drag.events++;
              const left = Math.max(0, Math.min(660, drag.handleLeft + (e.clientX - drag.startX)));
              handle.style.left = left + "px";
              window.__trajectory.push({ t: Date.now() - t0, x: e.clientX, y: e.clientY });
            });
            handle.addEventListener("pointerup", (e) => {
              if (!drag) return;
              const gap = Math.abs(handle.offsetLeft - target.offsetLeft);
              const enoughEvents = drag.events >= 15;
              const traj = window.__trajectory.map(p => p.t);
              const spacingJitter = new Set(traj.slice(1).map((t, i) => Math.round((t - traj[i]) * 10))).size;
              const events = drag.events;
              drag = null;
              if (gap <= 8 && enoughEvents && spacingJitter >= 5) {
                document.cookie = "datadome=passed-" + Date.now() + "; path=/; max-age=3600";
                document.getElementById("msg").textContent = "Verification complete";
                document.getElementById("track").style.display = "none";
                window.__solved = true;
              } else {
                document.getElementById("msg").textContent = "Try again (gap " + gap + ", events " + events + ")";
              }
            });
          </script>`));
      }

      /* -------------------------------------------------- maps (14) */      if (p === "/maps/search") {
        const q = (url.searchParams.get("q") || "coffee").toLowerCase();
        const records = mapsRecords().filter((r) => r.name.toLowerCase().includes(q));
        return send(res, 200, PAGE(`Search: ${q}`, `
          <h1>Results for "${q}"</h1>
          <div id="feed" role="feed">${records.map((r) => `
            <div class="place-card" data-place-id="${r.id}">
              <a class="place-name" href="/maps/place?id=${r.id}">${r.name}</a>
              <span class="place-address">${r.address}</span>
            </div>`).join("")}</div>`));
      }
      if (p === "/maps/place") {
        const r = mapsRecords().find((x) => x.id === url.searchParams.get("id"));
        if (!r) return send(res, 404, PAGE("Not found", "<h1>No such place</h1>"));
        return send(res, 200, PAGE(r.name, `
          <h1 id="place-name">${r.name}</h1>
          <dl>
            <dt>Address</dt><dd id="address">${r.address}</dd>
            <dt>Phone</dt><dd id="phone">${r.phone}</dd>
            <dt>Website</dt><dd id="website">${r.website ?? ""}</dd>
            <dt>Hours</dt><dd id="hours">${r.hours ?? ""}</dd>
            <dt>Rating</dt><dd id="rating">${r.rating ?? ""} (${r.reviewCount ?? ""} reviews)</dd>
          </dl>`));
      }

      /* ------------------------------------------------ static files */
      if (!p.includes("..")) {
        try {
          const file = await readFile(join(HERE, p.slice(1)));
          const types = { ".html": "text/html", ".js": "application/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".bin": "application/octet-stream" };
          const ext = p.slice(p.lastIndexOf("."));
          res.writeHead(200, { "content-type": types[ext] ?? "application/octet-stream", "content-length": file.length });
          return res.end(file);
        } catch { /* fall through to 404 */ }
      }
      return send(res, 404, PAGE("Not found", `<h1>404</h1><p>No fixture at ${p}</p>`));
    } catch (e) {
      send(res, 500, PAGE("Server error", `<h1>fixture server error</h1><pre>${String(e.message ?? e)}</pre>`));
    }
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        port: server.address().port,
        requestCount: () => seen.length,
        seenUrls: () => [...seen],
        close: () => new Promise((ok) => server.close(ok)),
      });
    });
  });
}

/* ----------------------------------------------------------- fixture data */

export function portalInvoices() {
  return Array.from({ length: 12 }, (_, i) => {
    const n = i + 1;
    const lines = [100.0, 75.5, 24.5];
    const total = lines.reduce((s, x) => s + x, 0);
    return {
      document: `INV-2026-${String(n).padStart(3, "0")}`,
      date: `2026-0${Math.ceil(n / 4)}-${String((n % 28) + 1).padStart(2, "0")}`,
      total: `$${total.toFixed(2)}`,
      totalNumber: total,
      lines,
    };
  });
}

function commerceRows() {
  return Array.from({ length: 10 }, (_, i) => ({
    sku: `SKU-${1000 + i}`,
    name: `Widget model ${i + 1}`,
    price: `$${(19.99 + i * 5).toFixed(2)}`,
    qty: String(10 + i),
  }));
}

export function mapsRecords() {
  const base = Array.from({ length: 29 }, (_, i) => ({
    id: `place_${i + 1}`,
    name: `Coffee House No. ${i + 1}`,
    address: `${100 + i} Shoreditch High St, London`,
    phone: `+44 20 ${String(7000 + i).padStart(4, "0")}`,
    website: `https://coffee${i + 1}.example.test`,
    hours: "Mon-Fri 08:00-18:00",
    rating: (3.5 + (i % 15) / 10).toFixed(1),
    reviewCount: 20 + i * 7,
  }));
  // One planted duplicate: same stable identity, different display — dedupe
  // by placeId (not by content) must collapse it.
  const dupe = { ...base[3], name: base[3].name + " (duplicate card)" };
  return [...base, dupe];
}
