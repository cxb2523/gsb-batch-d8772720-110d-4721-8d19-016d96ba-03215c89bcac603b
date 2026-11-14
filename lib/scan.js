'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const memory = require('./memory');
const disk = require('./disk');
const docker = require('./docker');
const repos = require('./repos');
const checks = require('./checks');
const decisions = require('./decisions');
const platform = require('./platform');
const self = require('./self');

const CACHE_DIR = path.join(os.homedir(), '.cache', 'reckon');
const CACHE = path.join(CACHE_DIR, 'scan.json');
// Exactly one scan back. The panel's closing question is "did doing that
// actually free anything", and it cannot be answered from a single reading.
// One is enough: two readings make a difference, and keeping a history of them
// would be this tool starting to collect on its own.
const PREVIOUS = path.join(CACHE_DIR, 'scan-previous.json');

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return null; }
}
function readPrevious() {
  try { return JSON.parse(fs.readFileSync(PREVIOUS, 'utf8')); } catch { return null; }
}
function writeCache(data) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    // The scan that was current becomes the previous one. Copy, not rename:
    // a rename that half-fails would leave the panel with no current scan at
    // all, and losing today's reading to keep yesterday's is the wrong trade.
    try { const old = fs.readFileSync(CACHE); fs.writeFileSync(PREVIOUS, old); } catch {}
    fs.writeFileSync(CACHE, JSON.stringify(data));
  } catch {}
}

// ---------------------------------------------------------------------------
// WHAT CHANGED BETWEEN TWO SCANS.
//
// The honest unit is free space on the volume, because that is the thing a
// person actually cares about and the only one measured the same way both
// times. It is NOT attributed to this panel: free space moves for reasons that
// have nothing to do with acting on a list — a download finished, a snapshot
// expired, an app updated itself. The screen states the two readings and lets
// the reader draw the line, which is the same rule every other number here
// follows.
//
// `gone` is the stronger evidence: an item that was on the list and is not any
// more is something that was acted on, with its own measured size from the
// scan that saw it.
// ---------------------------------------------------------------------------
function changed(current, previous) {
  if (!current || !previous || !previous.volume || !current.volume) return null;
  const before = (previous.panel && previous.panel.out) || [];
  const now = (current.panel && current.panel.out) || [];
  const nowIds = new Set(now.filter((d) => d.kb > 0).map((d) => d.id));
  const gone = before.filter((d) => d.kb > 0 && !nowIds.has(d.id));
  const beforeIds = new Set(before.filter((d) => d.kb > 0).map((d) => d.id));
  const appeared = now.filter((d) => d.kb > 0 && !beforeIds.has(d.id));

  return {
    at: previous.at,
    days: Math.max(0, Math.round((current.at - previous.at) / 86400000)),
    hours: Math.max(0, Math.round((current.at - previous.at) / 3600000)),
    freeBeforeKB: previous.volume.freeKB,
    freeNowKB: current.volume.freeKB,
    freedKB: current.volume.freeKB - previous.volume.freeKB,
    gone: gone.map((d) => ({ id: d.id, title: d.title, kb: d.kb })).sort((a, b) => b.kb - a.kb),
    goneKB: gone.reduce((n, d) => n + d.kb, 0),
    appeared: appeared.map((d) => ({ id: d.id, title: d.title, kb: d.kb })).sort((a, b) => b.kb - a.kb),
  };
}

// Light scan: only what is cheap. Runs whenever you open a tab.
async function light() {
  const t0 = Date.now();
  const [mem, vol] = await Promise.all([memory.collect(), disk.volume()]);
  self.markScan(Date.now() - t0);
  return { type: 'light', platform: platform.id, shell: platform.COMMAND_SHELL || null, memory: mem, volume: vol, ms: Date.now() - t0, at: Date.now() };
}

// ---------------------------------------------------------------------------
// Every collector's result gets an entry the screen can judge: success,
// failure (with the reason), or skipped. The shape is one flat list:
//
//   { scope: 'target' | 'docker' | 'repos',
//     id, label, path,                    // what the entry is about
//     status: 'failed' | 'skipped',       // successes are implicit and listed nowhere
//     reason }                            // the cause, in words
//
// Only failures and skips land here: when everything succeeds the list is
// EMPTY, which is itself the all-clear signal. A failed collector's data never
// enters decisions.build, so nothing failed is ever summed as a zero — the
// number on screen is the total of what was actually read, and this list says
// what was not.
// ---------------------------------------------------------------------------

// Deep scan: sizing every folder, git in every repository, and reading inside
// the Docker VM. Only when asked.
async function deep(log = () => {}) {
  const t0 = Date.now();
  const outcomes = [];
  log('measuring volume and memory');
  const [mem, vol] = await Promise.all([memory.collect(), disk.volume()]);

  log('measuring large folders');
  let measured;
  try {
    measured = await disk.targets();
  } catch (e) {
    // The whole target table failing used to abort the scan. It now records
    // the failure and continues with an empty table: Docker and the repos can
    // still be read, and the screen gets a reason instead of a blank panel.
    measured = { list: [], unmeasured: [], outcomes: [{
      scope: 'target', id: 'targets', label: 'the known cache folders', path: null,
      status: 'failed', reason: `The folder measurement could not run: ${(e && e.message) || e}. No folder size on this scan was read.` }] };
  }
  const targets = measured.list;
  outcomes.push(...(measured.outcomes || []));

  // GUARD: only once we know WHICH paths will reach the screen do we check them
  // for links and shared blocks. Running that across the whole disk would be
  // expensive and pointless.
  //
  // The link index is built once for every root and every target is tested
  // against it. `truncated` travels with each row as `linksProven`, because
  // while it is true "no link points here" is not something this answer proves,
  // and the card has to say so rather than recommend the delete anyway.
  log('checking links and shared blocks on the targets');
  let links = { links: [], roots: [], truncated: true };
  try {
    links = await disk.symlinkIndex();
  } catch (e) {
    // An unproven link search already drops every affected card to 'medium';
    // record why so the screen can name it instead of just showing the caution.
    outcomes.push({ scope: 'target', id: 'symlink-index', label: 'the search for links pointing at the folders',
      path: null, status: 'failed', reason: `The symlink search could not run: ${(e && e.message) || e}. No folder below is proven link-free.` });
  }
  for (const t of targets) {
    if (t.verdict !== 'disposable') continue;
    try {
      t.symlinks = disk.linksTo(links, t.path);
      // Proof requires having looked. An empty `roots` means every candidate
      // directory was missing — the normal case on a machine that keeps its code
      // outside the user profile — and "I searched nowhere" must never render as
      // "nothing points here", which is the strongest claim this tool makes.
      t.linksProven = links.roots.length > 0 && !links.truncated;
      if (t.kb > 1048576) t.hardlinks = await disk.hardlinks(t.path);
    } catch (e) {
      // A hard-link check failing on one folder cannot be allowed to void the
      // measurements of every other folder. Mark this one unproven instead.
      t.linksProven = false;
      outcomes.push({ scope: 'target', id: t.id, label: t.label, path: t.path, status: 'failed',
        reason: `The link / hard-link check for ${t.label} failed: ${(e && e.message) || e}. Its size was still measured, but nothing here proves deleting it is safe.` });
    }
  }

  log('reading docker from inside its VM');
  // Docker not answering is an ordinary, expected state (stopped, or still
  // starting) — it is a skip with the daemon's own reason, not a failure, and
  // nothing about it is summed anywhere.
  let dk = { running: false, why: 'Docker was not read.' };
  try {
    dk = await docker.collect({ deep: true });
    if (!dk.running) {
      outcomes.push({ scope: 'docker', id: 'docker', label: 'Docker', path: null, status: 'skipped',
        reason: dk.why || 'Docker is not responding.' });
    }
  } catch (e) {
    dk = { running: false, why: `Docker collection failed: ${(e && e.message) || e}` };
    outcomes.push({ scope: 'docker', id: 'docker', label: 'Docker', path: null, status: 'failed',
      reason: dk.why + ' Docker contributes nothing to the totals on this scan.' });
  }

  log('reading git in every repository');
  // A throw here used to kill the whole scan. The collector now isolates each
  // repository itself; this guard covers a failure of the collect() wrapper,
  // and still hands decisions.build a well-formed empty object.
  let rp = { repos: [], worktrees: [], vaults: [], outcomes: [] };
  try {
    rp = await repos.collect({ deep: true });
    outcomes.push(...(rp.outcomes || []));
  } catch (e) {
    outcomes.push({ scope: 'repos', id: 'repos', label: 'the repositories', path: null, status: 'failed',
      reason: `The repository scan could not run: ${(e && e.message) || e}. No repository was read.` });
  }

  log('running checks');
  let ck = { items: [] };
  try {
    ck = await checks.collect({ unmeasuredTargets: measured.unmeasured, repos: rp });
  } catch (e) {
    outcomes.push({ scope: 'repos', id: 'checks', label: 'the checks', path: null, status: 'failed',
      reason: `The checks could not run: ${(e && e.message) || e}.` });
  }

  log('building decisions');
  // Every collector above either returned its data or a well-formed empty
  // object, so build() only ever sums what was actually read. Nothing that
  // failed reaches this call: a failed disk target never entered `targets`,
  // and failed Docker/repo data was replaced by the empty fallback objects.
  const panel = decisions.build({ docker: dk, targets, repos: rp });

  log('mapping the top of your home folder');
  let top = [];
  try {
    top = await disk.homeTop();
  } catch (e) {
    outcomes.push({ scope: 'target', id: 'home-top', label: 'the top of your home folder', path: null,
      status: 'failed', reason: `The home-folder map could not be read: ${(e && e.message) || e}. It does not enter any total.` });
  }

  const ms = Date.now() - t0;
  self.markScan(ms);
  const data = { type: 'deep', platform: platform.id, shell: platform.COMMAND_SHELL || null, memory: mem, volume: vol, targets,
    unmeasured: measured.unmeasured, docker: dk, repos: rp,
    checks: ck, panel, homeTop: top,
    // New field: the judged ending of every collection target. Empty when
    // everything succeeded; failures and skips carry their reasons. All the
    // fields above keep their old shapes, so older readers ignore this one.
    outcomes,
    ms, at: Date.now() };
  writeCache(data);
  return data;
}

module.exports = { light, deep, readCache, readPrevious, changed, CACHE, PREVIOUS };
