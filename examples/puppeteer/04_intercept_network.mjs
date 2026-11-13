// 04_intercept_network.mjs — block ads/tracking and mock /api/me over CDP.
//
// Connects to a running Owl Light (or any Chrome with remote debugging)
// with puppeteer.connect and drives the first existing page. Enabling
// request interception pauses every request until one of three outcomes
// is applied:
//
//   Job 1 - blocker:
//       ABORT    URLs containing "ads" or "tracking" never leave the browser.
//
//   Job 2 - rewriter:
//       RESPOND  URLs whose path ends with "/api/me" get a fixed
//                HTTP 200 JSON body: {"id":42,"name":"Owlbert"}.
//
//   Fallback for everything else (all other /api/ calls included):
//       CONTINUE the request reaches the network untouched.
//
// A summary line with the abort/rewrite counters is always printed before
// exit, even when no request matched (both counters then stay at 0).
//
// Usage:
//     node 04_intercept_network.mjs [TARGET_URL]
import puppeteer from 'puppeteer';

const CDP_URL = 'http://localhost:9222';
const DEFAULT_TARGET = 'http://localhost:8080/intercept-demo.html';
const MOCK_ME_BODY = '{"id":42,"name":"Owlbert"}';

// --- Job 1: ad / tracking blocker ---------------------------------------
const isBlocked = (url) => url.includes('ads') || url.includes('tracking');

// --- Job 2: API response rewriter ---------------------------------------
const isMockedMe = (url) => url.split('?')[0].endsWith('/api/me');

const target = process.argv[2] ?? DEFAULT_TARGET;
const stats = { aborted: 0, fulfilled: 0, continued: 0 };

let browser;
try {
  try {
    browser = await puppeteer.connect({ browserURL: CDP_URL });
  } catch (err) {
    console.error(`error: cannot connect to CDP endpoint ${CDP_URL}: ${err.message}`);
    process.exit(1);
  }

  const pages = await browser.pages();
  const page = pages[0];
  if (!page) {
    console.error('error: no open page found in the existing browser context');
    await browser.disconnect();
    process.exit(1);
  }

  // Interception must be switched on before navigation, otherwise the
  // first requests go out unpaused and cannot be inspected.
  await page.setRequestInterception(true);

  page.on('request', (request) => {
    const url = request.url();
    try {
      if (isBlocked(url)) {
        // Job 1 — ad / tracking requests are stopped outright.
        request.abort();
        stats.aborted += 1;
        console.log(`  ABORT    ${url}`);
      } else if (isMockedMe(url)) {
        // Job 2 — /api/me is answered with fixed synthetic JSON.
        request.respond({
          status: 200,
          contentType: 'application/json',
          body: MOCK_ME_BODY,
        });
        stats.fulfilled += 1;
        console.log(`  FULFILL  ${url} -> ${MOCK_ME_BODY}`);
      } else {
        // Fallback — other /api/ calls and all normal traffic pass through.
        request.continue();
        stats.continued += 1;
        console.log(`  CONTINUE ${url}`);
      }
    } catch (err) {
      // The request may already be settled (redirect, frame detach, ...).
      // Try to resume it so the page never hangs waiting on us.
      console.error(`  WARNING  handler error for ${url}: ${err.message}`);
      try {
        request.continue();
      } catch {
        /* already handled — nothing more we can do */
      }
    }
  });

  try {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (err) {
    console.error(`error: failed to open ${target}: ${err.message}`);
    await browser.disconnect();
    process.exit(1);
  }

  // The fixture flips this flag once its four requests have settled.
  // Pages without the flag are fine: we simply skip the wait.
  try {
    await page.waitForFunction('window.__interceptDemoDone === true', {
      timeout: 5000,
    });
  } catch {
    /* page never signalled completion — counters are still reported */
  }

  const results = await page.evaluate(() => window.__interceptResults ?? null);
  if (results) {
    console.log('page-observed results:');
    for (const [name, detail] of Object.entries(results)) {
      console.log(`  ${name}: ${detail}`);
    }
  }

  // disconnect() leaves the browser running; it only ends this session.
  await browser.disconnect();
  console.log(
    `summary: aborted=${stats.aborted} fulfilled=${stats.fulfilled} continued=${stats.continued}`,
  );
} catch (err) {
  console.error(`error: ${err.message}`);
  if (browser) await browser.disconnect().catch(() => {});
  process.exit(1);
}
