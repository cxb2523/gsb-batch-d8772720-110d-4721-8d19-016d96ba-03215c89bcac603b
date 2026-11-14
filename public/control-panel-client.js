"use strict";

const state = {
  status: null,
  selectedMode: "full",
  toastTimer: null,
  pollTimer: null
};

const byId = (id) => document.getElementById(id);

function showToast(message, isError = false) {
  const toast = byId("toast");
  toast.textContent = message;
  toast.classList.toggle("is-error", isError);
  toast.classList.add("is-visible");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 3200);
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: options.body ? { "content-type": "application/json" } : undefined
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `请求失败：${response.status}`);
  return payload;
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("浏览器未允许访问剪贴板");
}

function setMode(mode) {
  state.selectedMode = mode;
  document.querySelectorAll("[data-mode]").forEach((button) => {
    const selected = button.dataset.mode === mode;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-selected", String(selected));
  });
  const full = byId("flow-full");
  const direct = byId("flow-direct");
  full.hidden = mode !== "full";
  direct.hidden = mode !== "direct";
  full.classList.toggle("is-hidden", mode !== "full");
  direct.classList.toggle("is-hidden", mode !== "direct");
  if (mode === "direct") direct.scrollIntoView({ behavior: "smooth", block: "start" });
}

function dateText(value) {
  return value || "—";
}

function joinDisplayPath(base, child) {
  const separator = String(base || "").includes("\\") ? "\\" : "/";
  return `${String(base || "").replace(/[\\/]+$/, "")}${separator}${child}`;
}

function renderAccounts(accounts) {
  const select = byId("account-select");
  const previous = select.value;
  select.innerHTML = "";
  (accounts || ["account1"]).forEach((account) => {
    const option = document.createElement("option");
    option.value = account;
    option.textContent = account;
    select.append(option);
  });
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
}

function currentJob(status) {
  return status.active_job || status.last_job;
}

function renderJob(status) {
  const job = currentJob(status);
  const chip = byId("job-chip");
  const output = byId("job-output");
  chip.className = "chip";

  if (!job) {
    chip.textContent = "当前无任务";
    output.textContent = "等待操作。建议顺序：登录 → 校验 → 演练 → 正式发布。";
    return;
  }

  const labels = {
    running: "任务运行中",
    succeeded: "最近任务成功",
    failed: "最近任务失败"
  };
  chip.textContent = labels[job.status] || job.status;
  if (job.status === "running") chip.classList.add("chip-running");
  if (job.status === "failed") chip.classList.add("chip-failed");
  if (job.status === "succeeded") chip.classList.add("chip-safe");
  output.textContent = job.output || "任务已启动，等待日志…";
  if (job.status === "running") output.scrollTop = output.scrollHeight;
}

function updatePublishGate() {
  const status = state.status;
  if (!status) return;
  const expected = status.batch?.batch_id || "";
  const typed = byId("publish-batch-id").value.trim();
  const confirmed = byId("publish-confirm").checked;
  const validationPass = status.validation?.status === "PASS";
  const pending = Number(status.counts?.pending || 0);
  const running = Boolean(status.active_job);
  const enabled = validationPass && pending > 0 && typed === expected && confirmed && !running;
  byId("publish-button").disabled = !enabled;

  let hint = "批次校验通过、批次 ID 一致并勾选确认后才能发布。";
  if (!validationPass) hint = "当前批次校验未通过，不能正式发布。";
  else if (!pending) hint = "当前批次没有待发布条目。";
  else if (typed && typed !== expected) hint = "批次 ID 不一致。";
  else if (running) hint = "已有任务正在运行。";
  byId("publish-gate-hint").textContent = hint;
}

function renderStatus(status) {
  state.status = status;
  const batch = status.batch || {};
  byId("batch-id").textContent = batch.batch_id || "无有效批次";
  byId("batch-id").title = batch.batch_id || "";
  byId("copy-batch-id").disabled = !batch.batch_id;
  byId("pending-count").textContent = `${status.counts.pending} 条`;
  byId("source-count").textContent = `${status.counts.source_images} 张原图`;
  byId("renamed-count").textContent = `${status.counts.renamed_images} 张待处理副本`;
  byId("schedule-range").textContent = status.validation?.first_scheduled_at
    ? `${dateText(status.validation.first_scheduled_at)} → ${dateText(status.validation.last_scheduled_at)}`
    : "—";

  const validation = byId("validation-state");
  validation.textContent = status.validation?.status || "FAIL";
  validation.className = status.validation?.status === "PASS" ? "state-pass" : "state-fail";
  validation.title = status.validation?.error || "";

  const safety = byId("safety-chip");
  safety.textContent = status.panel.persistent_dry_run ? "持久安全模式" : "配置已开启真实发布";
  safety.className = status.panel.persistent_dry_run ? "chip chip-safe" : "chip chip-failed";
  const maintenanceBlocked = Boolean(status.active_job || status.maintenance_running);
  document.querySelectorAll("[data-clear-folder]").forEach((button) => {
    button.disabled = maintenanceBlocked;
  });
  renderAccounts(status.accounts);
  renderJob(status);
  updatePublishGate();
}

async function refreshStatus({ quiet = false } = {}) {
  try {
    renderStatus(await request("/api/panel/status"));
  } catch (error) {
    if (!quiet) showToast(error.message, true);
  } finally {
    clearTimeout(state.pollTimer);
    state.pollTimer = setTimeout(() => refreshStatus({ quiet: true }), state.status?.active_job ? 1500 : 5000);
  }
}

async function startJob(action) {
  const account = byId("account-select").value || "account1";
  const body = { action, account, scope: "one" };
  if (action === "publish") {
    body.scope = byId("publish-scope").value;
    body.batch_id = byId("publish-batch-id").value.trim();
    body.confirmed = byId("publish-confirm").checked;
  }
  try {
    await request("/api/panel/jobs", { method: "POST", body: JSON.stringify(body) });
    showToast("任务已启动，请查看运行日志");
    await refreshStatus({ quiet: true });
    byId("job-output").scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (error) {
    showToast(error.message, true);
  }
}

async function openFolder(folder) {
  try {
    await request("/api/panel/open-folder", { method: "POST", body: JSON.stringify({ folder }) });
    showToast("文件夹已打开");
  } catch (error) {
    showToast(error.message, true);
  }
}

async function clearFolder(folder) {
  const definitions = {
    source: {
      label: "待发布-素材",
      count: Number(state.status?.counts?.source_images || 0),
      path: state.status?.paths?.source_images || "",
      confirmation: "CLEAR_SOURCE_IMAGES",
      resultId: "source-clear-result",
      warning: "原始图片会从待处理列表移走。"
    },
    renamed: {
      label: "已重命名-素材",
      count: Number(state.status?.counts?.renamed_images || 0),
      path: state.status?.paths?.renamed_images || "",
      confirmation: "CLEAR_RENAMED_IMAGES",
      resultId: "renamed-clear-result",
      warning: "清空后，当前剩余批次将不能继续校验或发布，直到重新生成素材。"
    }
  };
  const definition = definitions[folder];
  if (!definition) return;

  const confirmed = window.confirm(
    `确认永久清空“${definition.label}”吗？\n\n目录：${definition.path}\n当前显示：${definition.count} 张图片\n${definition.warning}\n\n目录内全部内容将直接删除，不会进入项目回收区，删除后无法由控制台恢复。`
  );
  if (!confirmed) return;

  try {
    const payload = await request("/api/panel/clear-folder", {
      method: "POST",
      body: JSON.stringify({ folder, confirmation: definition.confirmation })
    });
    const result = payload.result;
    byId(definition.resultId).textContent = result.deleted_entries
      ? `已永久删除 ${result.deleted_entries} 项，无法由控制台恢复。`
      : "文件夹原本就是空的，无需处理。";
    showToast(result.deleted_entries ? `已永久清空“${definition.label}”` : `“${definition.label}”已经是空的`);
    await refreshStatus({ quiet: true });
  } catch (error) {
    showToast(error.message, true);
  }
}

async function copyBatchId() {
  const batchId = state.status?.batch?.batch_id || "";
  if (!batchId) {
    showToast("当前没有可复制的批次号", true);
    return;
  }
  try {
    await copyText(batchId);
    showToast("批次号已复制");
  } catch (error) {
    showToast(error.message, true);
  }
}

async function copyAnalysisPrompt() {
  const startDate = byId("start-date").value;
  if (!startDate) {
    showToast("请先选择本批开始日期", true);
    return;
  }
  const planName = `发布计划-${startDate.replaceAll("-", "")}.json`;
  const paths = state.status?.paths || {};
  const workspacePath = paths.workspace || "<workspace>";
  const sourcePath = paths.source_images || joinDisplayPath(workspacePath, "待发布-素材");
  const renamedPath = paths.renamed_images || joinDisplayPath(workspacePath, "已重命名-素材");
  const projectPath = paths.project_root || "<project-root>";
  const planningRules = joinDisplayPath(projectPath, "docs/image-content-planning.md");
  const bgmPath = joinDisplayPath(workspacePath, "BGM歌曲.txt");
  const planPath = joinDisplayPath(workspacePath, planName);
  const prompt = `请使用 douyin-image-publish-automation 处理 ${sourcePath} 中尚未处理的图片。本批开始日期为 ${startDate}。开始前必须完整读取并遵循 ${planningRules}；如存在 ${bgmPath}，也必须读取并参考。请先完成整批图片分析，再统一排序、安排上午/下午/傍晚/晚上时段，并为每张图片生成不超过15字且句式有变化的标题、严格3个话题、不重复BGM和明确发布时间。把结构化计划保存为 ${planPath}，不要增加长内容描述、推荐理由或关键词；随后在项目根目录运行 npm.cmd run validate:content-plan -- "${planPath}" --start-date ${startDate}。计划校验通过后，保持原图不变，只把严格七字段重命名副本写入 ${renamedPath}；更新发布配置.json 的 start_date、batch_id 和 published_through，并运行现有完整批次校验。不要执行真实发布。`;
  try {
    await navigator.clipboard.writeText(prompt);
    byId("copy-hint").textContent = "已复制。回到 Codex 粘贴并发送即可开始图片分析。";
    showToast("分析指令已复制");
  } catch {
    byId("copy-hint").textContent = prompt;
    showToast("无法访问剪贴板，已在页面显示指令", true);
  }
}

document.querySelectorAll("[data-mode]").forEach((button) => {
  button.addEventListener("click", () => setMode(button.dataset.mode));
});
document.querySelectorAll("[data-job]").forEach((button) => {
  button.addEventListener("click", () => startJob(button.dataset.job));
});
document.querySelectorAll("[data-folder]").forEach((button) => {
  button.addEventListener("click", () => openFolder(button.dataset.folder));
});
document.querySelectorAll("[data-clear-folder]").forEach((button) => {
  button.addEventListener("click", () => clearFolder(button.dataset.clearFolder));
});

byId("continue-direct").addEventListener("click", () => setMode("direct"));
byId("refresh-button").addEventListener("click", () => refreshStatus());
byId("copy-batch-id").addEventListener("click", copyBatchId);
byId("copy-analysis-prompt").addEventListener("click", copyAnalysisPrompt);
byId("publish-button").addEventListener("click", () => startJob("publish"));
byId("publish-batch-id").addEventListener("input", updatePublishGate);
byId("publish-confirm").addEventListener("change", updatePublishGate);

refreshStatus();
