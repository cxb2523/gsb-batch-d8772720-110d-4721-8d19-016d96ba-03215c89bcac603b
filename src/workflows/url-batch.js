import { existsSync, readFileSync } from "node:fs";

/** Read a URL source from a file, stdin (-), a single URL, or Markdown text. */
export function readUrlSource(source) {
  if (source === "-") return readFileSync(0, "utf8");
  if (existsSync(source)) return readFileSync(source, "utf8");
  return String(source ?? "");
}

/** Extract and de-duplicate web URLs from plain text or Markdown. */
export function extractUrls(text) {
  const seen = new Set();
  const out = [];
  for (const match of String(text).matchAll(/https?:\/\/[^\s<>"'`\)\]}]+/gi)) {
    const url = match[0].replace(/[),.;:!?]+$/g, "");
    if (!seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

function mdText(value) {
  return String(value ?? "").replace(/```/g, "''' ").replace(/\r/g, "");
}

/** Render compact ax_open_many results as a useful, honest Markdown report. */
export function renderUrlReport({ results, backend, source }) {
  const opened = results.filter((r) => r.status === "opened").length;
  const failed = results.length - opened;
  const lines = [
    "# axuse URL inspection report",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Backend: ${backend ?? "cdp"}`,
    `Source: ${source}`,
    `Results: ${opened} opened, ${failed} failed`,
    "",
    "> This report contains page titles, access status, and bounded accessibility-text excerpts. It is not an LLM-generated factual summary.",
    "",
  ];

  results.forEach((row, i) => {
    const title = row.title || row.final_url || row.url;
    lines.push(`## ${i + 1}. ${mdText(title)}`);
    lines.push(`- Source: <${row.url}>`);
    if (row.status === "opened") {
      lines.push(`- Status: opened (${row.ref_count ?? 0} accessibility refs)`);
      if (row.final_url && row.final_url !== row.url) lines.push(`- Final URL: <${row.final_url}>`);
      if (row.truncated) lines.push("- Note: snapshot excerpt was truncated by the page budget.");
      if (row.excerpt) {
        lines.push("", "```text", mdText(row.excerpt), "```");
      }
    } else {
      lines.push(`- Status: failed`);
      const error = row.error?.code
        ? `${row.error.code}: ${row.error.message ?? "unknown error"}`
        : row.error?.message ?? "unknown error";
      lines.push(`- Error: ${mdText(error)}`);
      if (row.error?.hint) lines.push(`- Hint: ${mdText(row.error.hint)}`);
    }
    lines.push("");
  });
  return lines.join("\n");
}
