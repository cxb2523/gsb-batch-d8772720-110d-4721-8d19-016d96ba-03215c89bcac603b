/*
 * ======= • ======= • ======= • ======= • =======• =======
 * AniKotoAPI — tests/helpers/fakeUpstream.js
 *
 * @description
 *   A fully local, deterministic stand-in for the anikototv.to upstream.
 *   No real external site is ever contacted: every "mirror" domain is
 *   rewritten to http://127.0.0.1:<port> via the MIRROR_DOMAINS env var, and
 *   this server decides per-request whether to answer 200, 400 or 404.
 *
 *   Behaviour is controlled through the query string so a single server can
 *   drive every test scenario:
 *     - keyword=boom400  -> HTTP 400 (terminal client fault)
 *     - page=3 (and beyond) on any request -> HTTP 404 (page-level rejection)
 *     - everything else  -> 200 with a parseable list/pagination HTML page
 *
 * @exports
 *   startFakeUpstream, makeHtmlPage
 *
 * @license MIT
 * ======= • ======= • ======= • ======= • =======• =======
 */

import http from "node:http";

// ---- FEATURE: Minimal HTML fixture matching the real upstream selectors ----
/**
 * Builds the HTML shape consumed by search.extractor / filter.extractor:
 * `#list-items > .item` result cards plus `.pagination li a` page links.
 *
 * @param {object} [opts]
 * @param {number} [opts.totalPages=4] - Highest numeric pagination link
 * @param {number} [opts.items=2] - Number of list items to render
 * @returns {string} HTML document
 */
const makeHtmlPage = ({ totalPages = 4, items = 2 } = {}) => {
  const cards = Array.from({ length: items }, (_, i) => `
    <div class="item">
      <a href="/watch/test-anime-${i}-abc${i}">watch</a>
      <div class="ani poster tip" data-tip="${1000 + i}">
        <a href="/watch/test-anime-${i}-abc${i}"><img src="https://cdn.example.test/poster-${i}.jpg" /></a>
      </div>
      <div class="info">
        <div class="b1">
          <a class="name d-title" data-jp="テスト ${i}">Test Anime ${i}</a>
          <div class="genre"><a>Action</a><a>Comedy</a></div>
        </div>
        <div class="meta">
          <div class="m-item"><label></label></div>
          <div class="m-item"><label>TV</label></div>
          <div class="m-item rated"><span>8.${i}</span></div>
        </div>
      </div>
      <div class="ep-status sub"><span>${i + 1}</span></div>
      <div class="ep-status dub"><span>${i}</span></div>
      <div class="ep-status total"><span>12</span></div>
    </div>`).join("");

  const pageLinks = Array.from(
    { length: totalPages },
    (_, i) => `<li><a href="/filter?page=${i + 1}">${i + 1}</a></li>`
  ).join("");

  return `<!DOCTYPE html>
<html>
  <body>
    <div id="list-items">${cards}</div>
    <ul class="pagination">${pageLinks}</ul>
  </body>
</html>`;
};

// ---- FEATURE: Fake upstream with scripted 200/400/404 answers ----
/**
 * Starts the local fake upstream.
 *
 * @param {object} [opts]
 * @param {Function} [opts.onRequest] - Hook called with (req, { status }) so
 *   tests can assert exactly which mirror paths were contacted
 * @returns {Promise<{server: http.Server, port: number, close: Function}>}
 */
const startFakeUpstream = ({ onRequest } = {}) => {
  const requestLog = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const keyword = url.searchParams.get("keyword") || "";
    const page = parseInt(url.searchParams.get("page") || "1", 10);
    const host = req.headers.host;

    let status = 200;
    if (keyword === "boom400") status = 400;
    else if (page >= 3) status = 404;

    requestLog.push({
      host,
      path: url.pathname,
      query: url.search,
      status,
      page,
      keyword,
    });
    onRequest?.({ host, path: url.pathname + url.search, status, page });

    if (status === 400) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      return res.end("Bad Request");
    }
    if (status === 404) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not Found");
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(makeHtmlPage());
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        requestLog,
        close: () => new Promise((resolveClose) => server.close(resolveClose)),
      });
    });
  });
};

export { startFakeUpstream, makeHtmlPage };
