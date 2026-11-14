#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""京东商品采集系统 · 统一操作入口（main.py）

目标：降低使用门槛。用交互菜单 / 子命令串起各阶段流程，不必记忆零散命令，
也不必记忆一堆参数——所有数值参数在进入对应模块后**交互询问**（直接回车用默认）。

本文件只做"流程编排 + 友好提示 + 登录闸门"，真实的采集逻辑仍由 Scrapy 与各 scripts 负责。
注意：这不是调度器，不负责并发/定时，只是把已有命令收口到一个入口。

用法：
    python main.py                 # 进入交互菜单（推荐：每个步骤的参数会在进入时询问）
    python main.py all             # 一键完整流程（详情入库 + 兜底导入，参数用 settings.py 默认值）
    python main.py url             # 商品URL采集：录入商品链接到待爬库（product_links）
    python main.py detail          # 详情批量入库（detail_status=0）
    python main.py single          # 单商品详情采集：直接爬取并入库一个商品 URL
    python main.py retry           # 重爬失败项（detail_status=2）
    python main.py import          # 离线导入 data/ 下的 JSON
    python main.py stats           # 查看统计
    python main.py init            # 初始化分类表
    python main.py initdb          # 确保核心数据表存在
    python main.py menu            # 强制进入交互菜单

整体数据流（采集商品URL → 详情页爬取）：
    商品URL采集(菜单2) ──写入──> product_links 待爬库(detail_status=0)
                                       │
                    详情批量入库(菜单3) / 单商品详情采集(菜单8)
                                       │  DrissionPage 真浏览器 + 缓慢滚动触发懒加载
                                       ▼
                                 products 表（图片 URL + 本地路径）
                                       │
                      离线 JSON 导入(菜单4)  <-- data/{sku}/*.json
                                       ▼
                                  统计分析(菜单6)

参数策略：
    - 交互菜单模式：进入「商品URL采集 / 详情入库 / 单商品详情采集」等模块时会逐项询问，
      回车即采用提示的默认值。无需记忆任何命令行参数。
    - 「列表采集」已改为「商品URL采集」：不再自动跑分类列表，而是手动录入商品链接
      （每行一个，支持 item.jd.com/{sku}.html 形式），录入后由「详情批量入库」消费。
    - 子命令模式（如 python main.py url / python main.py single）：不询问，直接采用
      jdcrawler/settings.py 里的默认值，便于写进脚本或定时任务。
    - 需要改端口/参数时，直接改 jdcrawler/settings.py 即可（main.py 不重复暴露这些旋钮）。
    - 全局开关 --skip-login-check 仅在脚本模式有用；菜单模式下遇到登录闸门输入 q 即可跳过。
"""

import os
import re
import sys
import time
import argparse
import subprocess
import socket

# 尽量让控制台以 UTF-8 输出，避免中文/箭头符号在 GBK 终端下编码失败崩溃。
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001 - 部分环境（如老管道）无 reconfigure，忽略即可
    pass

ROOT = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable
DEFAULT_EDGE_ADDRESS = "127.0.0.1:9222"
DETAIL_LIMIT = 50  # 每轮详情入库处理上限（子命令模式默认值）

# 京东登录后才会出现的元素（用于判断登录态）
LOGGED_IN_SELECTORS = [
    "css:.nickname",
    "css:a.link-user",
    "css:.user-avatar",
    "css:img[class*='avatar']",
    "css:#shortcut .u-name",
    "css:[class*='user-info']",
]


def _run(args):
    """在根目录执行子进程，继承终端输出，返回 returncode。"""
    print("\n>>> " + " ".join(args))
    return subprocess.run(args, cwd=ROOT).returncode


def _run_script(script_rel, *extra):
    return _run([PY, os.path.join(ROOT, script_rel), *extra])


def check_edge(edge_address=DEFAULT_EDGE_ADDRESS):
    """检测浏览器调试端口是否可达，不可达时给出友好提示（不阻断流程）。"""
    host, _, port_str = edge_address.partition(":")
    port = int(port_str) if port_str.isdigit() else 9222
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(1.5)
    try:
        s.connect((host or "127.0.0.1", port))
        ok = True
    except OSError:
        ok = False
    finally:
        s.close()
    if not ok:
        print("[提醒] 未检测到浏览器调试端口 %s。详情采集需要已登录的浏览器（Chrome/Edge 等 Chromium 内核）：" % edge_address)
        print('        启动命令（二选一，端口需一致）：')
        print('        Chrome : "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=%s' % port)
        print('        Edge  : "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --remote-debugging-port=%s' % port)
    return ok


def check_login(edge_address):
    """检测京东登录态。

    通过 DrissionPage 挂接已运行的浏览器（同一调试端口，Chrome/Edge 等 Chromium 内核），
    打开 jd.com，按以下信号判断：
      1) 被重定向到 passport.jd.com / 登录页            → 未登录（可靠）
      2) 页面含未登录标志文本（"请登录"/"你好，请登录"等）→ 未登录（可靠）
      3) 页面存在登录态元素（头像/昵称/用户名）          → 已登录（可靠）
      4) 三者都没命中                                    → 保守判定未登录（宁可多一次确认，不误放行）
    返回 (logged_in: bool, message: str)。
    注意：只关闭检测用的临时标签页，绝不调用 browser.quit()，以免关掉用户正在使用的浏览器。
    """
    from DrissionPage import ChromiumPage, ChromiumOptions

    options = ChromiumOptions()
    options.set_address(edge_address)
    browser = ChromiumPage(options)
    tab = None
    try:
        tab = browser.new_tab()
        tab.get("https://www.jd.com")
        time.sleep(2.5)

        url = tab.url or ""
        # 信号1：重定向到登录页 —— 可靠判定未登录
        if "passport.jd.com" in url or ("login" in url and "jd.com" in url):
            return False, "被重定向到登录页: %s" % url

        html = tab.html or ""
        # 信号2：未登录标志文本（京东未登录时顶部导航有"你好，请登录"等入口）
        not_logged_texts = ["请登录", "你好，请登录", "登录京东", "账号登录"]
        for t in not_logged_texts:
            if t in html:
                return False, '页面含未登录标志文本 "%s"' % t

        # 信号3：登录态元素（头像/昵称/用户名）—— 只有命中才可可靠判已登录
        for sel in LOGGED_IN_SELECTORS:
            try:
                if tab.ele(sel, timeout=1.5):
                    return True, "检测到登录态元素(%s)" % sel
            except Exception:
                continue

        # 信号4：两者都没命中 —— 保守判定为未登录，避免"没检测到就当已登录"的误放行
        return False, "既未检测到登录态元素、也未发现未登录标志，保守判定为未登录"
    finally:
        if tab is not None:
            try:
                tab.close()
            except Exception:
                pass


def ensure_login(cfg):
    """登录闸门：未登录时把程序切成"等待登录"状态并阻塞，直到用户登录后继续。

    返回 None（通过闸门）；网络/浏览器异常时同样进入闸门提示，允许重试或跳过。
    """
    if getattr(cfg, "skip_login_check", False):
        print("[登录] 已跳过登录校验（--skip-login-check）")
        return

    edge_address = DEFAULT_EDGE_ADDRESS
    check_edge(edge_address)

    while True:
        try:
            ok, msg = check_login(edge_address)
        except Exception as e:  # noqa: BLE001 - 检测失败不应让程序崩溃，转为闸门提示
            ok, msg = False, "检测异常: %s" % e

        if ok:
            print("[登录] 已检测到京东登录态 ✔ %s" % msg)
            return

        # 未登录 → 程序性质切换为"等待登录"
        print("\n############ 等待登录 ############")
        print("# 当前未检测到京东登录态，采集任务已暂停。")
        print("# 请在已打开的浏览器（Chrome/Edge 等 Chromium 内核）中登录京东 (https://www.jd.com)，")
        print("# 登录完成后按回车重新检测，程序将自动进入下一步。")
        print("# 输入 q 可跳过（不推荐：未登录状态采集极易触发验证码/限流）。")
        print("##################################")
        try:
            ans = input("> ").strip().lower()
        except EOFError:
            ans = "q"
        if ans == "q":
            print("[登录] 已跳过校验，继续（未登录状态下采集风险自负）。")
            return
        # 否则重新检测


def count_pending():
    """查询 product_links 中待爬（detail_status=0）数量；失败返回 None。"""
    try:
        sys.path.insert(0, os.path.join(ROOT, "scripts"))
        import db_connection  # noqa: imported lazily，避免无 DB 时影响其他步骤
        db = db_connection.DatabaseConnection()
        if not db.connect():
            return None
        stats = db.get_total_stats()
        db.close()
        return stats.get("uncrawled", 0)
    except Exception as e:  # noqa: BLE001 - 统计失败不应阻断流程
        print("[提示] 无法连接数据库统计待爬数：%s" % e)
        return None


def _ask(prompt, default="n"):
    """询问 yes/no，回车用默认。"""
    try:
        ans = input("%s [%s]: " % (prompt, default)).strip().lower()
    except EOFError:
        ans = ""
    return ans == "y" or (ans == "" and default == "y")


def _ask_int(prompt, default):
    """询问整数，回车用默认；非数字回退默认。"""
    try:
        raw = input("%s [默认 %s]: " % (prompt, default)).strip()
    except EOFError:
        return default
    if raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        print("  输入无效，使用默认 %s" % default)
        return default


def _ask_float(prompt, default):
    """询问浮点数，回车用默认；非数字回退默认。"""
    try:
        raw = input("%s [默认 %s]: " % (prompt, default)).strip()
    except EOFError:
        return default
    if raw == "":
        return default
    try:
        return float(raw)
    except ValueError:
        print("  输入无效，使用默认 %s" % default)
        return default


# ---------- 各模块参数交互收集（仅菜单模式调用） ----------

def parse_jd_sku(url):
    """从京东商品 URL 中提取 sku_id（数字部分）。

    支持：https://item.jd.com/100012043978.html
          https://item.jd.com/100012043978.html#crumb-wrap
          https://item.jd.com/100012043978.html?xxx=yyy
    返回 sku_id 字符串；无法解析返回 None。
    """
    if not url:
        return None
    m = re.search(r"item\.jd\.com/(\d+)", url)
    return m.group(1) if m else None


def _prompt_detail_opts():
    """进入详情入库模块时询问参数，返回 opts 字典。"""
    print("\n--- 详情入库参数 ---")
    limit = _ask_int("本轮处理上限（0=全部）", DETAIL_LIMIT)
    manual = _ask("遇到验证码时等待人工验证？", "n")
    max_comments = _ask_int("评论抓取数量（0=用默认随机20~50）", 30)
    scroll_pause = _ask_float("详情图滚动停顿秒数（越大越慢越稳）", 0.8)
    download_images = _ask("是否下载图片到本地？（n=只存URL更快更省空间）", "y")
    return {
        "limit": limit,
        "manual": manual,
        "max_comments": max_comments,
        "scroll_pause": scroll_pause,
        "download_images": download_images,
    }


def _prompt_single_detail_opts():
    """进入单商品详情采集时询问参数（无需处理上限/重爬，故比详情入库更精简）。"""
    print("\n--- 单商品详情采集参数 ---")
    manual = _ask("遇到验证码时等待人工验证？", "n")
    max_comments = _ask_int("评论抓取数量（0=用默认随机20~50）", 30)
    scroll_pause = _ask_float("详情图滚动停顿秒数（越大越慢越稳）", 0.8)
    download_images = _ask("是否下载图片到本地？（n=只存URL更快更省空间）", "y")
    return {
        "manual": manual,
        "max_comments": max_comments,
        "scroll_pause": scroll_pause,
        "download_images": download_images,
    }


def _ask_url(prompt):
    """读取一行商品 URL（strip 并去掉可能的引号）。"""
    try:
        raw = input(prompt).strip().strip('"').strip("'")
    except EOFError:
        return ""
    return raw


# ---------- 步骤执行（opts=None 表示用 settings.py 默认） ----------

def step_init(cfg, reset=False):
    extra = ["--reset"] if reset else []
    return _run_script("scripts/load_categories.py", *extra)


def step_initdb(cfg):
    """确保全部核心数据表存在（product_links / product_category_relation / products / crawl_session）。"""
    return _run_script("scripts/detail_crawler_wrapper.py", "--init-db")


def _detail_common_extra(opts):
    """把详情采集通用参数（评论数/滚动停顿/下载/验证码）转成 wrapper 的 CLI 片段。"""
    extra = [] if opts.get("manual") else ["--no-manual-verify"]
    # 评论数量：仅当显式给出且 >0 才透传；否则交给爬虫回落随机 20~50
    if opts.get("max_comments", 0) and opts.get("max_comments") > 0:
        extra += ["--max-comments", str(opts["max_comments"])]
    # 滚动停顿：仅当显式给出且 >0 才透传；否则用 wrapper 默认 0.8
    if opts.get("scroll_pause", 0) and opts.get("scroll_pause") > 0:
        extra += ["--scroll-pause", str(opts["scroll_pause"])]
    # 下载开关：显式给出且为 False（用户选 n）才传 --no-download-images
    if opts.get("download_images", True) is False:
        extra += ["--no-download-images"]
    return extra


def step_add_url(cfg):
    """商品URL采集：让用户输入商品链接，录入 product_links 待爬库（detail_status=0）。

    支持一次输入多个（空格/逗号分隔，或逐行输入直到空行）。录入后由「详情批量入库」消费。
    按 sku_id 去重：已存在则更新 source_url，保留原爬取状态。
    """
    print("\n--- 商品URL采集 ---")
    print("请输入商品链接（每行一个，或一行空格分隔多个；直接回车结束）：")
    print("示例：https://item.jd.com/100012043978.html")
    raw_lines = []
    try:
        while True:
            line = input("> ").strip()
            if not line:
                break
            raw_lines.append(line)
    except EOFError:
        pass

    urls = []
    for line in raw_lines:
        # 一行内可能多个 URL：按空白或逗号切分
        for part in re.split(r"[\s,，]+", line):
            part = part.strip().strip('"').strip("'")
            if part:
                urls.append(part)

    if not urls:
        print("[商品URL采集] 未输入任何链接，已取消。")
        return

    # 解析 + 去重（同一个 sku 只录入一次）
    seen = set()
    records = []  # (sku_id, url)
    invalid = 0
    for u in urls:
        sku = parse_jd_sku(u)
        if not sku:
            print("  [跳过] 无法解析 sku（非 item.jd.com 链接）：%s" % u)
            invalid += 1
            continue
        if sku in seen:
            continue
        seen.add(sku)
        records.append((sku, u))

    if not records:
        print("[商品URL采集] 没有可录入的有效链接（无效 %d 个）。" % invalid)
        return

    # 写入 product_links
    try:
        sys.path.insert(0, os.path.join(ROOT, "scripts"))
        import db_connection
        db = db_connection.DatabaseConnection()
        if not db.connect():
            print("[商品URL采集] 数据库未连接，无法录入。")
            return
        try:
            db.ensure_product_links_table()
            inserted = 0
            updated = 0
            for sku, u in records:
                db.cursor.execute(
                    "INSERT INTO product_links (sku_id, source_url, detail_status, crawl_status) "
                    "VALUES (%s, %s, 0, 0) "
                    "ON DUPLICATE KEY UPDATE source_url = VALUES(source_url)",
                    (sku, u),
                )
                # 受影响行数：1=插入，2=更新，0=无变化（理论上不会 0）
                affected = db.cursor.rowcount
                if affected == 1:
                    inserted += 1
                else:
                    updated += 1
            db.connection.commit()
            print("[商品URL采集] 完成：新增 %d 条，更新已存在 %d 条，无效 %d 个。" % (inserted, updated, invalid))
            print("提示：接下来用菜单 3「详情批量入库」即可对这些链接爬取详情。")
        finally:
            db.close()
    except Exception as e:  # noqa: BLE001 - 录入失败不应让程序崩溃
        print("[商品URL采集] 录入失败：%s" % e)


def step_detail(cfg, retry=False, opts=None):
    ensure_login(cfg)
    if opts is None:
        opts = {"limit": DETAIL_LIMIT, "manual": False}
    mode = "--retry-failed" if retry else "--db"
    extra = _detail_common_extra(opts)
    return _run_script(
        "scripts/detail_crawler_wrapper.py", mode, "--limit", str(opts.get("limit", DETAIL_LIMIT)), *extra
    )


def step_single_detail(cfg, opts=None):
    """单商品详情采集：输入一个商品 URL，直接爬取详情并入库 products（不经 product_links）。"""
    ensure_login(cfg)
    if opts is None:
        opts = {"manual": False}
    url = _ask_url("请输入商品详情页 URL（如 https://item.jd.com/100012043978.html）：")
    sku = parse_jd_sku(url)
    if not sku:
        print("[单商品详情采集] 链接无效，已取消（需 item.jd.com/{数字}.html 形式）。")
        return
    extra = _detail_common_extra(opts)
    return _run_script("scripts/detail_crawler_wrapper.py", "--url", url, *extra)


def step_import(cfg):
    return _run_script("scripts/detail_crawler_wrapper.py", "--from-json")


def step_stats(cfg):
    return _run_script("scripts/detail_crawler_wrapper.py", "--stats")


def run_all(cfg, interactive=False):
    print("========== 一键完整流程 ==========")
    print("[说明] 请先使用「商品URL采集」(菜单 2/url) 录入商品链接，或确保 product_links 中已有待爬项；")
    print("        本流程负责详情入库与兜底导入。首次运行可先 0/init 初始化分类表、1/initdb 确保表存在。")
    detail_opts = _prompt_detail_opts() if interactive else None
    rounds = 0
    while rounds < 10:
        remaining = count_pending()
        if remaining is None:
            print("[提示] 无法确认待爬数量，转为单次详情入库。")
            step_detail(cfg, opts=detail_opts)
            break
        if remaining <= 0:
            print("[完成] 没有待爬商品（detail_status=0 已清空）。")
            break
        rounds += 1
        print("\n=== 详情入库轮次 %d（待爬 %d）===" % (rounds, remaining))
        step_detail(cfg, opts=detail_opts)
    # 重爬失败项
    step_detail(cfg, retry=True, opts=detail_opts)
    # 离线兜底导入
    step_import(cfg)
    step_stats(cfg)
    print("\n========== 完整流程结束 ==========")


def print_intro():
    """打印系统简介与使用引导（菜单模式输入 'h' 或进入菜单时显示）。"""
    print("\n" + "=" * 52)
    print("        京东商品采集系统 · 使用说明")
    print("=" * 52)
    print("本系统采集京东商品数据：从商品链接，到完整商品详情（标题 / 价格 / 图片 / 评论等）。")
    print("\n推荐流程（采集商品URL → 详情页爬取）：")
    print("  ① 商品URL采集（菜单 2）")
    print("     逐行粘贴链接 item.jd.com/{sku}.html")
    print("     → 写入待爬库 product_links（detail_status=0）")
    print("  ② 详情批量入库（菜单 3）")
    print("     读取待爬库，用已登录浏览器逐条爬取详情")
    print("     → 写入 products 表（图片 URL + 本地路径）")
    print("\n其它入口：")
    print("  · 单商品详情采集（菜单 8）：直接爬一个 URL 入库，跳过待爬库")
    print("  · 离线 JSON 导入（菜单 4）：把 data/ 下已爬 JSON 重新入库")
    print("  · 重爬失败项（菜单 5）：重试 detail_status=2 的项")
    print("  · 一键流程（菜单 7）：详情入库 + 重爬 + 导入 + 统计")
    print("\n前提：详情采集前，请用 Chrome/Edge 登录京东，并以调试端口")
    print("      127.0.0.1:9222 启动浏览器。随时输入 'h' 查看本说明。")
    print("=" * 52)


def interactive(cfg):
    menu = (
        "\n========== 京东采集 · 操作菜单 ==========\n"
        " 0  初始化分类表   (init)\n"
        " 1  初始化数据库表 (initdb)\n"
        " 2  商品URL采集    (url)   ← 录入商品链接到待爬库\n"
        " 3  详情批量入库   (detail)\n"
        " 4  离线 JSON 导入 (import)\n"
        " 5  重爬失败项     (retry)\n"
        " 6  查看统计       (stats)\n"
        " 7  一键完整流程   (all)\n"
        " 8  单商品详情采集 (single) ← 直接爬取并入库一个商品\n"
        " h  使用说明       (help)\n"
        " q  退出\n"
        "=======================================\n"
        "提示：选 2/3/5/7/8 进入对应模块后，会逐项询问参数（直接回车用默认）；输入 h 查看使用说明。"
    )
    print_intro()
    while True:
        print(menu)
        try:
            choice = input("请选择 > ").strip().lower()
        except EOFError:
            break
        if choice in ("q", "quit", "exit"):
            break
        elif choice in ("0", "init"):
            reset = _ask("是否清空重建分类表？", "n")
            step_init(cfg, reset=reset)
        elif choice in ("1", "initdb"):
            step_initdb(cfg)
        elif choice in ("2", "url"):
            step_add_url(cfg)
        elif choice in ("3", "detail"):
            opts = _prompt_detail_opts()
            step_detail(cfg, opts=opts)
        elif choice in ("4", "import"):
            step_import(cfg)
        elif choice in ("5", "retry"):
            opts = _prompt_detail_opts()
            step_detail(cfg, retry=True, opts=opts)
        elif choice in ("6", "stats"):
            step_stats(cfg)
        elif choice in ("7", "all"):
            run_all(cfg, interactive=True)
        elif choice in ("8", "single"):
            opts = _prompt_single_detail_opts()
            step_single_detail(cfg, opts=opts)
        elif choice in ("h", "help"):
            print_intro()
        else:
            print("未知选项，请重新选择。")


def _build_parser():
    # 全局通用选项（主解析器与每个子命令都接受，书写顺序不限）
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "--skip-login-check",
        action="store_true",
        help="跳过登录态闸门（脚本模式用；菜单模式遇登录闸门输入 q 即可跳过）",
    )

    parser = argparse.ArgumentParser(
        parents=[common],
        description="京东商品采集系统 · 统一操作入口（main.py）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    sub = parser.add_subparsers(dest="cmd")
    for name in ("init", "initdb", "url", "detail", "retry", "import", "stats", "single", "all", "menu"):
        sub.add_parser(
            name,
            parents=[common],
            help="运行 %s 步骤（参数在交互菜单中询问，或用 jdcrawler/settings.py 默认）" % name,
        )
    return parser


def main():
    parser = _build_parser()
    args = parser.parse_args()

    # 无子命令 → 交互菜单（也兼容旧习惯 main.py menu）
    if args.cmd is None or args.cmd == "menu":
        interactive(args)
        return

    cmd = args.cmd
    if cmd == "init":
        step_init(args, reset=False)
    elif cmd == "initdb":
        step_initdb(args)
    elif cmd == "url":
        step_add_url(args)
    elif cmd == "detail":
        step_detail(args, opts=None)
    elif cmd == "retry":
        step_detail(args, retry=True, opts=None)
    elif cmd == "import":
        step_import(args)
    elif cmd == "stats":
        step_stats(args)
    elif cmd == "single":
        step_single_detail(args, opts=None)
    elif cmd == "all":
        run_all(args, interactive=False)
    else:
        print("未知命令：%s\n" % cmd)
        parser.print_help()


if __name__ == "__main__":
    main()
