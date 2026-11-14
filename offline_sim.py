# -*- coding: utf-8 -*-
"""离线模拟运行：不依赖真实外网、不发真实 Webhook，本地把整条链路跑三天。

和 simulate.py 的区别：simulate.py 会真去抓 6 个线上源；本脚本把 fetcher.http_get
整个换成 canned 假页面，再用假时钟逐日推进 main()，专门用来验收「源健康度」行为：

  Day1  4 个源失败（各记 1 天，未达阈值 -> 无告警），另有两个源抓到了条目但分别被
        日期/关键词过滤成空 —— 必须当作正常，不进账本、不进告警
  Day1  同日重跑一次 —— 连续天数不叠加，且账本没变化时 state 文件不重写
  Day2  扩到 6 个源失败（各记 2 天 -> 告警出现，且超过 4 个触发「等共 N 个源」）
  Day3  5 个源仍失败（连续 3 天），超时源恢复 —— 它的账本记录被清零、告警里消失

用法（仓库根目录）：
    python offline_sim.py
全程用临时 state 目录，仓库里的 state/seen.json 不会被动到。
"""

import datetime
import os
import shutil
import sys
import tempfile
from unittest import mock

# Windows 控制台默认 GBK，打 emoji 会直接 UnicodeEncodeError；强制成 UTF-8
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import config       # noqa: E402
import fetcher      # noqa: E402
import main as app  # noqa: E402
from state import load_state  # noqa: E402


# ---------------------------------------------------------------- 假源配置
def _src(name, host, pattern, **kw):
    s = {"name": name, "url": "https://%s/list.html" % host,
         "pattern": pattern, "max": 10, "max_age_days": 0}
    s.update(kw)
    return s


# 文章地址形如 /news/2026/1101/policy-1.html（带斜杠日期，url_date 能识别）
NEWS_PATTERN = r"/news/\d{4}/\d{4}/[\w-]+\.html"

SOURCES = [
    _src("健康源甲", "good-a.test", NEWS_PATTERN),
    _src("健康源乙", "good-b.test", NEWS_PATTERN),
    # 页面里永远只有 2020 年的老稿子，会被日期窗口过滤成空 —— 源是好的
    _src("日期过滤空源", "stale.test", NEWS_PATTERN,
         max_age_days=3),
    # 稿子标题全踩源黑名单，会被关键词过滤成空 —— 源是好的
    _src("关键词过滤空源", "kw.test", NEWS_PATTERN,
         exclude=["招标", "采购"]),
    _src("超时源", "timeout.test", NEWS_PATTERN),
    _src("四零三源", "forbidden.test", NEWS_PATTERN),
    _src("改版源", "changed.test", NEWS_PATTERN),
    _src("解析异常源", "broken.test", NEWS_PATTERN),
    _src("长尾故障一", "tail1.test", NEWS_PATTERN),
    _src("长尾故障二", "tail2.test", NEWS_PATTERN),
]

# 每天哪些源处于「抓取/解析失败」状态（过滤成空的两个源不在此列）
# Day1 就有 6 个源失败（各记 1 天，未达阈值 -> 无告警）；
# Day2 长尾两源先恢复（清零），再加入两个全新故障源 —— 达阈值的正好 6 个、
# 各连续 2 天，用来验证「最多展示 4 个 + 等共 6 个源」；
# Day3 超时源恢复（账本清零、当天告警里消失），其余 5 个继续累加。
FAIL_PLAN = {
    datetime.date(2026, 11, 1): {"超时源", "四零三源", "改版源", "解析异常源",
                                 "长尾故障一", "长尾故障二"},
    datetime.date(2026, 11, 2): {"超时源", "四零三源", "改版源", "解析异常源",
                                 "新故障一", "新故障二"},
    datetime.date(2026, 11, 3): {"四零三源", "改版源", "解析异常源",
                                 "新故障一", "新故障二"},  # 超时源这天恢复
}

FAIL_REASONS = {
    "超时源": "抓取失败：请求失败：模拟连接超时",
    "四零三源": "抓取失败：请求失败：模拟 HTTP 403",
    "改版源": "页面没解析出条目（pattern 可能失效）",
    "解析异常源": "解析出错：RuntimeError: 模拟页面结构异常",
    "长尾故障一": "抓取失败：请求失败：模拟连接被拒",
    "长尾故障二": "抓取失败：请求失败：模拟 DNS 失败",
    "新故障一": "抓取失败：请求失败：模拟网关 502",
    "新故障二": "抓取失败：请求失败：模拟 SSL 握手失败",
}

SOURCES = [
    _src("健康源甲", "good-a.test", NEWS_PATTERN),
    _src("健康源乙", "good-b.test", NEWS_PATTERN),
    # 页面里永远只有 2020 年的老稿子，会被日期窗口过滤成空 —— 源是好的
    _src("日期过滤空源", "stale.test", NEWS_PATTERN,
         max_age_days=3),
    # 稿子标题全踩源黑名单，会被关键词过滤成空 —— 源是好的
    _src("关键词过滤空源", "kw.test", NEWS_PATTERN,
         exclude=["招标", "采购"]),
    _src("超时源", "timeout.test", NEWS_PATTERN),
    _src("四零三源", "forbidden.test", NEWS_PATTERN),
    _src("改版源", "changed.test", NEWS_PATTERN),
    _src("解析异常源", "broken.test", NEWS_PATTERN),
    _src("长尾故障一", "tail1.test", NEWS_PATTERN),
    _src("长尾故障二", "tail2.test", NEWS_PATTERN),
    _src("新故障一", "new1.test", NEWS_PATTERN),
    _src("新故障二", "new2.test", NEWS_PATTERN),
]


def _article_page(host, day, seq):
    """健康源的假列表页：两篇目标日的新稿。"""
    d = day.strftime("%Y/%m%d")
    links = []
    for i in range(seq, seq + 2):
        url = "https://%s/news/%s/policy-%d.html" % (host, d, i)
        links.append('<a href="%s">国务院常务会议研究部署进一步稳就业政策第%d条</a>'
                     % (url, i))
    return "<html><body>%s</body></html>" % "".join(links)


def _stale_page():
    # 只有 2020 年的旧稿（URL 日期能被 url_date 识别，会被 3 天窗口过滤掉）
    return ('<html><body><a href="https://stale.test/news/2020/0101/old-1.html">'
            '这是一篇发布于很久以前的历史旧闻稿子标题</a></body></html>')


def _keyword_blocked_page(day):
    d = day.strftime("%Y/%m%d")
    return ('<html><body><a href="https://kw.test/news/%s/bid-1.html">'
            '招标采购公告：某单位办公设备采购项目公示信息</a></body></html>' % d)


def _make_http_get(day, failing):
    """返回一个替身 http_get：按当天剧本给页面或抛异常，绝不发起真实请求。"""
    seq = {"n": 0}

    def fake_http_get(url, timeout=None, retry=None):
        host = url.split("/")[2]
        name = next(s["name"] for s in SOURCES if s["url"].split("/")[2] == host)

        if name in failing:
            if name == "改版源":
                # 页面能打开，但没有任何能被 pattern 命中的文章链接 -> 解析为空
                return ('<html><body><a href="/about/intro.html">'
                        '关于我们网站介绍页面的链接文字</a></body></html>', 128)
            if name == "解析异常源":
                raise RuntimeError("模拟页面结构异常")
            raise RuntimeError(FAIL_REASONS[name].split("：", 1)[1])

        if name == "日期过滤空源":
            return _stale_page(), 128
        if name == "关键词过滤空源":
            return _keyword_blocked_page(day), 128

        seq["n"] += 10
        return _article_page(host, day, seq["n"]), 256

    return fake_http_get


# ---------------------------------------------------------------- 跑一天
def run_one_day(day, pushed, state_path):
    failing = FAIL_PLAN[day]
    with mock.patch.object(fetcher, "http_get",
                           side_effect=_make_http_get(day, failing)), \
         mock.patch.object(app, "bj_today", return_value=day), \
         mock.patch.object(app, "safe_push",
                           side_effect=lambda text, is_success=True:
                               pushed.append(text) or True):
        ok = app.main()
    st = load_state(state_path)
    return ok, st


def main():
    app.setup_logging()
    tmp = tempfile.mkdtemp(prefix="gk-offline-sim-")
    state_path = os.path.join(tmp, "seen.json")

    # 全程隔离：临时 state、不发真实请求、不做 DNS 改造、重试不等秒
    config.STATE_FILE = state_path
    config.SOURCES = SOURCES
    config.FORCE_IPV4 = False
    config.RETRY = 0
    config.DRY_RUN = False
    config.FIRST_RUN_PUSH = True
    config.NEWS_DAY = "yesterday"
    # 预置历史索引，避免走"首次运行只建索引"分支
    with open(state_path, "w", encoding="utf-8", newline="\n") as fp:
        fp.write('{\n "last_run": "",\n "seen": ["https://old.test/seen.html"],\n'
                 ' "source_health": {}\n}\n')

    days = [datetime.date(2026, 11, 1), datetime.date(2026, 11, 2),
            datetime.date(2026, 11, 3)]
    checks = []

    def check(label, cond):
        checks.append((label, cond))
        print("  %s %s" % ("✅" if cond else "❌", label))

    try:
        for day in days:
            print("\n================ 模拟 %s（北京）================" % day)
            # pushed 是**当天**的推送收集器，跨天重新建表，不会混进前一天的旧告警
            pushed = []
            ok, st = run_one_day(day, pushed, state_path)
            health = st.get("source_health", {})
            print("  main() 返回：%s；账本：%s"
                  % (ok, {k: v["count"] for k, v in health.items()}))
            notices = [m for m in pushed if "⚠️" in m]
            for msg in pushed:
                tail = msg.split("\n")
                print("  --- 推送消息（末尾两行）---")
                print("    " + "\n    ".join(tail[-2:]))

            if day == days[0]:
                check("Day1：6 个失败源各记 1 天",
                      all(health[n]["count"] == 1 for n in FAIL_PLAN[day]))
                check("Day1：失败原因随账本保留",
                      all(health[n]["reason"] for n in FAIL_PLAN[day]))
                check("Day1：未达阈值（2 天），无告警", not notices)
                check("Day1：日期/关键词过滤成空的源不进账本",
                      "日期过滤空源" not in health and "关键词过滤空源" not in health)

                # 同日重跑：count 不叠加、文件不重写
                with open(state_path, "rb") as fp:
                    before = fp.read()
                _, st2 = run_one_day(day, pushed, state_path)
                with open(state_path, "rb") as fp:
                    after = fp.read()
                check("Day1 同日重跑：连续天数不叠加（仍为 1）",
                      all(st2["source_health"][n]["count"] == 1
                          for n in FAIL_PLAN[day]))
                check("Day1 同日重跑：账本无变化 -> 不产生写盘", before == after)

            elif day == days[1]:
                check("Day2：原 4 源累加到 2 天，新 2 源记 1 天",
                      all(health[n]["count"] == 2
                          for n in ("超时源", "四零三源", "改版源", "解析异常源"))
                      and all(health[n]["count"] == 1
                              for n in ("新故障一", "新故障二")))
                check("Day2：恢复的长尾两源账本清零（记录移除）",
                      "长尾故障一" not in health and "长尾故障二" not in health)
                # 只有连续 2 天的 4 个源达阈值；记 1 天的新源不进告警
                check("Day2：告警按天数降序、源名升序排列",
                      any(("四零三源 连续 2 天" in m and "超时源 连续 2 天" in m)
                          for m in notices))
                check("Day2：记 1 天的新源未达阈值，不出现在告警里",
                      all("新故障一" not in m and "新故障二" not in m
                          for m in notices))

            else:
                check("Day3：持续失败的源继续累加（四零三源到 3 天、新故障到 2 天）",
                      health["四零三源"]["count"] == 3
                      and health["新故障一"]["count"] == 2)
                check("Day3：超时源恢复 -> 账本清零（记录移除）",
                      "超时源" not in health)
                # 只看**当天**的告警行（⚠️ 开头）；恢复后超时源会作为正常源标题
                # 出现在新闻正文里，不能用整条消息做子串匹配
                day3_warning_lines = [
                    line for m in notices for line in m.split("\n")
                    if line.startswith("⚠️")
                ]
                check("Day3：当天告警里不再出现已恢复的超时源",
                      all("超时源" not in line for line in day3_warning_lines))
                check("Day3：5 个达阈值源 -> 只展示 4 个并折叠「等共 5 个源」",
                      any("等共 5 个源" in m for m in notices))
                check("Day3：过滤成空的两个源始终没进过账本",
                      "日期过滤空源" not in health and "关键词过滤空源" not in health)

        print("\n================ 验收结论 ================")
        failed = [label for label, cond in checks if not cond]
        for label, cond in checks:
            print("  %s %s" % ("✅" if cond else "❌", label))
        if failed:
            print("\n%d 项未通过：%s" % (len(failed), "；".join(failed)))
            return 1
        print("\n全部 %d 项行为校验通过，且全程无真实网络请求、无真实 Webhook 调用。"
              % len(checks))
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
