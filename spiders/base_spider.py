# -*- coding: utf-8 -*-
"""
爬虫基类模块
定义所有大学爬虫的通用接口和基础功能
"""

from abc import ABC, abstractmethod
from typing import List, Dict, Optional
import time
import re
import random

from selenium.webdriver.remote.webdriver import WebDriver

# 尝试导入 rich 库
try:
    from rich.console import Console
    from rich.panel import Panel
    from rich.table import Table
    from rich import box
    RICH_AVAILABLE = True
except ImportError:
    RICH_AVAILABLE = False

from utils.browser import get_driver, close_driver
from config import UNIVERSITY_INFO

# 创建全局 Console 实例
console = Console() if RICH_AVAILABLE else None


class BaseSpider(ABC):
    """
    爬虫基类

    所有大学的爬虫都应该继承此类，并实现 run() 方法。

    属性:
        university_key (str): 大学标识（如 "hku", "hkbu"）
        university_info (dict): 大学相关配置信息
        driver (WebDriver): Selenium 浏览器驱动
        results (List[Dict]): 爬取结果列表
        page_outcomes (List[Dict]): 分页结局清单，每页一条记录
        failed_details (List[Dict]): 详情抓取失败清单
        retry_pages (Optional[List[int]]): 只重跑指定页码（None 表示全部页）

    使用示例:
        >>> class MySpider(BaseSpider):
        ...     def run(self):
        ...         # 实现具体爬取逻辑
        ...         pass
        >>> spider = MySpider("hku")
        >>> data = spider.run()
        >>> spider.close()
    """

    # 分页结局状态常量
    PAGE_STATUS_SUCCESS = "success"    # 成功
    PAGE_STATUS_NO_DATA = "no_data"    # 无数据
    PAGE_STATUS_ERROR = "error"        # 异常中断

    # 分页状态的中文描述（供摘要展示）
    PAGE_STATUS_LABELS = {
        PAGE_STATUS_SUCCESS: "成功",
        PAGE_STATUS_NO_DATA: "无数据",
        PAGE_STATUS_ERROR: "异常中断",
    }

    def __init__(self, university_key: str, headless: bool = True):
        """
        初始化爬虫实例
        
        参数:
            university_key (str): 大学标识（必须在 config.UNIVERSITY_INFO 中定义）
            headless (bool): 是否无头模式运行（默认 True）
        
        异常:
            ValueError: 如果 university_key 不存在于配置中
        """
        # 验证大学标识
        if university_key not in UNIVERSITY_INFO:
            available = ", ".join(UNIVERSITY_INFO.keys())
            raise ValueError(
                f"未知的大学标识: '{university_key}'\n"
                f"可用选项: {available}"
            )
        
        self.university_key = university_key
        self.university_info = UNIVERSITY_INFO[university_key]
        self.headless = headless
        
        # 初始化浏览器驱动（延迟加载）
        self._driver: Optional[WebDriver] = None
        
        # 存储爬取结果
        self.results: List[Dict] = []

        # 分页结局清单：每页一条记录
        # 每条记录: {"page": 页码, "status": success/no_data/error,
        #            "new_items": 该页新增项目数, "error": 异常简述或 None}
        self.page_outcomes: List[Dict] = []

        # 详情抓取失败清单
        # 每条记录: {"name": 项目名称, "link": 项目链接, "error": 异常简述}
        self.failed_details: List[Dict] = []

        # 只重跑指定页码（如上次异常中断的页）；None 表示遍历全部页
        # 子类分页循环可自行读取该属性跳过不在列表中的页
        self.retry_pages: Optional[List[int]] = None

        # 记录开始时间
        self.start_time: Optional[float] = None
        
        print(f"[-] 初始化爬虫: {self.university_info['name_cn']} ({self.university_info['name']})")
    
    @property
    def driver(self) -> WebDriver:
        """
        懒加载浏览器驱动
        只有在第一次访问时才会创建驱动实例
        """
        if self._driver is None:
            # 简化启动过程，避免 rich console 干扰
            print("🌐 正在启动浏览器 (Browser Launching)...")
            self._driver = get_driver(self.headless)
        return self._driver
    
    @property
    def base_url(self) -> str:
        """获取大学网站基础 URL"""
        return self.university_info['base_url']
    
    @property
    def list_url(self) -> str:
        """获取项目列表页 URL"""
        return self.university_info['list_url']
    
    @property
    def school_code(self) -> str:
        """获取学校代码"""
        return self.university_info['code']
    
    @property
    def school_name(self) -> str:
        """获取学校名称"""
        return self.university_info['name']
    
    def create_result_template(self, program_name: str, program_link: str) -> Dict:
        """
        创建结果数据模板
        
        参数:
            program_name (str): 项目名称
            program_link (str): 项目链接
        
        返回:
            Dict: 预填充了基本信息的结果字典
        """
        return {
            "学校代码": self.school_code,
            "学校名称": self.school_name,
            "项目名称": program_name,
            "学院/学习领域": "N/A",  # 统一字段：Faculty或Study Area
            "项目官网链接": program_link,
            "申请链接": "N/A",
            "项目opendate": "N/A",
            "项目deadline": "N/A",
            "学生案例": "",
            "面试问题": ""
        }

    # ------------------------------------------------------------------
    # 分页结局登记
    # ------------------------------------------------------------------

    def register_page_outcome(self, page: int, status: str,
                              new_items: int = 0, error: Optional[str] = None) -> Dict:
        """
        登记一页的采集结局（供子类分页循环调用）

        参数:
            page (int): 页码（从 1 开始）
            status (str): 结局状态，取值为
                BaseSpider.PAGE_STATUS_SUCCESS（成功）、
                BaseSpider.PAGE_STATUS_NO_DATA（无数据）、
                BaseSpider.PAGE_STATUS_ERROR（异常中断）
            new_items (int): 该页新增的项目数（默认 0）
            error (Optional[str]): 异常简述（仅异常中断时填写）

        返回:
            Dict: 已登记的分页结局记录
        """
        valid = (self.PAGE_STATUS_SUCCESS, self.PAGE_STATUS_NO_DATA, self.PAGE_STATUS_ERROR)
        if status not in valid:
            raise ValueError(f"非法的分页结局状态: '{status}'，可选值: {valid}")

        outcome = {
            "page": page,
            "status": status,
            "new_items": new_items,
            "error": str(error) if error else None,
        }
        self.page_outcomes.append(outcome)

        label = self.PAGE_STATUS_LABELS[status]
        line = f"   📄 第 {page} 页结局: {label}，新增 {new_items} 条"
        if outcome["error"]:
            line += f"（原因: {outcome['error']}）"
        print(line)
        return outcome

    def register_page_success(self, page: int, new_items: int) -> Dict:
        """登记一页抓取成功"""
        return self.register_page_outcome(page, self.PAGE_STATUS_SUCCESS, new_items)

    def register_page_no_data(self, page: int, note: Optional[str] = None) -> Dict:
        """登记一页为无数据（页面正常但未列出任何项目）"""
        return self.register_page_outcome(page, self.PAGE_STATUS_NO_DATA, 0, note)

    def register_page_error(self, page: int, error, new_items: int = 0) -> Dict:
        """登记一页异常中断（记录后应停止翻页，已收集的项目保留在 results 中）"""
        return self.register_page_outcome(page, self.PAGE_STATUS_ERROR, new_items, error)

    def get_failed_pages(self) -> List[int]:
        """
        获取异常中断的页码列表（可用于只重跑这些页）

        返回:
            List[int]: 状态为「异常中断」的页码
        """
        return [o["page"] for o in self.page_outcomes if o["status"] == self.PAGE_STATUS_ERROR]

    # ------------------------------------------------------------------
    # 详情抓取登记
    # ------------------------------------------------------------------

    def register_detail_failure(self, item: Dict, error) -> Dict:
        """
        登记一条详情抓取失败（其余条目应继续抓取）

        参数:
            item (Dict): 失败的项目信息（含 name/link 或 项目名称/项目官网链接）
            error: 异常对象或简述

        返回:
            Dict: 已登记的失败记录
        """
        record = {
            "name": item.get("name") or item.get("项目名称", ""),
            "link": item.get("link") or item.get("项目官网链接", ""),
            "error": str(error),
        }
        self.failed_details.append(record)
        print(f"   ⚠️ 详情抓取失败: {record['name']}（{record['error']}）")
        return record

    def fetch_detail_safely(self, item: Dict, fetch_func) -> Dict:
        """
        抓取单条详情并逐条登记结局。

        先创建结果模板，再调用 fetch_func(result) 填充字段；
        若 fetch_func 抛异常，只把该条标记为异常（保留模板字段），
        登记到 failed_details，不会中断其余条目。

        参数:
            item (Dict): 项目信息（含 name/link 或 项目名称/项目官网链接）
            fetch_func: 接受结果字典并填充详情的回调，如 lambda r: r.update(...)

        返回:
            Dict: 结果字典，含「详情状态」字段（正常 / 异常: ...）
        """
        name = item.get("name") or item.get("项目名称", "")
        link = item.get("link") or item.get("项目官网链接", "")
        result = self.create_result_template(name, link)
        try:
            fetch_func(result)
            result["详情状态"] = "正常"
        except Exception as e:
            self.register_detail_failure(item, e)
            result["详情状态"] = f"异常: {e}"
        return result

    def get_failed_detail_count(self) -> int:
        """获取详情抓取失败的条数"""
        return len(self.failed_details)

    # ------------------------------------------------------------------
    # 结果合并（重跑异常页后与首次采集合并去重）
    # ------------------------------------------------------------------

    @staticmethod
    def merge_results(first: List[Dict], second: List[Dict]) -> List[Dict]:
        """
        合并两轮采集结果并按「项目名称 + 项目官网链接」去重。

        先出现的记录优先保留（首次采集的数据不会被重跑结果覆盖）。

        参数:
            first (List[Dict]): 第一轮（如首次采集）的结果
            second (List[Dict]): 第二轮（如重跑异常页）的结果

        返回:
            List[Dict]: 合并去重后的结果
        """
        merged: List[Dict] = []
        seen = set()
        for item in list(first or []) + list(second or []):
            key = (
                " ".join(str(item.get("项目名称", "")).split()),
                str(item.get("项目官网链接", "")).strip(),
            )
            if key in seen:
                continue
            seen.add(key)
            merged.append(item)
        removed = (len(first or []) + len(second or [])) - len(merged)
        if removed > 0:
            print(f"🔧 合并去重: 移除 {removed} 条重复记录，保留 {len(merged)} 条")
        return merged

    def get_page_outcome_lines(self) -> List[str]:
        """
        获取分页结局的可读文本行（供终端摘要展示）

        返回:
            List[str]: 每页一行，如 "第 2 页: 异常中断，新增 0 条（原因: 超时）"
        """
        lines = []
        for o in self.page_outcomes:
            label = self.PAGE_STATUS_LABELS.get(o["status"], o["status"])
            line = f"第 {o['page']} 页: {label}，新增 {o['new_items']} 条"
            if o.get("error"):
                line += f"（原因: {o['error']}）"
            lines.append(line)
        return lines

    @abstractmethod
    def run(self) -> List[Dict]:
        """
        执行爬取任务（子类必须实现）
        
        返回:
            List[Dict]: 爬取到的数据列表
        """
        pass
    
    def close(self) -> None:
        """
        关闭浏览器，释放资源
        
        在完成爬取后必须调用此方法来清理资源
        """
        if self._driver is not None:
            print("🔒 正在关闭浏览器...")
            close_driver(self._driver)
            self._driver = None
    
    def get_elapsed_time(self) -> float:
        """
        获取已运行时间（秒）
        
        返回:
            float: 已运行秒数
        """
        if self.start_time is None:
            return 0.0
        return time.time() - self.start_time
    
    def print_summary(self) -> None:
        """
        打印爬取结果摘要（含分页结局与详情失败统计）
        """
        elapsed = self.get_elapsed_time()

        # 格式化时间
        if elapsed >= 60:
            time_str = f"{elapsed/60:.2f} 分钟 ({elapsed:.1f} 秒)"
        else:
            time_str = f"{elapsed:.2f} 秒"

        # 分页结局文本（每页一行）
        outcome_lines = self.get_page_outcome_lines()
        outcomes_text = "\n".join(outcome_lines) if outcome_lines else "（未登记分页结局）"
        failed_detail_count = len(self.failed_details)

        if RICH_AVAILABLE and console:
            # 使用 rich 美化输出
            table = Table(box=box.ROUNDED, show_header=False, padding=(0, 2))
            table.add_column("项目", style="cyan", width=12)
            table.add_column("值", style="green")

            table.add_row("🏫 目标学校", f"{self.university_info['name_cn']} ({self.university_info['name']})")
            table.add_row("📊 获取数据", f"[bold]{len(self.results)}[/bold] 条")
            table.add_row("📄 分页结局", outcomes_text)
            table.add_row("⚠️ 详情失败", f"{failed_detail_count} 条")
            table.add_row("⏱️ 总耗时", time_str)

            console.print()
            console.print(Panel(
                table,
                title="[bold green]🎉 爬取完成！[/bold green]",
                border_style="green",
                padding=(1, 2)
            ))
            console.print()
        else:
            # 简单文本输出
            print("\n" + "=" * 50)
            print(f"🎉 爬取完成！")
            print(f"🏫 目标学校: {self.university_info['name_cn']}")
            print(f"📊 获取数据: {len(self.results)} 条")
            print(f"📄 分页结局:")
            for line in outcome_lines:
                print(f"   - {line}")
            if not outcome_lines:
                print("   （未登记分页结局）")
            print(f"⚠️ 详情失败: {failed_detail_count} 条")
            print(f"⏱️ 总耗时: {time_str}")
            print("=" * 50)
    
    def _clean_text(self, text: str) -> str:
        """
        清洗文本：去空白、换行
        """
        if not text:
            return ""
        # 替换多余空白
        return re.sub(r'\s+', ' ', text).strip()

    def random_sleep(self, min_seconds: float = 1.0, max_seconds: float = 3.0) -> None:
        """
        随机休眠一段时间，模拟人类操作
        """
        sleep_time = random.uniform(min_seconds, max_seconds)
        time.sleep(sleep_time)

    def __enter__(self):
        """支持 with 语句"""
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        """退出 with 语句时自动关闭浏览器"""
        self.close()
        return False

