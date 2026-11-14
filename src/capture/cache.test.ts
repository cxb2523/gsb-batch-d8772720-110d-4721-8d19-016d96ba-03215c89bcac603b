import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PageCache, type CaptureSettings } from './cache.js';
import type { CaptureResult, Snapshot } from '../domain/snapshot.js';

const settings: CaptureSettings = {
  startUrl: 'https://x.com/',
  viewport: { width: 1440, height: 900 },
  mobile: null,
  breakpoint: 768,
  remove: ['#cookie', '.chat'],
  waitMs: 1500,
};

const snapshot = (url: string): Snapshot => ({
  url,
  baseURI: url,
  title: 't',
  htmlAttrs: [],
  bodyAttrs: [],
  metas: [],
  icons: [],
  bodyHtml: '<p>hi</p>',
  sheets: [],
  canvases: [],
  motion: [],
  responsive: [],
  warnings: [],
  docHeight: 100,
});

const cap = (url: string): CaptureResult => ({
  snapshot: snapshot(url),
  links: ['https://x.com/about'],
  canvasShots: new Map([['1', Buffer.from('png')]]),
});

describe('page cache', () => {
  it('reuses captures only when the settings match', () => {
    const cache = new PageCache(join(mkdtempSync(join(tmpdir(), 'dittu-cache-')), 'capture'));
    cache.reset(settings);
    expect(cache.matches(settings)).toBe(true);
    // settings are compared independent of list order
    expect(cache.matches({ ...settings, remove: ['.chat', '#cookie'] })).toBe(true);
    expect(cache.matches({ ...settings, waitMs: 500 })).toBe(false);
    expect(cache.matches({ ...settings, startUrl: 'https://y.com/' })).toBe(false);
  });

  it('round-trips a capture, including the index and canvas bytes', () => {
    const cache = new PageCache(join(mkdtempSync(join(tmpdir(), 'dittu-cache-')), 'capture'));
    cache.reset(settings);
    cache.write({ requestedUrl: 'https://x.com/', url: 'https://x.com/', route: '/', cap: cap('https://x.com/') });
    expect(cache.entries()).toEqual([{ requestedUrl: 'https://x.com/', url: 'https://x.com/', route: '/' }]);
    expect(cache.has('/')).toBe(true);
    expect(cache.has('/about')).toBe(false);
    const loaded = cache.read('/')!;
    expect(loaded.links).toEqual(['https://x.com/about']);
    expect(loaded.snapshot.bodyHtml).toBe('<p>hi</p>');
    expect(loaded.canvasShots.get('1')!.toString()).toBe('png');
  });

  it('starts clean when reset, and keeps the asset map across runs', () => {
    const cache = new PageCache(join(mkdtempSync(join(tmpdir(), 'dittu-cache-')), 'capture'));
    cache.reset(settings);
    cache.write({ requestedUrl: 'https://x.com/', url: 'https://x.com/', route: '/', cap: cap('https://x.com/') });
    cache.writeAssets({ 'https://x.com/a.png': '/assets/img/a.png' });
    expect(cache.readAssets()).toEqual({ 'https://x.com/a.png': '/assets/img/a.png' });

    cache.reset(settings);
    expect(cache.entries()).toEqual([]);
    expect(cache.has('/')).toBe(false);

    const other = new PageCache(join(mkdtempSync(join(tmpdir(), 'dittu-cache-')), 'capture'));
    expect(other.readAssets()).toEqual({});
  });
});
