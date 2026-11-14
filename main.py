# -*- coding: utf-8 -*-
"""
研究生项目信息爬虫 - 主程序入口

支持的大学:
    - 香港地区: hku, cuhk, cityu, polyu
    - 澳大利亚地区: anu
    - 英国地区: imperial
    - 美国地区: (待实现)

使用方法:
    python main.py              # 交互式选择地区和大学
    python main.py hku          # 直接爬取 HKU
    python main.py hku --debug  # 调试模式（显示浏览器）
"""

import sys
import argparse
import json
import os
from datetime import datetime

# 强制设置输出编码为 UTF-8，解决 Windows 下的 UnicodeEncodeError
if sys.platform.startswith('win'):
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except AttributeError:
        # Python < 3.7 or filtered stdout
        pass

from typing import Optional, Type, Dict, List

# 设置标准输出编码为 UTF-8（解决 Windows 控制台 emoji 显示问题）
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

# 导入爬虫类
from spiders.base_spider import BaseSpider
from spiders.hongkong import HKUSpider
from spiders.hongkong.cuhk_spider import CUHKSpider
from spiders.hongkong.cityu_spider import CityUSpider
from spiders.hongkong.polyu_spider import PolyUSpider
from spiders.australia.anu_spider import ANUSpider
from spiders.australia.uwa_spider import UWASpider
from spiders.australia.deakin_spider import DeakinSpider
from spiders.uk.imperial_spider import ImperialSpider
from spiders.uk.manchester_spider import ManchesterSpider
from spiders.uk.qub_spider import QUBSpider
from spiders.uk.aberdeen_spider import AberdeenSpider
from spiders.uk.uea_spider import UEASpider
from spiders.uk.strathclyde_spider import StrathclydeSpider
from spiders.uk.brunel_spider import BrunelSpider
from spiders.uk.mmu_spider import MMUSpider
from spiders.uk.royalholloway_spider import RoyalHollowaySpider
from spiders.uk.ulster_spider import UlsterSpider
from spiders.usa.harvard_spider import HarvardSpider
from spiders.usa.mit_spider import MITSpider
from spiders.usa.mit_spider import MITSpider
from spiders.usa.stanford_spider import StanfordSpider
from spiders.usa.nyu_spider import NYUSpider
from spiders.usa.duke_kunshan_spider import DukeKunshanSpider
from spiders.usa.maryland_spider import MarylandSpider
from spiders.usa.emory_spider import EmorySpider
from spiders.usa.vanderbilt_spider import VanderbiltSpider
from spiders.usa.indiana_bloomington_spider import IndianaBloomingtonSpider
from spiders.usa.virginia_spider import VirginiaSpider
from spiders.usa.virginia_spider import VirginiaSpider
from spiders.usa.ucsc_spider import UCSCSpider
from spiders.usa.uconn_spider import UConnSpider
from spiders.usa.kansas_spider import KansasSpider
from spiders.usa.delaware_spider import DelawareSpider
from spiders.usa.iowa_state_spider import IowaStateSpider
from spiders.usa.oregon_state_spider import OregonStateSpider
from spiders.ca.montreal_spider import MontrealSpider
from spiders.ca.calgary_spider import CalgarySpider
from spiders.ca.manitoba_spider import ManitobaSpider
from spiders.ca.guelph_spider import GuelphSpider

# 导入工具函数
from utils.data_saver import save_excel, preview_data

# 导入配置
from config import UNIVERSITY_INFO
import config


# ==============================================================================
# 🟢【采集状态持久化】
# 每轮采集后保存分页结局与已采集数据，供「只重跑异常页」使用
# ==============================================================================

def get_state_path(university_key: str) -> str:
    """获取指定大学的采集状态文件路径（运行时读取 OUTPUT_DIR，便于测试重定向）"""
    return os.path.join(config.OUTPUT_DIR, f".spider_state_{university_key}.json")


def save_spider_state(university_key: str, spider: BaseSpider, results: List[Dict]) -> Optional[str]:
    """
    保存本轮采集状态（分页结局、失败页码、已采集数据），供后续重跑异常页

    参数:
        university_key (str): 大学标识
        spider (BaseSpider): 爬虫实例（读取其 page_outcomes / failed_details）
        results (List[Dict]): 本轮（可能已合并）的结果数据

    返回:
        Optional[str]: 状态文件路径，保存失败返回 None
    """
    state = {
        "university_key": university_key,
        "saved_at": datetime.now().isoformat(timespec="seconds"),
        "results": results,
        "page_outcomes": getattr(spider, "page_outcomes", []),
        "failed_pages": spider.get_failed_pages() if hasattr(spider, "get_failed_pages") else [],
        "failed_details": getattr(spider, "failed_details", []),
    }
    try:
        os.makedirs(config.OUTPUT_DIR, exist_ok=True)
        path = get_state_path(university_key)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False, indent=2)
        return path
    except Exception as e:
        print(f"⚠️ 采集状态保存失败: {e}")
        return None


def load_spider_state(university_key: str) -> Optional[Dict]:
    """
    加载上次采集的状态文件

    返回:
        Optional[Dict]: 状态字典（含 results / page_outcomes / failed_pages），不存在返回 None
    """
    path = get_state_path(university_key)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"⚠️ 采集状态读取失败: {e}")
        return None


def print_collection_summary(spider: BaseSpider, results: List[Dict],
                             run_error: Optional[Exception] = None) -> None:
    """
    打印终端采集摘要：总项目数、各页结局、失败详情条数

    无数据时明确区分「页面本身无数据」与「采集中途异常中断」。
    """
    outcomes = getattr(spider, "page_outcomes", []) or []
    failed_details = getattr(spider, "failed_details", []) or []

    print("\n" + "=" * 50)
    print("📋 采集过程摘要")
    print(f"   📊 总项目数: {len(results)} 条")

    if outcomes:
        status_labels = {
            BaseSpider.PAGE_STATUS_SUCCESS: "✅ 成功",
            BaseSpider.PAGE_STATUS_NO_DATA: "📭 无数据",
            BaseSpider.PAGE_STATUS_ERROR: "❌ 异常中断",
        }
        print("   📄 各页结局:")
        for o in outcomes:
            label = status_labels.get(o.get("status"), str(o.get("status")))
            line = f"      第 {o.get('page')} 页: {label}，新增 {o.get('new_items', 0)} 条"
            if o.get("error"):
                line += f"（原因: {o['error']}）"
            print(line)
    else:
        print("   📄 各页结局: （爬虫未登记分页结局）")

    print(f"   ⚠️ 详情抓取失败: {len(failed_details)} 条")
    for f in failed_details[:10]:
        print(f"      - {f.get('name', '')}: {f.get('error', '')}")
    if len(failed_details) > 10:
        print(f"      ... 其余 {len(failed_details) - 10} 条略")

    if run_error is not None:
        print(f"   ❌ 爬虫异常中断: {run_error}（已保留中断前采集的数据）")

    if not results:
        interrupted = run_error is not None or any(
            o.get("status") == BaseSpider.PAGE_STATUS_ERROR for o in outcomes
        )
        if interrupted:
            print("   ⚠️ 本轮采集因异常中断，且未获取到任何数据")
        else:
            print("   📭 本轮采集结果为「无数据」（页面可正常访问，但未列出任何项目）")
    print("=" * 50)


# ==============================================================================
# 🟢【爬虫注册表】
# 在此注册所有可用的爬虫类
# 格式: "标识符": 爬虫类
# ==============================================================================
SPIDER_REGISTRY = {
    "hku": HKUSpider,
    "cuhk": CUHKSpider,
    "cityu": CityUSpider,
    "polyu": PolyUSpider,
    "anu": ANUSpider,
    "uwa": UWASpider,
    "imperial": ImperialSpider,
    "manchester": ManchesterSpider,
    "qub": QUBSpider,
    "aberdeen": AberdeenSpider,
    "uea": UEASpider,
    "strathclyde": StrathclydeSpider,
    "brunel": BrunelSpider,
    "mmu": MMUSpider,
    "royalholloway": RoyalHollowaySpider,
    "ulster": UlsterSpider,
    "deakin": DeakinSpider,
    "harvard": HarvardSpider,
    "mit": MITSpider,
    "stanford": StanfordSpider,
    "nyu": NYUSpider,
    "duke_kunshan": DukeKunshanSpider,
    "duke_kunshan": DukeKunshanSpider,
    "maryland": MarylandSpider,
    "emory": EmorySpider,
    "vanderbilt": VanderbiltSpider,
    "indiana_bloomington": IndianaBloomingtonSpider,
    "virginia": VirginiaSpider,
    "ucsc": UCSCSpider,
    "uconn": UConnSpider,
    "kansas": KansasSpider,
    "delaware": DelawareSpider,
    "iowa_state": IowaStateSpider,
    "oregon_state": OregonStateSpider,
    "montreal": MontrealSpider,
    "calgary": CalgarySpider,
    "manitoba": ManitobaSpider,
    "guelph": GuelphSpider,
    # "hkbu": HKBUSpider,
    # 添加新爬虫时在此注册:
    # "oxford": OxfordSpider,
    # "cambridge": CambridgeSpider,
}


# ==============================================================================
# 🟢【地区分类配置】
# 根据 spiders 文件夹结构自动识别地区
# ==============================================================================
REGION_INFO = {
    "hongkong": {
        "name": "🇭🇰 香港地区",
        "folder": "hongkong"
    },
    "australia": {
        "name": "🇦🇺 澳大利亚地区",
        "folder": "australia"
    },
    "uk": {
        "name": "🇬🇧 英国地区",
        "folder": "uk"
    },
    "usa": {
        "name": "🇺🇸 美国地区",
        "folder": "usa"
    },
    "canada": {
        "name": "🇨🇦 加拿大地区",
        "folder": "ca"
    }
}


def print_banner():
    """打印程序横幅"""
    print("""
╔═════════════════════════════════════════════════════════════════════════╗
║                  🎓 研究生项目信息爬虫 v1.0                             ║
║                  Graduate Program Spider                                ║
╚═════════════════════════════════════════════════════════════════════════╝
    """)


def print_available_regions():
    """打印所有可用的地区选项"""
    print("\n🌍 可用地区列表:")
    print("-" * 40)
    
    for idx, (region_key, region_info) in enumerate(REGION_INFO.items(), 1):
        print(f"  [{idx}] {region_info['name']}")
    
    print("-" * 40)
    print("  [q] 退出程序")


def get_display_width(text: str) -> int:
    """计算文本的显示宽度（中文占2字符，英文占1字符）"""
    width = 0
    for char in text:
        if ord(char) > 127:
            width += 2
        else:
            width += 1
    return width

def pad_text(text: str, width: int) -> str:
    """根据显示宽度填充空格"""
    display_width = get_display_width(text)
    padding = width - display_width
    if padding < 0:
        padding = 0
    return text + " " * padding


def print_region_universities(region_key: str):
    """打印指定地区的所有大学"""
    region_info = REGION_INFO.get(region_key)
    if not region_info:
        return
    
    print(f"\n📚 {region_info['name']} - 可用大学列表:")
    print("-" * 105)
    
    # 筛选该地区的大学（根据 spiders 文件夹结构）
    region_universities = {}
    for key, uni_info in UNIVERSITY_INFO.items():
        if region_key == "hongkong" and key in ["hku", "cuhk", "hkbu", "cityu", "polyu"]:
            region_universities[key] = uni_info
        elif region_key == "australia" and key in ["anu", "uwa", "deakin"]:
            region_universities[key] = uni_info
        elif region_key == "uk" and key in ["imperial", "manchester", "qub", "aberdeen", "uea", "strathclyde", "brunel", "mmu", "royalholloway", "ulster"]:
            region_universities[key] = uni_info
        elif region_key == "usa" and key in ["harvard", "mit", "stanford", "nyu", "duke_kunshan", "maryland", "emory", "vanderbilt", "indiana_bloomington", "virginia", "ucsc", "uconn", "kansas", "delaware", "iowa_state", "oregon_state"]:
            region_universities[key] = uni_info
        elif region_key == "canada" and key in ["montreal", "calgary", "manitoba", "guelph"]:
            region_universities[key] = uni_info
    
    if not region_universities:
        print("  ⚠️ 该地区暂无可用大学")
        return
    
    # 打印表头
    header_key = pad_text("代码 (Code)", 22)
    header_cn = pad_text("中文名称 (Name CN)", 25)
    header_en = pad_text("英文名称 (Name EN)", 42)
    print(f"  {header_key} | {header_cn} | {header_en} | 状态")
    print("-" * 105)

    for key, info in region_universities.items():
        status = "✅ 已实现" if key in SPIDER_REGISTRY else "⏳ 待实现"
        
        # 使用自定义填充函数
        key_str = pad_text(f"[{key}]", 22)
        name_cn_str = pad_text(info['name_cn'], 25)
        name_en_str = pad_text(info['name'], 42)
        
        print(f"  {key_str} | {name_cn_str} | {name_en_str} | {status}")
    
    print("-" * 105)
    print("  [0] 返回上级菜单")
    print("  [q] 退出程序")
    return region_universities


def get_spider_class(university_key: str) -> Optional[Type[BaseSpider]]:
    """
    根据大学标识获取对应的爬虫类
    
    参数:
        university_key (str): 大学标识（如 "hku"）
    
    返回:
        Optional[Type[BaseSpider]]: 爬虫类，如果未找到则返回 None
    """
    return SPIDER_REGISTRY.get(university_key.lower())


def interactive_select_university() -> Optional[str]:
    """
    交互式选择地区和大学
    
    返回:
        Optional[str]: 用户选择的大学标识，如果退出则返回 None
    """
    while True:
        # 第一步：选择地区
        print_available_regions()
        
        region_choice = input("\n🔹 请输入地区编号 (1-4, q退出): ").strip().lower()
        
        if region_choice == 'q':
            print("👋 已退出程序")
            sys.exit(0)
        
        if not region_choice.isdigit():
            print("⚠️ 请输入有效的数字")
            continue
        
        region_idx = int(region_choice)
        if region_idx < 1 or region_idx > len(REGION_INFO):
            print(f"⚠️ 无效的地区编号，请输入 1-{len(REGION_INFO)}")
            continue
        
        # 获取选中的地区
        region_key = list(REGION_INFO.keys())[region_idx - 1]
        
        # 第二步：选择该地区的大学
        while True:
            region_universities = print_region_universities(region_key)
            
            if not region_universities:
                print("❌ 该地区暂无可用大学")
                break
            
            uni_choice = input(f"\n🔹 请输入大学代码 (如 hku, 0返回, q退出): ").strip().lower()
            
            if uni_choice == 'q':
                print("👋 已退出程序")
                sys.exit(0)
                
            if uni_choice == '0':
                break # Break inner loop, return to region selection
            
            if not uni_choice:
                print("⚠️ 输入不能为空，请重试")
                continue
            
            if uni_choice not in region_universities:
                print(f"⚠️ 该地区没有代码为 '{uni_choice}' 的大学，请重试")
                continue
            
            if uni_choice in SPIDER_REGISTRY:
                return uni_choice
            else:
                print(f"⚠️ [{uni_choice}] 的爬虫尚未实现，请选择其他大学")



def run_spider(university_key: str, debug: bool = False,
               retry_failed: bool = False, auto_confirm: bool = False):
    """
    运行指定大学的爬虫

    参数:
        university_key (str): 大学标识
        debug (bool): 是否开启调试模式（显示浏览器窗口）
        retry_failed (bool): 只重跑上次异常中断的页码，并与首次采集结果合并去重
        auto_confirm (bool): 跳过交互确认（用于脚本/测试调用）
    """
    # 获取爬虫类
    spider_class = get_spider_class(university_key)

    if spider_class is None:
        print(f"❌ 错误: 未找到 [{university_key}] 的爬虫实现")
        return

    # 获取大学信息
    uni_info = UNIVERSITY_INFO[university_key]

    print(f"\n🎯 准备爬取: {uni_info['name_cn']} ({uni_info['name']})")
    print(f"📍 目标网址: {uni_info['list_url']}")
    print(f"🔧 运行模式: {'调试模式 (显示浏览器)' if debug else '无头模式 (后台运行)'}")

    # 重跑模式：加载上次状态，确定需要重跑的页码
    previous_results: List[Dict] = []
    failed_pages: List[int] = []
    if retry_failed:
        state = load_spider_state(university_key)
        if not state:
            print("⚠️ 未找到上次采集的状态文件，将执行完整采集")
        else:
            failed_pages = state.get("failed_pages") or []
            previous_results = state.get("results") or []
            if not failed_pages:
                print("✅ 上次采集没有异常中断的页码，无需重跑")
                return
            print(f"🔁 只重跑上次异常中断的页码: {failed_pages}")
            print(f"📦 上次已采集 {len(previous_results)} 条，将在本轮结束后合并去重")

    # 确认开始
    if not auto_confirm:
        confirm = input("\n❓ 确认开始爬取? (Y/n): ").strip().lower()
        if confirm == 'n':
            print("❌ 已取消")
            return

    print("\n" + "=" * 50)
    print("✅ 确认成功！正在为您启动爬虫进程，首次运行可能需要几秒钟加载浏览器...")
    print("⏳ 请耐心等待，不要关闭弹出的窗口。")
    print("=" * 50 + "\n")

    # 使用 with 语句确保资源释放
    with spider_class(headless=not debug) as spider:
        # 只重跑异常页：把页码清单交给爬虫（由爬虫的分页循环自行跳过其他页）
        if retry_failed and failed_pages:
            spider.retry_pages = failed_pages

        # 执行爬取：即使爬虫抛出异常，也保留已采集的数据继续走预览与保存
        results: List[Dict] = []
        run_error: Optional[Exception] = None
        try:
            results = spider.run() or []
        except Exception as e:
            run_error = e
            results = list(getattr(spider, "results", []) or [])
            print(f"\n❌ 爬虫抛出异常: {e}")
            print(f"   已保留中断前采集的 {len(results)} 条数据，继续预览与保存流程")

        # 重跑模式：与首次采集结果合并去重
        if retry_failed and previous_results:
            results = BaseSpider.merge_results(previous_results, results)
            spider.results = results
            print(f"🔀 重跑结果已与首次采集合并去重，合并后共 {len(results)} 条")

        # 终端摘要：总项目数、各页结局、失败详情条数
        print_collection_summary(spider, results, run_error)

        # 保存采集状态（供下次 --retry-failed 使用）
        save_spider_state(university_key, spider, results)

        if results:
            # 预览数据
            preview_data(results, rows=10)

            # 询问是否保存
            save_choice = 'y' if auto_confirm else input("\n💾 是否保存到 Excel? (Y/n): ").strip().lower()
            if save_choice != 'n':
                filepath = save_excel(
                    results,
                    university_code=uni_info['code'],
                    university_name=uni_info['name']
                )
                if filepath:
                    print("\n✨ 任务完成！")
        # 无数据的情况已在 print_collection_summary 中明确说明（无数据 vs 异常中断）


def main():
    """主函数：解析命令行参数并运行爬虫"""
    parser = argparse.ArgumentParser(
        description="研究生项目信息爬虫 - 按地区分类选择大学",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
使用示例:
  python main.py              交互式选择地区和大学
  python main.py hku          直接爬取香港大学
  python main.py cuhk --debug 调试模式爬取香港中文大学
  python main.py hku --retry-failed  只重跑上次异常中断的页码并合并去重
        """
    )
    
    parser.add_argument(
        'university',
        nargs='?',
        help='大学代码 (如 hku, cuhk)'
    )
    
    parser.add_argument(
        '--debug',
        action='store_true',
        help='调试模式（显示浏览器窗口）'
    )

    parser.add_argument(
        '--retry-failed',
        action='store_true',
        help='只重跑上次异常中断的页码，并与首次采集结果合并去重'
    )

    args = parser.parse_args()
    
    # 打印横幅
    print_banner()
    
    # 确定要爬取的大学
    if args.university:
        # 直接模式
        university_key = args.university.lower()
        if university_key not in UNIVERSITY_INFO:
            print(f"❌ 未知的大学代码: '{args.university}'")
            print_available_regions()
            return
    else:
        # 交互模式
        university_key = interactive_select_university()
        if not university_key:
            return
    
    # 运行爬虫
    run_spider(university_key, debug=args.debug, retry_failed=args.retry_failed)


if __name__ == "__main__":
    main()
