/**
 * ax_observe {find}: a match is shown with ITS OWN item.
 *
 * In a flat snapshot the line just above an author's name is the previous
 * article's "Like" button. Showing +-N neighbouring lines therefore put the
 * wrong row's button next to the match, and agents clicked it (benchmark t7:
 * 2 of 3 runs liked the neighbouring post, which is unrecoverable there).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { locateBrowser } from "../src/core/cdp.js";
import { Controller } from "../src/core/controller.js";

const hasBrowser = !!locateBrowser();

const feed = (n) => Array.from({ length: n }, (_, i) =>
  `<article><b>@user${i + 1}</b><p>Post #${i + 1}: topic</p><button>Like</button></article>`).join("");
const list = Array.from({ length: 5 }, (_, i) => `<li>Item ${i + 1} <button>Buy ${i + 1}</button></li>`).join("");
const table = Array.from({ length: 4 }, (_, i) => `<tr><td>Row ${i + 1}</td><td><button>Edit ${i + 1}</button></td></tr>`).join("");
const PAGE = "data:text/html," + encodeURIComponent(
  `<body><h1>Team feed</h1>${feed(6)}<ul>${list}</ul><table>${table}</table></body>`);

test("find shows each match with its own item", { skip: !hasBrowser }, async (t) => {
  const c = new Controller();
  t.after(() => c.dispose());
  const opened = await c.execute("open", { url: PAGE, headless: true, settle_ms: 100 });
  const tab = opened.tab_id;
  const find = async (needle) => (await c.execute("observe", { tab_id: tab, find: needle })).observation.text;

  await t.test("article: the author's own Like, none of the neighbours'", async () => {
    const text = await find("@user3");
    assert.match(text, /@user3/);
    assert.match(text, /Post #3/);
    assert.equal((text.match(/button "Like"/g) ?? []).length, 1, "exactly one Like, the match's own");
    assert.doesNotMatch(text, /Post #2|Post #4|@user2|@user4/, "no neighbouring item leaks in");
    assert.match(text, /each match is shown with its own item/);
  });

  await t.test("list item and table row behave the same", async () => {
    const li = await find("Item 2");
    assert.match(li, /Buy 2/);
    assert.doesNotMatch(li, /Buy 1|Buy 3/);
    const tr = await find("Row 3");
    assert.match(tr, /Edit 3/);
    assert.doesNotMatch(tr, /Edit 2|Edit 4/);
  });

  await t.test("matches outside any item keep the old line context", async () => {
    const text = await find("Team feed");
    assert.match(text, /Team feed/);
    assert.match(text, /@user1/, "context lines after a heading are still shown");
  });

  await t.test("two matches in adjacent items are separated", async () => {
    const text = await find("@user");
    assert.match(text, /@user1/);
    assert.match(text, /·/, "item boundary marker between adjacent matched items");
  });
});
