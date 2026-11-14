# CDP 兜底通道

> 什么时候读这个文件：Extension Relay 通道**整体**走不通（扩展未连、Service Worker 挂掉、eval 持续失败），需要回退 CDP HTTP 继续操作时。默认永远优先 Extension Relay。

两个通道操作同一个真实 Chrome，能力等价（eval / aria-tree / click / type / screenshot 都有）。CDP 的 eval 走 DevTools 协议由 Chrome native 执行，不受页面 CSP 限制。

## 启动

CDP 通道需单独启动：`webclaw3 cdp-start`（监听 `:3456`，底层 Chrome `--remote-debugging-port=9222`）。只用 Extension Relay 时无需启动它。

## tab ID 映射

两个 transport 共享同一 Chrome 实例，但 tab ID 体系不同：

- Extension Relay（`:3459`）：tabId 是**整数**（如 `1884007990`）
- CDP HTTP（`:3456`）：targetId 是 **hex 字符串**（如 `CE8ED71660D084A1A81858243C26BC91`）
- **映射方法**：Extension 拿 tab → 取 URL → 调 `:3456/targets` 按 URL 匹配找 targetId
- 同一 tab 的 targetId 在其存活期内不变，可懒加载缓存 `tabId → targetId`

## API

```bash
# 探测 CDP 是否可用
curl -s http://127.0.0.1:3456/health          # → {"status":"ok","connected":true,"chromePort":9222}

# 按 URL 匹配 targetId
curl -s http://127.0.0.1:3456/targets | jq '.[] | select(.url=="https://example.com/") | {targetId, url, title}'

# eval（POST，body 是原始 JS 表达式字符串，不能包成 JSON；成功返回 {"value":...}）
printf '%s' 'document.querySelectorAll("a").length' > /tmp/eval.js
curl -s -X POST "http://127.0.0.1:3456/eval?target=TARGET_ID" --data-binary @/tmp/eval.js

# aria-tree / 语义点击 / 语义输入 / 截图
curl -s "http://127.0.0.1:3456/aria-tree?target=TARGET_ID"
curl -s -X POST "http://127.0.0.1:3456/click-aria?target=TARGET_ID" -d '{"role":"tab","name":"下载热榜"}'
curl -s -X POST "http://127.0.0.1:3456/type-aria?target=TARGET_ID" -d '{"role":"textbox","name":"搜索","text":"关键词"}'
curl -s "http://127.0.0.1:3456/screenshot?target=TARGET_ID"
```

返回值字段名与 Extension 不同：Extension `{result} | {error}`，CDP `{value} | {error}`。

## 批量采集 /collect

一次请求跑一组 URL：代理对每个 URL 用与 `/new` 相同的方式开后台 tab、等待加载完成后执行表达式、采完即关闭该 tab。单个 URL 失败/超时/表达式抛异常只记入对应项，不中断其余 URL；返回项顺序与输入一致。

```bash
curl -s -X POST "http://127.0.0.1:3456/collect?logFile=<声明的值>" \
  -H 'content-type: application/json' \
  -d '{"urls":["data:text/html,<title>a</title>","http://127.0.0.1:8899/page/1"],
       "expression":"JSON.stringify({title:document.title,href:location.href})",
       "concurrency":2,"timeoutMs":30000}'
# → {"items":[{"url":"...","status":"ok","value":"...","duration_ms":312},
#             {"url":"...","status":"error","error":"导航失败: ERR_CONNECTION_REFUSED","duration_ms":50}]}
```

- 请求体：`urls`（非空字符串数组）、`expression`（非空 JS 表达式，返回 JSON 可序列化值）、可选 `concurrency`（正整数，默认 1，同时在采的页面数不超过该值）、可选 `timeoutMs`（单页整体上限，正整数，默认沿用 CDP 命令超时 30000ms）。
- 每项含 `url`、`status`（`ok`/`error`/`timeout`）、`value`（成功）或 `error`（失败/超时）、`duration_ms`。
- 参数非法（`urls` 不是数组/为空、`expression` 缺失、`concurrency`/`timeoutMs` 不是正整数等）返回 400，且在连接 Chrome / 创建任何 tab 之前拦截。
- 带 `logFile` 时，整批结束写一条 `op=cdp.collect` 的 NDJSON，`params.total` 为总数，`result.counts` 含 `ok/error/timeout` 各自计数。


## 回退判定（重要）

只有 Extension 通道整体不可用/eval 持续失败才回退 CDP；单次 `SyntaxError`、`tab not found` 等属脚本问题，不回退。摸清页面结构后切回 Relay——CDP 是临时探查通道，不要进入沉淀的脚本代码。

## operation_log

上下文声明了 `WC3_OPERATION_LOG` 时，CDP 调用同样要带 logFile（URL query）：

```bash
curl -s "http://127.0.0.1:3456/aria-tree?target=TARGET_ID&logFile=<声明的值>"
```
