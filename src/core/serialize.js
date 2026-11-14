/**
 * axuse — page serializer (injected into the page via Runtime.evaluate).
 *
 * Lineage: Codex's injected DOM sanitizer (shadow roots, script/style skip,
 * absolute hrefs, character budgets) + ZCode's ref-addressed snapshot
 * ("elements[] with ref e1,e2… stored in the page", anonymous containers
 * flattened, nameless images dropped).
 *
 * The snapshot is a compact YAML-ish accessibility tree. Every actionable
 * element gets a stable ref for this observation cycle. Refs live in the
 * page (window.__axuseRefs) and are resolved LIVE at action time — if the
 * layout moved between observe and act, the click still lands on the
 * element, not on remembered pixels.
 *
 * Design rules:
 *  - refs are per-observation: a fresh snapshot replaces the map. Acting on a
 *    ref from an older observation fails with REF_NOT_FOUND → re-observe.
 *  - budgets are enforced here (max_nodes, max_chars), with a truncated flag.
 *  - pixels are never taken here. This is the cheap observation.
 *  - names follow the accessible-name rules that matter in practice
 *    (aria-labelledby → aria-label → <label> → content → placeholder/title),
 *    and STATES are printed (checked/expanded/selected/pressed/disabled/…):
 *    a switch without its on/off state is a coin flip for the model.
 *  - tables print one line per row; paragraphs keep inline link text in the
 *    sentence. Both are cheaper AND easier to read than per-cell lines.
 */

/**
 * Runs inside the page. Returns an observation object.
 * Keep it self-contained and ES2017-ish; it is stringified and evaluated.
 *
 * @param {{maxNodes?: number, maxChars?: number, maxText?: number}} [opts]
 */
export function pageSerializer(opts) {
  opts = opts || {};
  var MAX_NODES = opts.maxNodes || 300;
  var MAX_CHARS = opts.maxChars || 24000;
  var MAX_TEXT = opts.maxText || 160;
  var ROW_TEXT = 400;

  var refs = {}; // ref → live element (CURRENT observation only)
  window.__axuseRefs = refs; // fresh map per observation (stale refs must die)
  // Identity registry: a ref is bound to the ELEMENT, not to its ordinal —
  // so unchanged elements keep their refs across observations and diffs can
  // safely omit unchanged rows. Insertions mid-tree never re-number.
  var REG = window.__axuseRefRegistry;
  if (!REG || !(REG instanceof Map)) { REG = new Map(); window.__axuseRefRegistry = REG; }
  var regSeq = window.__axuseRefSeq || 0;
  var lines = [];
  var entries = []; // {ref, line} — the diffable representation
  var textLines = []; // raw text/row lines — text participates in diffs
  var n = 0;
  var chars = 0;
  var truncated = false;
  var clipped = 0; // long texts shortened with "…" (full text: observe mode "text")

  var SKIP = { SCRIPT: 1, STYLE: 1, LINK: 1, META: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, TITLE: 1, SVG: 1 };
  // Elements whose text IS their label (buttons with icon spans, links).
  var LEAFY = { BUTTON: 1, A: 1, SUMMARY: 1, OPTION: 1, TH: 1, TD: 1, DT: 1, DD: 1, CAPTION: 1, LEGEND: 1, FIGCAPTION: 1, LABEL: 1, MARK: 1, TIME: 1, CODE: 1, ABBR: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1 };
  // Roles whose own text is their name (their subtree adds nothing).
  var NAMED_BY_CONTENT = { button: 1, link: 1, tab: 1, option: 1, menuitem: 1, menuitemcheckbox: 1, menuitemradio: 1, switch: 1, checkbox: 1, radio: 1, listitem: 1, treeitem: 1, cell: 1, gridcell: 1, heading: 1, columnheader: 1, rowheader: 1, tooltip: 1, status: 1, alert: 1 };
  var LEAF_ROLES = { button: 1, link: 1, option: 1, menuitem: 1, menuitemcheckbox: 1, menuitemradio: 1, tab: 1, heading: 1, switch: 1, checkbox: 1, radio: 1, textbox: 1, combobox: 1, searchbox: 1, slider: 1, spinbutton: 1 };
  // Containers are never named from their own text (no `navigation "·"`).
  var CONTAINER = { navigation: 1, main: 1, form: 1, list: 1, table: 1, region: 1, complementary: 1, banner: 1, contentinfo: 1, group: 1, article: 1, listbox: 1, menu: 1, menubar: 1, tablist: 1, toolbar: 1, dialog: 1, alertdialog: 1, grid: 1, tree: 1, radiogroup: 1, row: 1, rowgroup: 1, tabpanel: 1, feed: 1, search: 1 };
  var INLINE = { A: 1, B: 1, STRONG: 1, EM: 1, I: 1, SPAN: 1, CODE: 1, SMALL: 1, MARK: 1, ABBR: 1, TIME: 1, KBD: 1, SUB: 1, SUP: 1, U: 1, S: 1, BR: 1, Q: 1, CITE: 1 };

  function clip(t, max) {
    max = max || MAX_TEXT;
    t = (t == null ? "" : String(t)).replace(/\s+/g, " ").trim();
    if (t.length <= max) return t;
    clipped++;
    return t.slice(0, max) + "…";
  }
  function q(t) { return String(t).replace(/"/g, "'"); }
  function directText(el) {
    var s = "";
    for (var i = 0; i < el.childNodes.length; i++) {
      var c = el.childNodes[i];
      if (c.nodeType === 3) s += c.nodeValue;
    }
    return clip(s);
  }
  function roleOf(el, tag) {
    var explicit = el.getAttribute("role");
    if (explicit) {
      explicit = explicit.trim().split(/\s+/)[0];
      if (explicit === "presentation" || explicit === "none" || explicit === "generic") return null;
      return explicit;
    }
    switch (tag) {
      case "BUTTON": return "button";
      case "A": return el.hasAttribute("href") ? "link" : null;
      case "SELECT": return el.multiple ? "listbox" : "combobox";
      case "TEXTAREA": return "textbox";
      case "INPUT": {
        var t = (el.getAttribute("type") || "text").toLowerCase();
        if (t === "hidden") return null;
        if (t === "checkbox") return "checkbox";
        if (t === "radio") return "radio";
        if (t === "submit" || t === "button" || t === "reset" || t === "image" || t === "file") return "button";
        if (t === "range") return "slider";
        if (t === "number") return "spinbutton";
        if (t === "search") return "searchbox";
        if (el.getAttribute("list")) return "combobox";
        return "textbox";
      }
      case "IMG": return (el.getAttribute("alt") || el.getAttribute("aria-label")) ? "img" : null;
      case "H1": case "H2": case "H3": case "H4": case "H5": case "H6": return "heading";
      case "LI": return "listitem";
      case "UL": case "OL": return "list";
      case "TABLE": return "table";
      case "FORM": return "form";
      case "NAV": return "navigation";
      case "MAIN": return "main";
      case "DIALOG": return el.open ? "dialog" : null;
      case "SECTION": return (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby")) ? "region" : null;
      case "ASIDE": return "complementary";
      case "ARTICLE": return "article";
      case "DETAILS": return "group";
      case "SUMMARY": return "button";
      case "FIELDSET": return "group";
      case "PROGRESS": return "progressbar";
      case "METER": return "meter";
      case "CANVAS": return "canvas";
      case "VIDEO": return "video";
      case "AUDIO": return "audio";
      default: return null;
    }
  }
  function byIds(el, ids) {
    var root = el.getRootNode ? el.getRootNode() : document;
    var out = [];
    String(ids).split(/\s+/).forEach(function (id) {
      if (!id) return;
      var t = (root && root.getElementById ? root.getElementById(id) : null) || document.getElementById(id);
      if (!t) return;
      if (t === el) out.push(el.getAttribute("aria-label") || directText(el));
      else out.push(t.innerText || t.textContent || "");
    });
    return out.join(" ");
  }
  function nameOf(el, tag, role) {
    var s = "";
    var lb = el.getAttribute("aria-labelledby");
    if (lb) s = byIds(el, lb);
    if (!s) s = el.getAttribute("aria-label") || "";
    if (!s && tag === "IMG") s = el.getAttribute("alt") || "";
    if (!s && (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT")) {
      try {
        if (el.labels && el.labels.length) s = el.labels[0].innerText || el.labels[0].textContent;
      } catch (e) {}
      if (!s) {
        var ty = (el.getAttribute("type") || "").toLowerCase();
        if (ty === "submit" || ty === "button" || ty === "reset") s = el.value || ty;
      }
      if (!s) s = el.getAttribute("placeholder") || el.getAttribute("title") || "";
      return clip(s);
    }
    if (!s && tag === "FIELDSET") { var lg = el.querySelector("legend"); if (lg) s = lg.innerText; }
    if (!s && tag === "TABLE") { var cap = el.querySelector("caption"); if (cap) s = cap.innerText; }
    if (!s && role && CONTAINER[role]) return clip(el.getAttribute("title") || "");
    if (!s) s = directText(el);
    if (!s && (LEAFY[tag] || NAMED_BY_CONTENT[role])) s = el.innerText;
    if (!s) s = el.getAttribute("title") || "";
    return clip(s);
  }
  // Accessibility STATES — what makes a switch/tab/option actionable.
  function stateAttrs(el, tag, role, attrs) {
    var a = function (k) { return el.getAttribute(k); };
    if (tag === "INPUT" && (role === "checkbox" || role === "radio" || role === "switch")) {
      attrs.push(el.checked ? "checked" : "unchecked");
    } else {
      var ch = a("aria-checked");
      if (ch !== null) attrs.push(ch === "true" ? "checked" : ch === "mixed" ? "mixed" : "unchecked");
    }
    var pr = a("aria-pressed"); if (pr !== null) attrs.push("pressed=" + pr);
    if (a("aria-selected") === "true" || (tag === "OPTION" && el.selected)) attrs.push("selected");
    var ex = a("aria-expanded"); if (ex !== null) attrs.push("expanded=" + ex);
    var hp = a("aria-haspopup"); if (hp && hp !== "false") attrs.push(hp === "true" ? "haspopup" : "haspopup=" + hp);
    var cu = a("aria-current"); if (cu && cu !== "false") attrs.push(cu === "true" ? "current" : "current=" + cu);
    if (el.disabled || a("aria-disabled") === "true") attrs.push("disabled");
    if (el.required || a("aria-required") === "true") attrs.push("required");
    if (el.readOnly && (tag === "INPUT" || tag === "TEXTAREA")) attrs.push("readonly");
    if (a("aria-invalid") === "true") attrs.push("invalid");
    var vn = a("aria-valuenow"); if (vn !== null) attrs.push("value=" + (a("aria-valuetext") || vn));
    if (role === "heading") { var lv = a("aria-level") || (/^H[1-6]$/.test(tag) ? tag.slice(1) : ""); if (lv) attrs.push("level=" + lv); }
    if (el.isContentEditable && tag !== "INPUT" && tag !== "TEXTAREA") {
      attrs.push("editable");
      var tx = clip(el.innerText); if (tx) attrs.push('value="' + q(tx) + '"');
    }
  }
  function visible(el) {
    if (el.hidden || el.getAttribute("aria-hidden") === "true") return false;
    var r = el.getBoundingClientRect();
    if (r.width > 0 || r.height > 0) {
      var cs = getComputedStyle(el);
      return cs.visibility !== "hidden" && cs.visibility !== "collapse";
    }
    // display:contents wrappers have no box but render their children.
    return getComputedStyle(el).display === "contents";
  }
  // Item ownership for ax_observe {find}: every emitted line remembers the
  // nearest enclosing article / list item / table row, so a match can be shown
  // with ITS item instead of the neighbouring lines (which, in a flat list,
  // belong to the previous item and invite clicking the wrong row's button).
  var itemSeq = 0, curItem = 0, lineItem = [];
  function push(line) {
    if (chars + line.length > MAX_CHARS) { truncated = true; return; }
    lines.push(line);
    lineItem.push(curItem);
    chars += line.length;
  }
  function emitText(t, depth, kind) {
    var tl = "- " + (kind || "text") + ' "' + q(t) + '"';
    push("  ".repeat(depth) + tl);
    if (!truncated) lines[lines.length - 1] = { s: lines[lines.length - 1], tl: tl, t: q(t), kind: kind || "text" };
  }
  function cellText(cell) {
    var t = (cell.innerText || cell.textContent || "").replace(/\s+/g, " ").trim();
    if (!t) {
      var f = cell.querySelector && cell.querySelector("input,select,textarea");
      if (f && f.value) t = '"' + f.value + '"';
    }
    return t.length > 80 ? t.slice(0, 80) + "…" : t;
  }

  // quiet=true: inside a container whose text was already emitted (table
  // row, inline paragraph, named leaf) — only actionable descendants print.
  function walk(node, depth, quiet) {
    if (truncated || !node || !node.childNodes) return;
    var kids = node.childNodes;
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i];
      if (c.nodeType !== 1) continue;
      if (c.tagName === "SLOT") {
        var as = c.assignedElements ? c.assignedElements({ flatten: true }) : [];
        if (as.length) { for (var k = 0; k < as.length; k++) one(as[k], depth, quiet); }
        else walk(c, depth, quiet);
        continue;
      }
      one(c, depth, quiet);
      if (truncated) return;
    }
  }

  function one(c, depth, quiet) {
    var tg = c.tagName;
    var rl = c.getAttribute ? c.getAttribute("role") : null;
    if (tg === "ARTICLE" || tg === "LI" || tg === "TR" || rl === "article" || rl === "listitem" || rl === "row") {
      var prevItem = curItem;
      curItem = ++itemSeq;
      try { visit(c, depth, quiet); } finally { curItem = prevItem; }
    } else visit(c, depth, quiet);
  }

  function visit(c, depth, quiet) {
    var tag = c.tagName;
    if (SKIP[tag]) return;
    if (!visible(c)) return;

    // Table rows: one compact line per row; actionable cells still get ref
    // lines underneath.
    if (tag === "TR") {
      if (!quiet) {
        var cells = [];
        for (var j = 0; j < c.children.length; j++) {
          var ce = c.children[j];
          if (ce.tagName === "TD" || ce.tagName === "TH") cells.push(cellText(ce));
        }
        var rt = cells.join(" | ");
        if (rt.length > ROW_TEXT) rt = rt.slice(0, ROW_TEXT) + "…";
        if (rt.replace(/[|\s]/g, "")) emitText(rt, depth, "row");
      }
      walk(c, depth + 1, true);
      return;
    }

    var role = roleOf(c, tag);
    var editableRoot = c.isContentEditable && (!c.parentElement || !c.parentElement.isContentEditable);
    if (editableRoot && !role) role = "textbox";
    var interesting = !!role || editableRoot || (c.tabIndex >= 0 && tag !== "HTML" && tag !== "BODY" && !c.isContentEditable);
    if (tag === "IFRAME") { interesting = true; role = "iframe"; }
    // Inside an already-described container, structural roles are noise.
    if (quiet && role && (CONTAINER[role] || role === "listitem")) interesting = false;
    // Lists are structure, not content: their items carry the information.
    if (role === "list") interesting = false;
    // Unnamed generic containers (article/group/row…) add a line and a ref
    // per item with no information — stay transparent unless focusable.
    if (interesting && (role === "article" || role === "group" || role === "row" || role === "rowgroup" || role === "region" || role === "feed" || role === "complementary") && c.tabIndex < 0
        && !c.getAttribute("aria-label") && !c.getAttribute("aria-labelledby") && !(tag === "FIELDSET" && c.querySelector("legend"))) interesting = false;

    var shadow = c.shadowRoot;

    if (interesting) {
      if (n >= MAX_NODES || truncated) { truncated = true; return; }
      n++;
      var ref = REG.get(c);
      if (!ref) { regSeq++; ref = "e" + regSeq; REG.set(c, ref); }
      refs[ref] = c;
      var name = nameOf(c, tag, role);
      var attrs = [];
      if (tag === "A" && c.href) {
        attrs.push("href=" + clip(new URL(c.href, location.href).href));
        if (c.target === "_blank") attrs.push("new-tab");
      }
      if (tag === "INPUT" || tag === "TEXTAREA") {
        var ty = (c.getAttribute("type") || "text").toLowerCase();
        var boolish = ty === "checkbox" || ty === "radio";
        if (ty !== "text" && ty !== "search" && !boolish && ty !== "submit" && ty !== "button") attrs.push("type=" + ty);
        if (!boolish && ty !== "submit" && ty !== "button" && ty !== "password" && c.value) attrs.push('value="' + q(clip(c.value)) + '"');
        if (boolish && c.value && c.value !== "on" && c.value !== name) attrs.push('value="' + q(clip(c.value)) + '"');
        var ph = c.getAttribute("placeholder");
        if (ph && ph !== name) attrs.push('placeholder="' + q(clip(ph)) + '"');
      }
      if (tag === "SELECT") {
        var so = c.selectedIndex >= 0 ? c.options[c.selectedIndex] : null;
        if (so) attrs.push('value="' + q(clip(so.text || so.value)) + '"');
        var ol = [];
        for (var o = 0; o < c.options.length && o < 25; o++) ol.push(q(clip(c.options[o].text || c.options[o].value, 40)));
        if (ol.length) attrs.push("options={" + ol.join(", ") + (c.options.length > 25 ? ", …+" + (c.options.length - 25) : "") + "}");
      }
      stateAttrs(c, tag, role, attrs);
      if (tag === "CANVAS" || tag === "VIDEO") {
        var br = c.getBoundingClientRect();
        attrs.push("box=" + Math.round(br.left) + "," + Math.round(br.top) + "," + Math.round(br.width) + "x" + Math.round(br.height) + " viewport px");
        if (tag === "CANVAS") attrs.push("pixels-only: ax_screenshot, then ax_click {x,y} in screenshot pixels");
      }
      var walkInline = null;
      if (tag === "IFRAME") {
        try {
          var fdoc = c.contentDocument;
          if (fdoc && fdoc.body) walkInline = fdoc.body;
        } catch (e) { /* cross-origin */ }
        if (!walkInline) attrs.push("cross-origin");
      }
      var line =
        "  ".repeat(depth) + "- " + (role || tag.toLowerCase()) +
        (name ? ' "' + q(name) + '"' : "") +
        (attrs.length ? " (" + attrs.join(", ") + ")" : "") +
        " [ref=" + ref + "]";
      push(line);
      if (!truncated) lines[lines.length - 1] = { s: line, name: q(name) };
      entries.push({ ref: ref, line: line });
      if (walkInline) walk(walkInline, depth + 1);
      var leaf = !!(LEAFY[tag] || LEAF_ROLES[role] || editableRoot);
      if (shadow) walk(shadow, depth + 1, quiet || leaf);
      walk(c, depth + 1, quiet || leaf);
      return;
    }

    if (shadow) { walk(shadow, depth, quiet); return; }
    if (quiet) { walk(c, depth, true); return; }
    // Paragraph-like element with only inline children: its FULL text once
    // (link text stays in the sentence), then only actionable inline kids.
    var dt = directText(c);
    if (dt && c.children.length) {
      var inlineOnly = true;
      for (var m = 0; m < c.children.length; m++) if (!INLINE[c.children[m].tagName]) { inlineOnly = false; break; }
      if (inlineOnly) {
        var full = clip(c.innerText, 400);
        if (full) emitText(full, depth);
        walk(c, depth, true);
        return;
      }
    }
    if (dt) emitText(dt, depth);
    walk(c, depth);
  }

  try {
    // ACP-1 (2026-10-17): during early load some pages briefly expose no
    // document.body (observed live on ag-grid.com) — serialize the document
    // element instead of crashing the whole observation, and null-guard the
    // walk (defensive: nodes can detach mid-walk on mutating pages).
    walk(document.body || document.documentElement, 0);
  } catch (e) {
    return { ok: false, error: String(e && e.stack || e) };
  }
  window.__axuseRefSeq = regSeq;
  // Drop label-echo text: a plain text line that merely repeats the name of
  // the adjacent element (label → control, legend → group) costs tokens and
  // invites the model to "click the label".
  var out = [], outItem = [];
  for (var li = 0; li < lines.length; li++) {
    var L = lines[li];
    if (typeof L === "string") { out.push(L); outItem.push(lineItem[li]); continue; }
    if (L.tl) {
      if (L.kind === "text") {
        var prev = lines[li - 1], next = lines[li + 1];
        var echo = function (o) { return o && typeof o === "object" && o.name && (o.name === L.t || o.name.indexOf(L.t + " ") === 0); };
        if (echo(prev) || echo(next)) continue;
      }
      out.push(L.s); outItem.push(lineItem[li]); textLines.push(L.tl);
    } else { out.push(L.s); outItem.push(lineItem[li]); }
  }
  lines = out;
  return {
    ok: true,
    url: location.href,
    title: clip(document.title),
    text: lines.join("\n"),
    items: outItem,
    entries: entries,
    textLines: textLines,
    truncated: truncated,
    clipped: clipped,
    refCount: n,
    scroll: { x: window.scrollX, y: window.scrollY },
  };
}

/** Build the Runtime.evaluate payload that runs the serializer in a tab. */
export function serializeExpression(opts) {
  return `(${pageSerializer.toString()})(${JSON.stringify(opts ?? {})})`;
}
