/**
 * axuse — model-facing rendering of command results.
 *
 * Observations are text trees; wrapping them in JSON escapes every newline
 * and quote (`\n`, `\"`) and repeats url/title/state fields the tree header
 * already carries. That is pure token tax on every single step. Results with
 * an observation render as plain text: a short facts line, notes, then the
 * tree/diff verbatim. Everything else stays compact JSON.
 */

function obsBlock(obs) {
  if (!obs) return "";
  if (obs.dialog) return `dialog open: ${obs.dialog.type} "${obs.dialog.message}"\n${obs.hint ?? ""}`.trim();
  if (obs.skipped) return `observation skipped (${obs.skipped}): ${obs.hint ?? ""}`;
  const head = (obs.mode === "diff" && !/^no changes/.test(obs.text ?? "")) || obs.mode === "find" ? `state: ${obs.state_id}\n` : "";
  const trunc = obs.truncated && !/truncated/.test(obs.text ?? "") ? "\nnote: truncated by budget — pass max_nodes/max_chars" : "";
  const suppressed = obs.diff_suppressed ? "(full snapshot — the diff would have been larger)\n" : "";
  return `${suppressed}${head}${obs.text ?? ""}${trunc}`;
}

export function renderResult(command, result) {
  if (!result || typeof result !== "object") return String(result);
  const { observation, meta, new_tab, ...rest } = result;
  if (!observation && !new_tab) {
    const { meta: _m, ...plain } = result;
    return JSON.stringify(plain);
  }
  const facts = [];
  if (rest.action_sent && rest.action_sent !== "sent") facts.push(`action: ${rest.action_sent}`);
  if (rest.tab_id && command !== "observe") facts.push(`tab: ${rest.tab_id}`);
  if (rest.frame) facts.push(`frame: ${rest.frame}`);
  if (rest.value !== undefined) facts.push(`value: ${JSON.stringify(rest.value)}`);
  if (rest.answered) facts.push(`dialog ${rest.answered}ed`);
  if (rest.uploaded) facts.push(`uploaded: ${rest.uploaded.join(", ")}`);
  if (rest.ok !== undefined) facts.push(rest.ok ? `ok after ${rest.elapsed_ms}ms` : "timeout");
  if (rest.filled !== undefined) facts.push(`filled: ${[].concat(rest.filled).join("; ")}${rest.submitted ? `; then clicked ${rest.submitted}` : ""}`);
  if (rest.dialog) facts.push(`dialog open: ${rest.dialog.type} "${rest.dialog.message}" — answer with ax_dialog`);
  if (rest.display?.virtual) facts.push(`display: ${rest.display.id} (virtual ${rest.display.width}x${rest.display.height} — headed on Xvfb, server mode)`);
  const parts = [];
  if (facts.length) parts.push(facts.join(" · "));
  if (rest.note) parts.push(`note: ${rest.note}`);
  if (rest.tab_note) parts.push(`note: ${rest.tab_note}`);
  parts.push(obsBlock(observation));
  if (new_tab) parts.push(`--- new tab ${new_tab.tab_id} ---\n${obsBlock(new_tab.observation)}`);
  return parts.filter(Boolean).join("\n");
}
