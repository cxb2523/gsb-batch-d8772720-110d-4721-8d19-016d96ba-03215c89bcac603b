// End-to-end: crawl the multi-page fixture and audit/resume the crawl ledger.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CrawlLedger, LinkOutcome, Manifest } from '../../src/domain/report.js';
import { clone, type CloneOptions } from '../../src/pipeline/clone.js';
import { runDoctor } from '../../src/pipeline/doctor.js';
import { setLogSink } from '../../src/util/log.js';
import { serveStatic } from '../../src/verify/staticServer.js';

const fixture = fileURLToPath(new URL('../fixtures/crawl', import.meta.url));
const chromiumOk = (await runDoctor()).find((c) => c.name === 'Chromium launches')?.ok ?? false;

const OUTCOMES: LinkOutcome[] = [
  'enqueued',
  'duplicate',
  'cross-origin',
  'outside-scope',
  'skipped-extension',
  'robots-disallowed',
  'not-a-page',
];

/** Every URL recorded with `outcome`, as reported by the clone. */
const urlsWith = (ledger: CrawlLedger, outcome: LinkOutcome) =>
  [...new Set(ledger.links.filter((l) => l.outcome === outcome).map((l) => l.url))].toSorted();

const pageByPath = (ledger: CrawlLedger, path: string) => ledger.pages.find((p) => new URL(p.url).pathname === path);

/**
 * The fixture behind a server that hangs up on `/docs/broken`, so a capture
 * failure can be exercised. The port is fixed for the whole file: a resumed
 * clone only matches captures taken from the same URLs.
 */
async function startServer(): Promise<{ url: string; server: Server }> {
  const inner = await serveStatic([['/', fixture]]);
  const server = createServer((req, res) => {
    if (req.url === '/docs/broken') {
      req.socket.destroy();
      return;
    }
    const upstream = request(inner.url + req.url, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.on('close', () => inner.server.close());
  const addr = server.address();
  return { url: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`, server };
}

describe.skipIf(!chromiumOk)('crawl ledger', () => {
  let base = '';
  let server: Server | undefined;
  const outDir = mkdtempSync(join(tmpdir(), 'dittu-crawl-'));
  const options = (pages: number): CloneOptions => ({
    url: base + '/docs/',
    outDir,
    frameworks: [],
    pages,
    viewport: { width: 1280, height: 800 },
    mobile: null,
    breakpoint: 768,
    remove: [],
    waitMs: 100,
    split: true,
    format: false,
    styling: 'css',
  });
  const manifest = () => JSON.parse(readFileSync(join(outDir, 'dittu.json'), 'utf8')) as Manifest;

  beforeAll(async () => {
    setLogSink('silent');
    ({ url: base, server } = await startServer());
  });
  afterAll(() => server?.close());

  it('records an outcome for every link and a state for every page', async () => {
    const { manifest: result } = await clone(options(3));
    const ledger = result.crawl!;
    expect(ledger).toBeDefined();
    expect(new URL(ledger.startUrl).pathname).toBe('/docs');
    expect(ledger.scope).toBe('/docs/');
    expect(ledger.maxPages).toBe(3);

    // captured pages: final URL, route, success; the failing page does not count toward --pages
    expect(
      ledger.pages
        .filter((p) => p.status === 'ok')
        .map((p) => p.route)
        .toSorted(),
    ).toEqual(['/docs', '/docs/api', '/docs/guide']);
    for (const page of ledger.pages.filter((p) => p.status === 'ok')) {
      expect(page.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/docs/);
      expect(page.round).toBe('new');
    }
    // a failed page after a successful one is skipped and recorded with its reason
    expect(pageByPath(ledger, '/docs/broken')).toMatchObject({ status: 'failed', route: null, round: 'new' });
    expect(pageByPath(ledger, '/docs/broken')!.reason).toBeTruthy();

    // every inspected link carries one of the known outcomes
    expect(ledger.links.every((l) => OUTCOMES.includes(l.outcome))).toBe(true);
    expect(urlsWith(ledger, 'cross-origin')).toEqual(['https://example.com/docs/elsewhere']);
    expect(urlsWith(ledger, 'outside-scope')).toEqual([base + '/blog/post']);
    expect(urlsWith(ledger, 'robots-disallowed')).toEqual([base + '/docs/private/secret']);
    expect(urlsWith(ledger, 'skipped-extension')).toEqual([base + '/docs/archive.zip']);
    expect(urlsWith(ledger, 'not-a-page')).toContain('mailto:team@example.com');
    // /docs/guide is linked several times; it is queued once and reported as a duplicate after that
    expect(urlsWith(ledger, 'duplicate')).toContain(base + '/docs/guide');
    expect(
      ledger.links.filter((l) => l.url === base + '/docs/guide' && l.outcome === 'duplicate').length,
    ).toBeGreaterThan(1);
    // links carry the page they were found on
    expect(ledger.links.find((l) => l.outcome === 'cross-origin')!.foundOn).toBe(base + '/docs');

    // the manifest matches the ledger and stayed valid while capturing
    expect(result.state).toBe('complete');
    expect(result.pages.map((p) => p.route).toSorted()).toEqual(['/docs', '/docs/api', '/docs/guide']);
    expect(result.runs).toBe(1);
    expect(manifest().crawl?.summary).toEqual(ledger.summary);
  }, 120_000);

  it('still fails the whole clone when the start page cannot be captured', async () => {
    const out = mkdtempSync(join(tmpdir(), 'dittu-crawl-start-'));
    await expect(clone({ ...options(1), outDir: out, url: base + '/docs/broken' })).rejects.toThrow(
      /net::|ERR_|Failed|load/,
    );
  }, 120_000);

  it('leaves links beyond --pages uncaptured rather than losing them', async () => {
    const oneShot = mkdtempSync(join(tmpdir(), 'dittu-crawl-limit-'));
    const { manifest: result } = await clone({ ...options(1), outDir: oneShot });
    const ledger = result.crawl!;
    expect(ledger.summary.pages.ok).toBe(1);
    const pending = ledger.pages.filter((p) => p.status === 'pending');
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((p) => p.route === null)).toBe(true);
    // queued-but-uncaptured URLs are real pages the crawl found, not dropped links
    const linked = new Set(ledger.links.filter((l) => l.outcome === 'enqueued').map((l) => l.url));
    for (const p of pending) expect(linked.has(p.url)).toBe(true);
  }, 120_000);

  it('resumes after an interrupted run even when its manifest was lost', async () => {
    // Simulate a run killed between pages: captures exist, but no finished
    // manifest. The next run must still know what it already has.
    const dir = mkdtempSync(join(tmpdir(), 'dittu-crawl-interrupted-'));
    await clone({ ...options(2), outDir: dir });
    rmSync(join(dir, 'dittu.json'));
    rmSync(join(dir, 'preview'), { recursive: true, force: true });

    const { manifest: result } = await clone({ ...options(3), outDir: dir });
    const ledger = result.crawl!;
    expect(ledger.summary.pages.carried).toBe(2);
    expect(ledger.summary.pages.ok).toBe(3);
    expect(result.runs).toBe(1);
  }, 120_000);

  it('treats an HTTP error document as a failed page, not a clone of a 404', async () => {
    // The plain fixture (no proxy) serves its built-in 404 page for /docs/missing.
    const plain = await serveStatic([['/', fixture]]);
    const out = mkdtempSync(join(tmpdir(), 'dittu-crawl-404-'));
    try {
      const { manifest: result } = await clone({ ...options(4), url: plain.url + '/docs/', outDir: out });
      const ledger = result.crawl!;
      const notFound = ledger.pages.find((p) => p.url === plain.url + '/docs/missing');
      expect(notFound).toMatchObject({ status: 'failed', route: null });
      expect(notFound!.reason).toMatch(/HTTP 404/);
      // the rest of the crawl carried on: error pages never count as captures
      const ok = ledger.pages.filter((p) => p.status === 'ok');
      expect(ok.map((p) => p.route)).toEqual(expect.arrayContaining(['/docs', '/docs/guide', '/docs/api']));
      expect(ok.map((p) => p.route)).not.toContain('/docs/missing');
    } finally {
      plain.server.close();
    }
  }, 120_000);

  it('resumes: successful pages are reused, pending and failed ones are retried', async () => {
    // Continue the 3-page clone from the first test with room for two more pages.
    // The runaway link is discovered again from the reused pages, and /docs/install
    // — linked only from the API page — becomes reachable once that page is read.
    const { manifest: result, run } = await clone(options(5));
    const ledger = result.crawl!;
    expect(run).toBe(2);
    expect(result.runs).toBe(2);
    expect(result.createdAt).toBeTruthy();
    for (const route of ['/docs', '/docs/api', '/docs/guide']) {
      expect(pageByPath(ledger, route)).toMatchObject({ status: 'ok', round: 'carried' });
    }
    // the page that was pending in round 1 is now captured
    expect(pageByPath(ledger, '/docs/install')).toMatchObject({ status: 'ok', round: 'new' });
    // failures are retried, not silently dropped
    expect(pageByPath(ledger, '/docs/broken')).toMatchObject({ status: 'failed', round: 'new' });
    expect(ledger.summary.pages.carried).toBe(3);
    expect(ledger.summary.pages.new).toBeGreaterThanOrEqual(1);
    expect(ledger.summary.pages.pending).toBe(0);
  }, 120_000);
});
