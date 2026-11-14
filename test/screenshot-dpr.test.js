/**
 * Screenshot pixels must equal click pixels at ANY devicePixelRatio.
 *
 * ax_screenshot tells the model "image WxH = viewport CSS px; pass ax_click
 * {x,y} in these same pixels". Page.captureScreenshot's clip.scale multiplies
 * on top of devicePixelRatio, so a headed Chrome on a 125% Windows display (or
 * any retina Mac at 2x) returned an image 1.25x/2x larger than the note
 * claimed, and every coordinate the model read off it landed 1.25x/2x off
 * target. Emulating the ratio makes the headless CI lane reproduce it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { locateBrowser } from "../src/core/cdp.js";
import { Controller } from "../src/core/controller.js";

const hasBrowser = !!locateBrowser();

/** Pixel size of a JPEG, read from its SOF marker. */
function jpegSize(b64) {
  const b = Buffer.from(b64, "base64");
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xc3) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  throw new Error("no SOF marker");
}

const PAGE = "data:text/html," + encodeURIComponent(
  '<body style="margin:0"><canvas width="500" height="300" style="margin:20px;background:#eee"></canvas></body>');

test("screenshot image pixels == CSS pixels at any devicePixelRatio", { skip: !hasBrowser }, async (t) => {
  const c = new Controller();
  t.after(() => c.dispose());
  const opened = await c.execute("open", { url: PAGE, headless: true, settle_ms: 100 });
  const tab = opened.tab_id;

  for (const dpr of [1, 1.25, 2, 3]) {
    await c.cdpSend(tab, "Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: dpr, mobile: false });
    const seen = await c.execute("evaluate", { tab_id: tab, expression: "devicePixelRatio" });
    assert.equal(Number(seen.value), dpr, `emulated dpr ${dpr} took effect`);

    const full = await c.execute("screenshot", { tab_id: tab });
    const { w, h } = jpegSize(full.image.base64);
    const claimed = full.note.match(/image (\d+)x(\d+)/);
    assert.deepEqual([w, h], [Number(claimed[1]), Number(claimed[2])], `dpr ${dpr}: image is ${w}x${h}, note claims ${claimed[1]}x${claimed[2]}`);
    assert.equal(w, 800, `dpr ${dpr}: full-viewport width is CSS px`);

    const crop = await c.execute("screenshot", { tab_id: tab, crop: { x: 20, y: 20, w: 300, h: 200 } });
    assert.deepEqual(Object.values(jpegSize(crop.image.base64)), [300, 200], `dpr ${dpr}: crop is w x h CSS px`);
  }
});
