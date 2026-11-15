---
name: dual-agent-self-evolve
description: |
  全自动双 Agent 自进化闭环：执行 Agent（Actor）专注推进任务步骤，观察 Agent（Observer）旁路专抓
  报错 / 卡顿 / 拦截，两边只靠 NDJSON 遥测与快照通信、零共享上下文；事故经诊断后自动沉淀规则、
  补强代码（带备份+语法自检的最小补丁）、收拢门禁（带样本自测），下一轮起跑前先跑门禁，
  旧坑的门禁能横向拦住新任务的同类错误。未知坑走 --llm 诊断通道（ask-dsh headless），
  LLM 的补丁不享有免检特权。连续 2 轮无进化即停机，三态退出码（0 验过 / 1 有问题 / 2 没验成）。
  输入：一个符合任务契约的 evolve/tasks/*.js；输出：跑通的任务 + 规则台账 + 门禁台账 + 事故台账。
  触发场景：脚本反复踩同一个坑、自动化步骤卡死没人发现、报错后靠人请示才能继续、
  想让犯错经验自动进规则库和门禁、想知道某个任务有没有卡死、要给一批脚本收拢强制检查、
  「自进化闭环」「双 Agent」「Actor Observer」「遥测」「卡顿杀进程」「门禁」「沉淀规则」。
  关键词：自进化 / 双 Agent / 闭环 / Actor / Observer / 遥测 / 快照 / 卡顿 / stall /
  门禁 / gates / 沉淀规则 / 补强代码 / 事故诊断 / UNKNOWN / LLM 诊断 / conductor
metadata:
  author: achun
  version: "1.0.0"
  license: MIT
---

# dual-agent-self-evolve —— 全自动双 Agent 自进化闭环

> **一句话定义**：一个 Agent 踩坑，系统自己长出防再踩的规矩 ——
> Actor 只管跑，Observer 只管看，诊断落到规则/代码/门禁三处，下一轮自动生效。
>
> 解决的问题：**单线程独角戏**——同一个 Agent 既当执行者又当裁判，自己卡住、自己重试、
> 卡死就断在半路向人请示，犯错经验不沉淀。**没有闭环，就没有进化。**

完整架构与实测记录见 [`evolve/README.md`](../../evolve/README.md)。本文件是 skill 入口。

---

## 一、什么时候用 / 什么时候别用

### ✅ 用

- 同一个坑反复踩（BOM、残留锁、裸 JSON.parse……），想要**踩一次就永久拦住**
- 自动化步骤会卡死，但**没人知道它卡了**（要旁路盯着、超时杀进程、留快照）
- 报错后要**停下来等人请示**，想改成「诊断 → 自动进化 → 自动复跑」
- 想给一批脚本收拢**强制门禁**（起跑前拦，而不是事后发现）
- 未知错误想先走 **LLM 诊断**再决定怎么修（且修法要过校验）

### ❌ 别用

- 一次性脚本，跑完就扔（建闭环本身比跑一次更贵）
- 事故会**污染线上数据**的场景 —— 本闭环的补丁是自动的，先在 `evolve/tasks/` 沙盒里验
- 需要人工拍板才能动的变更（闭环只做**可校验的最小补丁**，不替人做决策）

---

## 二、架构（谁都不许越界）

| 角色 | 文件 | 职责 | 明确不许做 |
|---|---|---|---|
| **Actor 执行者** | `evolve/actor.js` | 推进步骤 + 发遥测；重试策略全交给 `lib/err-class`（E5/E6 恰好 1 次、E1/E3 停手、E8 不重试留证据） | 不知道 Observer 存在；不判自己对错 |
| **Observer 观察者** | `evolve/observer.js` | 旁路专抓**报错 / 卡顿 / 拦截**；卡顿 = 遥测 mtime 冻结超阈值 → 快照 → 杀 Actor | 不替 Actor 重试；不改代码；只出 `diagnosis.json` |
| **Conductor 调度** | `evolve/conductor.js` | 每轮四拍：门禁 → 双 Agent 并排跑 → 读诊断 → 进化 → 下一轮 | `unaudited`（没验成）立即停机，绝不往下演 |
| **Evolve 进化** | `evolve/lib/evolve.js` | 诊断 → 规则 / 补丁 / 门禁 | find 非恰好 1 次拒改；语法不过回滚；连续 2 轮无进化停机 |

数据流唯一通道：`runs/<轮>/telemetry.ndjson`（单写者 NDJSON）+ 快照 JSON，两边零共享上下文。

## 三、流程（一条命令）

```powershell
# 任务契约：evolve/tasks/<名字>.js 导出 { name, steps:[{name, run: async(ctx)=>产物}] }
node evolve/conductor.js --task evolve/tasks/pilot-bom.js            # 报错型
node evolve/conductor.js --task evolve/tasks/pilot-lock.js --stall-ms 4000   # 卡顿型
node evolve/conductor.js --task evolve/tasks/pilot-intercept.js      # 拦截型（旧门禁拦新任务）
node evolve/conductor.js --task evolve/tasks/pilot-unknown.js --llm  # 未知型（LLM 诊断）
```

退出码三态（工程纪律一，绝不混）：`0` 验过没问题 / `1` 验过有问题 / `2` **没验成**（带自愈命令）。

## 四、进化的三道闸（LLM 也没有免检特权）

1. **模式库优先** `evolve/lib/patterns.js`：已踩实的坑直接给修法；匹配在**遮蔽注释后**的源码上做
   （`maskNonCode`）—— 注释里的示例不算现场、不许当替换目标。
2. **LLM 诊断通道** `evolve/lib/llm.js`（`--llm`）：模式库没接住 → `ask-dsh.ps1` headless 诊断，
   回结构化 JSON（rootCause / rule / patchSteps / gate）。
3. **补丁三闸** `evolve/lib/evolve.js`：find 全文恰好 1 次且落在可执行代码上 → `vm.Script` 语法自检
   → 不过就用 `.bak` 回滚。规则/门禁按 id 幂等。

门禁自身三道：**样本自测**（1 真 1 假，拦不对不上岗）· **target 必须指到真实文件**（指不到拒收，
失明的门禁比没有更危险）· **正则无效按违规喊出来**。

## 五、停机纪律

| 触发 | 行为 |
|---|---|
| 连续 2 轮 `applied` 为空 | 判「未进化」停机（不假装在进化） |
| 轮次到 `--rounds` 上限 | 停机，打印每轮 verdict |
| verdict = `unaudited` | 立即停机，退出码 2，带自愈命令 |

## 六、实测记录（2026-11-15，四试点从零各两轮收敛，退出码全 0）

| 试点 | 事故形态 | 第 1 轮进化 | 第 2 轮 |
|---|---|---|---|
| pilot-bom | 报错 E8（BOM 撞 JSON.parse） | 规则+补丁(2步)+门禁 | 门禁过 + 通过 |
| pilot-lock | 卡顿（遥测冻结 4.2s → 杀 pid） | 规则+补丁(1步,老化偷锁) | 门禁过 + 通过 |
| pilot-intercept | 拦截（pilot-1 的门禁起跑前拦下） | 补丁(2步)，规则/门禁幂等跳过 | 门禁过 + 通过 |
| pilot-unknown | 未知 E8 → `--llm` | LLM 规则+补丁(1步) | 门禁过 + 通过 |

闭环自己踩出来并修掉的三个坑（进化的证据）：**补丁命中注释** → 引入 `maskNonCode`；
**门禁扫注释** → 门禁扫描同走遮蔽稿；**LLM 门禁 target 指空** → `gates.add` 加「必须指到真实文件」校验。

## 七、配套文件

| 文件 | 作用 |
|---|---|
| `evolve/conductor.js` | 闭环调度器（唯一入口） |
| `evolve/actor.js` / `evolve/observer.js` | 执行 Agent / 观察 Agent |
| `evolve/lib/bus.js` | 遥测总线（NDJSON，单写者） |
| `evolve/lib/patterns.js` | 确定性模式库 + `maskNonCode` 遮蔽尺 |
| `evolve/lib/evolve.js` | 进化引擎（规则/补丁/门禁三闸） |
| `evolve/lib/llm.js` | LLM 诊断通道（ask-dsh 桥） |
| `evolve/lib/gates.js` / `rules.js` / `incidents.js` / `snapshot.js` | 门禁 / 规则 / 事故 / 快照台账 |
| `evolve/tasks/*.js` | 四个试点任务（报错/卡顿/拦截/未知） |
| `evolve/README.md` | 完整架构文档与数据流图 |
