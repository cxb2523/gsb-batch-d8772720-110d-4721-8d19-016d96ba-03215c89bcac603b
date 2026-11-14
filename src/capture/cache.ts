import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CaptureResult, Snapshot, Viewport } from '../domain/snapshot.js';
import { routeScope } from '../domain/site.js';
import { hash } from '../util/hash.js';

/**
 * What a snapshot depends on. A cached capture is only reused when the next
 * run uses the same start URL and capture settings.
 */
export interface CaptureSettings {
  startUrl: string;
  viewport: Viewport;
  mobile: Viewport | null;
  breakpoint: number;
  remove: string[];
  waitMs: number;
}

/** A page captured by an earlier run (the index that makes a cache self-sufficient). */
export interface CacheEntry {
  /** Normalized URL that was queued. */
  requestedUrl: string;
  /** Final URL after redirects. */
  url: string;
  route: string;
}

export interface CachedPageInput extends CacheEntry {
  cap: CaptureResult;
}

interface StoredPage extends CacheEntry {
  snapshot: Snapshot;
  links: string[];
  /** Canvas clips as base64, keyed by the snapshot's canvas id. */
  canvases: Record<string, string>;
}

const SETTINGS = 'settings.json';
const INDEX = 'index.json';
const ASSETS = 'assets.json';

const sorted = (s: CaptureSettings): string =>
  JSON.stringify({
    ...s,
    remove: s.remove.toSorted(),
    viewport: [s.viewport.width, s.viewport.height],
    mobile: s.mobile ? [s.mobile.width, s.mobile.height] : null,
  });

/**
 * Snapshots of captured pages, kept in `<out>/capture` so re-running a clone
 * into the same folder does not fetch pages it already has. One file per page
 * (written as soon as a page is captured), so an interrupted run loses nothing.
 */
export class PageCache {
  private index: CacheEntry[] | null = null;

  constructor(readonly dir: string) {}

  private file(route: string) {
    return join(this.dir, `${routeScope(route)}-${hash(route)}.json`);
  }

  /** True when the cache was written by a run with these capture settings. */
  matches(settings: CaptureSettings): boolean {
    try {
      return sorted(JSON.parse(readFileSync(join(this.dir, SETTINGS), 'utf8')) as CaptureSettings) === sorted(settings);
    } catch {
      return false;
    }
  }

  /** Start a fresh cache: snapshots from an earlier run are irrelevant under new settings. */
  reset(settings: CaptureSettings) {
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, SETTINGS), JSON.stringify(settings, null, 2));
    this.index = [];
    this.writeIndex();
  }

  open() {
    mkdirSync(this.dir, { recursive: true });
  }

  /** Pages an earlier run captured, in capture order. */
  entries(): CacheEntry[] {
    if (this.index) return this.index;
    try {
      this.index = JSON.parse(readFileSync(join(this.dir, INDEX), 'utf8')) as CacheEntry[];
    } catch {
      this.index = [];
    }
    return this.index;
  }

  has(route: string): boolean {
    return existsSync(this.file(route));
  }

  read(route: string): CaptureResult | null {
    try {
      const stored = JSON.parse(readFileSync(this.file(route), 'utf8')) as StoredPage;
      const canvasShots = new Map<string, Buffer>();
      for (const [cid, b64] of Object.entries(stored.canvases ?? {})) canvasShots.set(cid, Buffer.from(b64, 'base64'));
      return { snapshot: stored.snapshot, links: stored.links, canvasShots };
    } catch {
      return null;
    }
  }

  write(entry: CachedPageInput) {
    this.open();
    const canvases: Record<string, string> = {};
    for (const [cid, buf] of entry.cap.canvasShots) canvases[cid] = buf.toString('base64');
    const stored: StoredPage = {
      requestedUrl: entry.requestedUrl,
      url: entry.url,
      route: entry.route,
      snapshot: entry.cap.snapshot,
      links: entry.cap.links,
      canvases,
    };
    writeFileSync(this.file(entry.route), JSON.stringify(stored));
    const index = this.entries().filter((e) => e.route !== entry.route);
    index.push({ requestedUrl: entry.requestedUrl, url: entry.url, route: entry.route });
    this.index = index;
    this.writeIndex();
  }

  private writeIndex() {
    this.open();
    writeFileSync(join(this.dir, INDEX), JSON.stringify(this.index ?? [], null, 2));
  }

  /** Remote asset URL → public path from an earlier run (files are kept on resume). */
  readAssets(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(join(this.dir, ASSETS), 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }

  writeAssets(map: Record<string, string>) {
    this.open();
    writeFileSync(join(this.dir, ASSETS), JSON.stringify(map, null, 2));
  }
}
