/**
 * axuse — snapshot differ.
 *
 * Lineage: Codex's page-state diffing (`disable_diffing` flag → default is
 * diff-on; the model learns "what changed", not the whole page again) and
 * ZCode's diffed AX trees ("the tree comes back as a diff only against a
 * tree this cell already showed you… unchanged rows are omitted and their
 * indices stay valid").
 *
 * The diff is computed over per-ref entries, so unchanged refs keep their
 * identity across observations — an agent can plan "click e7" after a diff
 * without re-reading the whole tree.
 */

/**
 * @typedef {{ref: string, line: string}} Entry
 * @typedef {{stateId: number, entries: Entry[], textLines?: string[], url: string, title: string, truncated: boolean, text?: string}} Snapshot
 */

const TEXT_DIFF_CAP = 40; // per direction — beyond this a full snapshot is clearer than a partial diff

function multisetDiff(prevLines = [], nextLines = []) {
  const prev = new Map();
  for (const l of prevLines) prev.set(l, (prev.get(l) ?? 0) + 1);
  const next = new Map();
  for (const l of nextLines) next.set(l, (next.get(l) ?? 0) + 1);
  const added = [];
  let capped = false;
  for (const [l, c] of next) {
    const d = c - (prev.get(l) ?? 0);
    for (let i = 0; i < d; i++) {
      if (added.length >= TEXT_DIFF_CAP) { capped = true; break; }
      added.push(l);
    }
  }
  const removed = [];
  for (const [l, c] of prev) {
    const d = c - (next.get(l) ?? 0);
    for (let i = 0; i < d; i++) {
      if (removed.length >= TEXT_DIFF_CAP) { capped = true; break; }
      removed.push(l);
    }
  }
  return { added, removed, capped };
}

/**
 * @param {Snapshot} prev  previous stored snapshot
 * @param {Snapshot} next  the fresh one
 * @returns {{mode: "diff"|"full", text: string, removed: Entry[], added: Entry[], changed: {ref: string, was: string, now: string}[], nextEntries: Entry[]}}
 */
export function diffSnapshots(prev, next) {
  const empty = (s) => !s || ((!s.entries || !s.entries.length) && !(s.textLines || []).length);
  if (empty(prev) || empty(next)) {
    return { mode: "full", text: null, removed: [], added: [], changed: [], textAdded: [], textRemoved: [], nextEntries: next?.entries ?? [] };
  }
  const prevBy = new Map(prev.entries.map((e) => [e.ref, e]));
  const nextBy = new Map(next.entries.map((e) => [e.ref, e]));
  const removed = [];
  const added = [];
  const changed = [];
  for (const [ref, e] of prevBy) {
    const nx = nextBy.get(ref);
    if (!nx) removed.push(e);
    else if (nx.line !== e.line) changed.push({ ref, was: e.line, now: nx.line });
  }
  for (const [ref, e] of nextBy) {
    if (!prevBy.has(ref)) added.push(e);
  }
  const out = [];
  out.push(`url: ${prev.url === next.url ? next.url : prev.url + " → " + next.url}`);
  out.push(`title: ${prev.title === next.title ? next.title : '"' + prev.title + '" → "' + next.title + '"'}`);
  out.push(`entries: ${prev.entries.length} → ${next.entries.length} (removed ${removed.length}, added ${added.length}, changed ${changed.length})`);
  if (next.truncated) out.push("note: snapshot truncated by budget — pass max_nodes/max_chars or observe sections");
  if (removed.length) {
    out.push("removed:");
    for (const e of removed) out.push(`  - ${e.line}`);
  }
  if (added.length) {
    out.push("added:");
    for (const e of added) out.push(`  + ${e.line}`);
  }
  if (changed.length) {
    out.push("changed:");
    // Only the new state: the old line rarely matters and doubles the cost.
    for (const c of changed) out.push(`  ~ ${c.now.trimStart()}`);
  }
  // Text lines (anonymous, no ref) diff by multiset — text changes are
  // observable even when no ref'd element changed.
  const textDiff = multisetDiff(prev.textLines, next.textLines);
  if (textDiff.removed.length) {
    out.push("text removed:");
    for (const l of textDiff.removed) out.push(`  - ${l}`);
      }
  if (textDiff.added.length) {
    out.push("text added:");
    for (const l of textDiff.added) out.push(`  + ${l}`);
      }
  // Full-fallback is a COST decision, not a count decision: on big trees,
  // when rendering the diff costs nearly as much as the full snapshot
  // (navigation / full re-render), return the full tree instead. On small
  // trees the diff is always cheaper AND preserves per-ref addressing.
  // A capped text diff would silently drop content (pagination, feed
  // reloads): the full snapshot is the honest answer.
  if (textDiff.capped) {
    return { mode: "full", text: null, removed, added, changed, textAdded: textDiff.added, textRemoved: textDiff.removed, nextEntries: next.entries };
  }
  if (next.entries.length >= 20) {
    const diffLen = out.join("\n").length;
    const fullLen = Math.max(1, (next.text ?? "").length);
    if (diffLen >= 0.8 * fullLen) {
      return { mode: "full", text: null, removed, added, changed, textAdded: textDiff.added, textRemoved: textDiff.removed, nextEntries: next.entries };
    }
  }
  const text = out.join("\n");
  return { mode: "diff", text, removed, added, changed, textAdded: textDiff.added, textRemoved: textDiff.removed, nextEntries: next.entries };
}

/** Render "no changes" — the agent should NOT re-observe in a loop. */
export function noChangeText(prev, next) {
  return `no changes detected (state ${prev.stateId} → ${next.stateId}, ${next.entries.length} entries stable)`;
}
