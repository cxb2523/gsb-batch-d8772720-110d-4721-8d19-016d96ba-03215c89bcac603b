/**
 * Client-side export helpers. Everything here runs entirely in the browser -
 * no chart data or rendered image is ever sent to a server.
 */

/** A single labelled figure rendered into the PDF summary. */
export interface ExportStat {
  label: string;
  value: string;
  sub?: string;
}

/** Computed-style properties copied from the live chart onto the cloned SVG. */
const COPIED_STYLE_PROPS = [
  "fill",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "opacity",
  "font-family",
  "font-size",
  "font-weight",
  "text-anchor",
  "color",
] as const;

/** Pixel ratio used when rasterising the SVG so exported PNGs stay crisp. */
const SCALE = 2;

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "export"
  );
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Defer revocation so the browser has time to start the download; revoking
  // synchronously can cancel it in some environments.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Clone the SVG and inline computed styles so CSS variables (e.g. Primer
 * tokens used for axis/grid colours) resolve to concrete values in the
 * standalone image. Returns a serialised, self-contained SVG string plus its
 * pixel dimensions.
 */
function serializeSvg(svg: SVGSVGElement): { markup: string; width: number; height: number } {
  const rect = svg.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));

  const clone = svg.cloneNode(true) as SVGSVGElement;

  // Walk both trees in parallel and copy resolved styles onto the clone.
  const originals = [svg, ...Array.from(svg.querySelectorAll<SVGElement>("*"))];
  const clones = [clone, ...Array.from(clone.querySelectorAll<SVGElement>("*"))];
  for (let i = 0; i < originals.length; i++) {
    const computed = window.getComputedStyle(originals[i]);
    const target = clones[i];
    if (!target) continue;
    let inline = target.getAttribute("style") ?? "";
    for (const prop of COPIED_STYLE_PROPS) {
      const value = computed.getPropertyValue(prop);
      if (value && value !== "none" && value.trim() !== "") {
        inline += `${prop}:${value};`;
      }
    }
    target.setAttribute("style", inline);
  }

  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  clone.setAttribute("viewBox", `0 0 ${width} ${height}`);

  // Solid white backing so transparent areas don't render black in the PNG.
  const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("x", "0");
  bg.setAttribute("y", "0");
  bg.setAttribute("width", String(width));
  bg.setAttribute("height", String(height));
  bg.setAttribute("fill", "#ffffff");
  clone.insertBefore(bg, clone.firstChild);

  return { markup: new XMLSerializer().serializeToString(clone), width, height };
}

/** Rasterise a serialised SVG to a PNG data URL via an offscreen canvas. */
function svgToPng(
  markup: string,
  width: number,
  height: number,
): Promise<{ dataUrl: string; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const svgBlob = new Blob([markup], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = width * SCALE;
      canvas.height = height * SCALE;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(url);
        reject(new Error("Canvas 2D context unavailable"));
        return;
      }
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve({ dataUrl: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to rasterise chart SVG"));
    };
    img.src = url;
  });
}

/** Locate the first <svg> rendered by Recharts inside a container element. */
function findChartSvg(container: HTMLElement): SVGSVGElement {
  const svg = container.querySelector("svg");
  if (!svg) throw new Error("No chart found to export");
  return svg as SVGSVGElement;
}

/** Like findChartSvg but returns null instead of throwing when absent. */
function tryFindChartSvg(container: HTMLElement | null): SVGSVGElement | null {
  return (container?.querySelector("svg") as SVGSVGElement | null) ?? null;
}

/** Whether a container currently holds an exportable chart. */
export function hasChart(container: HTMLElement | null): boolean {
  return tryFindChartSvg(container) !== null;
}

/** Download the chart inside `container` as a PNG image. */
export async function exportChartPng(container: HTMLElement, title: string): Promise<void> {
  const svg = findChartSvg(container);
  const { markup, width, height } = serializeSvg(svg);
  const { dataUrl } = await svgToPng(markup, width, height);
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  triggerDownload(blob, `${slugify(title)}.png`);
}

/** Download a one-page PDF summary: title, key stats, and the chart image (if any). */
export async function exportSummaryPdf(
  container: HTMLElement | null,
  title: string,
  stats: ExportStat[],
  subtitle?: string,
): Promise<void> {
  const { jsPDF } = await import("jspdf");
  const svg = tryFindChartSvg(container);
  const png = svg
    ? await (async () => {
        const { markup, width, height } = serializeSvg(svg);
        return svgToPng(markup, width, height);
      })()
    : null;

  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 40;
  const contentWidth = pageWidth - margin * 2;
  let y = margin;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.setTextColor(31, 35, 40);
  doc.text(title, margin, y);
  y += 18;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(89, 99, 110);
  const generated = `Generated ${new Date().toLocaleDateString()} · processed locally in your browser`;
  doc.text(subtitle ? `${subtitle}` : generated, margin, y);
  if (subtitle) {
    y += 14;
    doc.text(generated, margin, y);
  }
  y += 20;

  // Key stats laid out in a row of cards.
  if (stats.length) {
    const gap = 12;
    const cardWidth = (contentWidth - gap * (stats.length - 1)) / stats.length;
    const cardHeight = 56;
    stats.forEach((stat, i) => {
      const x = margin + i * (cardWidth + gap);
      doc.setDrawColor(216, 222, 228);
      doc.setFillColor(246, 248, 250);
      doc.roundedRect(x, y, cardWidth, cardHeight, 4, 4, "FD");
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(89, 99, 110);
      doc.text(stat.label.toUpperCase(), x + 8, y + 16, { maxWidth: cardWidth - 16 });
      doc.setFont("helvetica", "bold");
      doc.setFontSize(13);
      doc.setTextColor(31, 35, 40);
      doc.text(stat.value, x + 8, y + 34, { maxWidth: cardWidth - 16 });
      if (stat.sub) {
        doc.setFont("helvetica", "normal");
        doc.setFontSize(8);
        doc.setTextColor(89, 99, 110);
        doc.text(stat.sub, x + 8, y + 48, { maxWidth: cardWidth - 16 });
      }
    });
    y += cardHeight + 20;
  }

  // Chart image, scaled to fit the remaining width while preserving aspect ratio.
  if (png) {
    const aspect = png.height / png.width;
    let imgWidth = contentWidth;
    let imgHeight = imgWidth * aspect;
    const maxHeight = doc.internal.pageSize.getHeight() - y - margin;
    if (imgHeight > maxHeight) {
      imgHeight = maxHeight;
      imgWidth = imgHeight / aspect;
    }
    doc.addImage(png.dataUrl, "PNG", margin, y, imgWidth, imgHeight);
  }

  doc.save(`${slugify(title)}.pdf`);
}
