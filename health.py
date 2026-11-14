# -*- coding: utf-8 -*-
"""源健康度账本：纯逻辑模块，不碰网络和文件，专门留着给离线测试用。

账本结构（随去重索引一起持久化在 state/seen.json 的 "source_health" 字段）：

    {源名: {"count": 连续失败天数, "reason": 最近一次失败原因, "last": "YYYY-MM-DD"}}

两条硬规则：

1. 只有「抓取失败 / 解析失败」才算失败。抓到了条目、只是被日期或关键词过滤成空，
   说明源本身是好的 —— 不计失败天数、也不进告警。这条区分在 fetcher.fetch_source
   里做：过滤成空时返回 ([], None)，根本不进 failures。
2. 同一天重复运行只算一天：last 已经是今天就不再叠加 count，只刷新原因。
"""

ALERT_THRESHOLD = 2      # 连续失败几天才写进推送告警（偶发的 403/超时不值得惊动）
MAX_ALERT_SOURCES = 4    # 告警行最多展示几个源，超出折叠成「等共 N 个源」


def update_health(health, failures, today_str):
    """一轮抓取结束后更新账本，**就地修改** health 并返回它。

    health     账本 dict（state["source_health"]）
    failures   本轮真正失败的源：{源名: 失败原因}；过滤成空的源不在里面
    today_str  本轮北京时间日期，"YYYY-MM-DD"

    - 本轮成功的源（不在 failures 里）：账本记录整个移除 —— 连续天数清零，
      账本里只保留当前还在失败的源；
    - 本轮失败的源：last 不是今天才把 count 加一（同日重跑不叠加），
      原因和最后失败日期每次都刷新（原因随账本保留，排查时不用翻日志）。
    """
    for name in list(health):
        if name not in failures:
            del health[name]

    for name, reason in failures.items():
        rec = health.get(name)
        if rec is None:
            rec = {}
            health[name] = rec
        try:
            base = int(rec.get("count", 0))
        except (TypeError, ValueError):
            base = 0
        if rec.get("last") != today_str:      # 同一天跑两次只算一天
            rec["count"] = base + 1
        rec["reason"] = reason
        rec["last"] = today_str
    return health


def failure_notice(health, threshold=ALERT_THRESHOLD):
    """把连续失败达到阈值的源拼成一行告警；一个都没有就返回空串。

    排序：连续天数从多到少；天数相同按源名升序（Unicode 码位序，结果稳定可测）。
    最多展示 MAX_ALERT_SOURCES 个，超出在末尾补「等共 N 个源」，N 是失败源总数。
    """
    broken = []
    for name, rec in (health or {}).items():
        try:
            n = int(rec.get("count", 0))
        except (TypeError, ValueError):
            n = 0
        if n >= threshold:
            broken.append((n, name))
    if not broken:
        return ""

    broken.sort(key=lambda x: (-x[0], x[1]))
    shown = "、".join(
        "%s 连续 %d 天" % (name, n)
        for n, name in broken[:MAX_ALERT_SOURCES]
    )
    more = ("" if len(broken) <= MAX_ALERT_SOURCES
            else " 等共 %d 个源" % len(broken))
    return "⚠️ 抓取异常：%s%s" % (shown, more)
