---
name: fentiao-video-remake
description: |
  给一条参考视频（默认抖音实拍短片），把它逆向到坐标级规格再复刻出同结构新片：镜头/包装/声音两轮取证， 版式像素实测，切点节奏与声音配方提炼，无水印素材提取，分镜驱动的本地出片，最后并排逐项验收。 输入是参考片链接或本地文件；输出是成片 mp4 + 规格表 + 对比图。只做结构复刻，不做全新创意策划。
metadata:
  cangjie.generated-by: cangjie-tools v2.5.0
  cangjie.variant: single
  cangjie.bundle-id: bundle.fentiao-video-remake
  cangjie.capability-count: 8
  cangjie.entrypoint-count: 1
---
# 抖音「钢材分条」参考片的逆向与复刻方法论 — 全书能力入口

## 触发与不触发

**适用**：与本书能力域相关的咨询与任务（见下方路由表的意图列）。
**不适用**：
- 全新创意脚本、账号运营与跨平台发布（本能力只负责参考片的结构复刻）
- 多租户 SaaS 化与付费再分发（hypit 许可证附加条件边界）
- 依赖云端生成模型的镜头生成（无 capsule-cinema/seedance 账号时不启用该分支）

## 核心原则（常驻速览，概览类问题读到这里即可回答）

1. 复刻复制的是结构与节奏（切点分布、版式坐标、声音配方），不是画面本身
2. 两轮取证：工具拆解回答"是什么"，像素实测回答"怎么摆"，每个结论带置信度与复核路径
3. 素材先行且干净：无水印原片 + 烧录字预处理，问题在组装前暴露而不是验收时
4. 出片走可复跑的本地流水线：分镜 JSON → 模板渲染 → 校验 → 渲染 → 导出
5. 验收靠并排逐项对坐标/色值/字高/画幅，不凭"看起来差不多"放行

## 能力路由（先读本表，按意图加载 1 张能力卡）

| 用户意图 | 先读 | 补读/备注 |
|---|---|---|
| 拆解这条参考视频是怎么做的；判断参考片是实拍还是 AI/代码渲染；给参考片逆向出可复刻的报告 | references/capabilities/reference-breakdown-two-round.md | references/capabilities/layout-pixel-spec.md、references/capabilities/rhythm-structure-extract.md |
| 量出参考片标题字幕的坐标字号颜色；把参考片版式换算到自己的分辨率；版式规格表 layout spec | references/capabilities/layout-pixel-spec.md | references/capabilities/reference-breakdown-two-round.md、references/capabilities/remake-acceptance-diff.md |
| 这条片的剪辑节奏怎么复刻；切点分布反推剪辑做法；节奏结构归类 | references/capabilities/rhythm-structure-extract.md | references/capabilities/reference-breakdown-two-round.md、references/capabilities/storyboard-local-pipeline.md |
| 参考片的配乐音效怎么复刻；BGM 是哪首/多少 BPM 怎么找；音效卡点怎么摆 | references/capabilities/sound-recipe-replicate.md | references/capabilities/storyboard-local-pipeline.md、references/capabilities/reference-breakdown-two-round.md |
| 下载抖音视频无水印原片；抖音链接转 mp4 去水印；素材带字怎么处理 | references/capabilities/douyin-clean-asset-extract.md | references/capabilities/storyboard-local-pipeline.md |
| 按分镜把参考片结构出成新片；输入一个主题批量出抖音风格视频；本地渲染流水线出片 | references/capabilities/storyboard-local-pipeline.md | references/capabilities/layout-pixel-spec.md、references/capabilities/rhythm-structure-extract.md、references/capabilities/sound-recipe-replicate.md、references/capabilities/remake-acceptance-diff.md |
| 成片和参考片对齐验收；复刻得像不像怎么检查；出片质量对比 | references/capabilities/remake-acceptance-diff.md | references/capabilities/layout-pixel-spec.md、references/capabilities/storyboard-local-pipeline.md |
| 参考片的实拍部分怎么重拍；布光机位器材清单怎么来；measure to shoot plan | references/capabilities/measure-to-shoot-plan.md | references/capabilities/reference-breakdown-two-round.md、references/capabilities/douyin-clean-asset-extract.md |

**非能力类查询**：
- 书名/作者/章节/整书概览 → references/overview.md
- 术语解释 → references/glossary.md
- 决策规则速查（不需要原文依据时） → references/cheatsheet.md
- 完整意图与关键词索引（本表未覆盖的意图先查这里） → references/capability-index.md

## 加载规则

- 每次任务先读本文件，再按路由表加载 **1** 张能力卡；任务明确跨域时最多加载 2 张。
- 概览/书名类问题不加载能力卡，用「核心原则」与 overview.md 回答。
- 路由表与 capability-index.md 都无法命中的意图，明确告知超出本书范围，不要硬套。

## 边界与判停

- 参考片无法拆解（接口/工具失效）或关键结论全部低置信且无复核路径时停止并如实报告
- 缺本地渲染环境（ffmpeg / 浏览器 / hypit doctor 非 0 diagnostics）不开工
- 验收中画幅不符或坐标/色值/字高任一项偏差超阈值时打回重做，不放行
