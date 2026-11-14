# PON 生产看板 · 数据采集页

生产看板的首页已从“打开即图表”改造为**带采集清单的数据采集页**：运营人员可以逐项看到每个数据来源是否采齐、哪一路出了问题，以及整轮数据是否可信。

页面为纯静态实现（`index.html`，无框架、无构建、无远端依赖），样例清单与静态数据全部位于同目录的 `samples/` 下，可直接双击打开复现。

## 采集规则

页面按清单顺序使用浏览器 `fetch` **逐项串行抓取**，并对每一项执行：

1. **独立超时**：每项使用清单配置的 `timeoutMs`（缺省取清单级 `defaultTimeoutMs`），通过 `AbortController` 单独中止，不影响其他项。
2. **64 KiB 体积闸**：以流式方式读取响应体，累计字节数一旦超过 `64 × 1024` 立即中止并判该项失败，避免下载超大响应。
3. **JSON 解析与字段提取**：响应必须是合法 JSON，并按清单声明的字段路径（支持 `a.b.c`）取数；解析失败或缺少约定字段均判失败并给出原因。
4. **结局分类**：每项最终为 `成功` / `失败` / `跳过`（未配置请求地址即跳过），并逐项展示失败原因与取到的字段值。

## 可信度逻辑

- 顶部展示**已完成数 / 总数**，以及成功、失败、跳过计数和进度条。
- **必需项失败**（含超时、超 64 KiB、非 JSON、缺字段、地址不可达、HTTP 错误）：顶部出现醒目的红色横幅，逐行列出原因，并把**整轮标记为“不可信”**。
- **非必需项失败**：只记录原因、黄色/绿色提示，不阻断后续项，也不影响整轮可信度。
- 清单为空时落到明确**空态**；清单本身加载失败或全部地址不可达时落到明确**失败态**；任何路径都不会停留在加载中。
- **“重新采集”按钮**：点击后清空上一轮全部结果与横幅，再从第一项重新跑一遍。

## 目录结构

```
index.html                         采集页（清单、抓取、判定、渲染全部在内）
samples/
  manifest-all-success.json        情形一：全部成功
  manifest-optional-fail.json      情形二：单项非必需失败（超 64KiB + 缺文件）
  manifest-all-fail.json           情形三：全部失败（含一个跳过项）
  manifest-empty.json              情形四：空清单（空态）
  sample-registry.js               file:// 下的静态回退数据（由工具自动生成）
  data/
    line-status.json               产线状态（必需）
    output.json                    产量（必需）
    quality.json                   质量（必需）
    equipment.json                 设备 OEE（非必需）
    equipment-oversize.json        290 KiB，刻意超过 64 KiB 的失败样例
tools/gen_registry.py              由 JSON 重新生成 sample-registry.js
tests/run-tests.mjs                纯 Node 行为测试（DOM/fetch 打桩）
tests/http-integration.mjs         针对真实静态服务器的原生 fetch 集成测试
```

清单（manifest）每项字段：

| 字段 | 含义 |
| --- | --- |
| `source` | 来源名称（页面展示） |
| `url` | 请求地址（相对地址按清单所在目录解析） |
| `required` | 是否必需（`true`/`false`） |
| `timeoutMs` | 该项单独的超时（毫秒） |
| `fields[].path` / `fields[].label` | 要取的 JSON 字段路径与展示名 |

## 本地复现三种（外加空态共四种）情形

### 方式一：直接双击打开（file://）

直接用浏览器打开 `index.html`，用顶部下拉框切换情形，也可用 URL 参数：

```
index.html?scenario=manifest-all-success.json   # 全部成功
index.html?scenario=manifest-optional-fail.json # 单项非必需失败
index.html?scenario=manifest-all-fail.json      # 全部失败
index.html?scenario=manifest-empty.json         # 空清单空态
```

> Chromium 系浏览器默认禁止 `file://` 页面用 `fetch` 读取本地文件。页面会**先照常调用 `fetch`**，被拦截后回退到同目录内置的 `samples/sample-registry.js` 静态数据（体积闸、字段校验等判定逻辑完全一致），因此三种情形无需任何服务即可离线复现。Firefox 对本地 `fetch` 限制较宽松，会直接走真实 `fetch`。

### 方式二：本地静态服务器（真实 fetch 路径）

```bash
python -m http.server 8000
# 浏览器访问 http://127.0.0.1:8000/index.html
```

此模式下所有请求都是真实 `fetch`：小文件成功、`equipment-oversize.json` 在 64 KiB 处被流式中止、缺失文件返回 404 并记录原因。

## 测试

```bash
node tests/run-tests.mjs          # 61 项行为断言（含超时/HTTP 错误/坏 JSON/缺字段/重跑/file:// 回退）
TEST_BASE=http://127.0.0.1:8000/ node tests/http-integration.mjs
python -I tools/gen_registry.py   # 改动 data/*.json 后重新生成回退注册表
```
