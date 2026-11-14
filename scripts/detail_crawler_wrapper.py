# -*- coding: utf-8 -*-
"""
京东商品详情页爬虫 - 数据库版包装器（详情采集统一入口）
功能：
1. 支持传入 --url 参数爬取单个URL
2. 支持 --db 参数从数据库批量获取未爬取URL
3. 支持 --from-json 离线导入 data/ 下的 JSON 到 products 表（整合原 json_to_products.py）
4. 复用原 jd_product_detail.py 的功能，不修改原代码
5. 自动更新数据库爬取状态
6. 爬取完成后自动将数据保存到 products 表

注意：所有命令均从项目根目录运行（脚本位于 scripts/ 下）。

使用方法：
1. 爬取单个URL：
   python scripts/detail_crawler_wrapper.py --url https://item.jd.com/100012043978.html

2. 从数据库批量爬取（默认10个）：
   python scripts/detail_crawler_wrapper.py --db

3. 从数据库批量爬取指定数量：
   python scripts/detail_crawler_wrapper.py --db --limit 20

4. 离线导入 data/ 下已爬取的 JSON：
   python scripts/detail_crawler_wrapper.py --from-json

5. 初始化数据库字段（第一次使用）：
   python scripts/detail_crawler_wrapper.py --init-db

6. 控制评论抓取数量、详情图滚动速度与是否下载图片：
   python scripts/detail_crawler_wrapper.py --url <URL> --max-comments 30 --scroll-pause 1.2
   python scripts/detail_crawler_wrapper.py --url <URL> --no-download-images
   （--max-comments N：目标评论数，省略则回落随机 20~50；--scroll-pause 秒：每屏停顿，越大越稳；
     --no-download-images：跳过下载，仅记录远程 URL，抓取更快更省磁盘）
"""

import sys
import os
import importlib.util
import argparse
import traceback

# 项目根目录：本文件位于 scripts/ 下，其父目录即项目根。
# 离线导入的默认 data 目录统一解析到项目根，避免依赖 cwd 生成 scripts/data 错位目录。
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 导入原爬虫模块
def import_jd_product_detail():
    """动态导入 jd_product_detail.py 模块"""
    module_name = 'jd_product_detail'
    file_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'jd_product_detail.py')
    
    spec = importlib.util.spec_from_file_location(module_name, file_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"无法导入模块: {file_path}")
    
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module

# 导入数据库连接模块
from db_connection import DatabaseConnection
# 导入 JSON 离线导入器（整合原 json_to_products.py）
from json_to_products import JsonToProductsImporter

# 公共入库逻辑（修复 M3/M5）：字段提取、按表结构动态截断、UPSERT 统一在此维护
from product_persist import (
    get_product_column_limits,
    build_product_values,
    upsert_product,
)
# 状态枚举（健壮性 L4）
from jdcrawler.status_constants import DetailStatus


class DetailCrawlerWrapper:
    """详情页爬虫包装器"""
    
    def __init__(self):
        self.db = DatabaseConnection()
        self.jd_module = None
        # 详情图慢速滚动停顿（秒）；评论抓取目标数量（None=由 spider 回落随机 20~50）
        self.scroll_pause = 0.8
        self.max_comments = None
        # 是否下载图片到本地（False=只记录 URL 不落盘，抓取更快更省空间）
        self.download_images = True
    
    def init(self):
        """初始化：连接数据库，导入爬虫模块"""
        # 连接数据库
        if not self.db.connect():
            return False

        # 确保全部核心表存在（product_links / product_category_relation / products /
        # crawl_session），使干净库上 --db/--url/--stats 均可直接工作（完善数据库初始化）。
        # products 表的 sku_id 唯一索引也在内部一并确保（幂等写入/重入前提，修复 M1/M2）。
        self.db.ensure_core_tables()

        # 导入原爬虫模块
        try:
            self.jd_module = import_jd_product_detail()
            print("[包装器] 原爬虫模块导入成功")
            return True
        except Exception as e:
            print(f"[包装器] 导入爬虫模块失败: {e}")
            traceback.print_exc()
            return False

    def crawl_single_url(self, url: str, wait_for_manual_verify: bool = False):
        """
        爬取单个URL

        Args:
            url: 京东商品URL
            wait_for_manual_verify: 是否等待人工验证（--url 默认开；批量爬取强制关闭，避免无人值守卡死 H3）

        Returns:
            爬取到的商品数据（字典），失败返回None
        """
        if not self.jd_module:
            print("[包装器] 爬虫模块未初始化")
            return None

        try:
            # 创建原爬虫实例
            spider = self.jd_module.JdProductDetailSpider(
                product_url=url,
                enable_anti_detect=True,
                wait_for_manual_verify=wait_for_manual_verify,
                image_save_dir="images",
                max_comments=self.max_comments,
                scroll_pause=self.scroll_pause,
                download_images=self.download_images,
            )

            # 运行爬虫，获取数据
            product_data = spider.run()
            return product_data
        except Exception as e:
            print(f"[包装器] 爬取失败: {e}")
            traceback.print_exc()
            return None

    def _save_to_db(self, product_data):
        """
        将爬取到的商品数据保存到数据库（幂等：冲突时按 sku_id 更新，不重复插入，修复 M1/M2）。

        以 product_links.id 作为 products.id，保证"实时爬取入库"与"JSON 离线导入"
        两条路径写入同一张表时主键一致（修复 M1）。

        字段提取 / 动态截断 / 组装统一委托 product_persist（修复 M3/M5）。
        """
        if not product_data:
            return False

        self.db._ensure_connection()

        try:
            sku_id = product_data.get('sku_id', '')
            if not sku_id:
                print("[数据库] SKU ID为空，跳过保存")
                return False

            # 解析 product_links.id，作为 products.id（双路径一致）
            self.db.cursor.execute("SELECT id FROM product_links WHERE sku_id = %s", (sku_id,))
            link_result = self.db.cursor.fetchone()
            product_id = link_result['id'] if link_result else None

            # 解析 category_id
            category_id = None
            self.db.cursor.execute(
                "SELECT category_id FROM product_category_relation WHERE sku_id = %s LIMIT 1",
                (sku_id,)
            )
            relation_result = self.db.cursor.fetchone()
            if relation_result:
                category_id = relation_result['category_id']
            if category_id is None:
                category_id = product_data.get('category_id', 0)

            # 按表结构动态获取列长度上限（修复 M3），超长自动截断并告警
            db_name = getattr(self.db, 'db', None) or 'jd_data'
            limits = get_product_column_limits(self.db.cursor, db_name)

            # 统一组装字段并执行幂等写入（修复 M5）
            values = build_product_values(product_data, category_id, limits, warn=print)
            upsert_product(self.db.cursor, product_id, values)
            self.db.connection.commit()
            print(f"[数据库] SKU {sku_id} 已保存/更新到 products 表")
            return True

        except Exception as e:
            print(f"[数据库] 保存失败: {e}")
            traceback.print_exc()
            if self.db.connection:
                try:
                    self.db.connection.rollback()
                except Exception:
                    pass
            return False

    def crawl_from_db(self, limit: int = 10, retry_failed: bool = False):
        """
        从数据库批量爬取

        Args:
            limit: 爬取数量
            retry_failed: 为 True 时重爬失败项（修复 M8），否则爬取待爬取(0)
        """
        if not self.jd_module:
            print("[包装器] 爬虫模块未初始化")
            return

        # 获取待爬取的URL（批量模式不等待人工验证，避免无人值守卡死 H3）
        status = DetailStatus.FAILED if retry_failed else DetailStatus.PENDING
        urls = self.db.get_uncrawled_urls(limit=limit, status=status)

        if not urls:
            print("[包装器] 没有未爬取的URL")
            return

        print(f"\n[包装器] 开始批量爬取，共 {len(urls)} 个URL\n")

        success_count = 0
        fail_count = 0

        # 记录本次运行会话（健壮性 L3），便于中断后审计
        self.db.ensure_crawl_session_table()
        session_id = self.db.start_session(
            'detail_crawl', note=f"limit={limit}, retry_failed={retry_failed}"
        )

        for idx, item in enumerate(urls, 1):
            link_id = item['id']
            sku_id = item['sku_id']
            url = item['source_url']

            print(f"\n{'='*80}")
            print(f"[进度] {idx}/{len(urls)} - SKU: {sku_id}")
            print(f"[URL] {url}")
            print(f"{'='*80}")

            try:
                # 标记为爬取中（先用 FAILED 值占位，成功后改写为 SUCCESS）
                self.db.update_crawl_status(link_id, status=DetailStatus.FAILED, error_msg="爬取中...")

                # 爬取
                product_data = self.crawl_single_url(url)

                if product_data:
                    # 保存到数据库
                    save_success = self._save_to_db(product_data)
                    if save_success:
                        success_count += 1
                        self.db.update_crawl_status(link_id, status=DetailStatus.SUCCESS)
                        print(f"\n[成功] SKU {sku_id} 爬取并保存完成")
                    else:
                        fail_count += 1
                        self.db.update_crawl_status(link_id, status=DetailStatus.FAILED, error_msg="保存失败")
                        print(f"\n[失败] SKU {sku_id} 爬取成功但保存失败")
                else:
                    fail_count += 1
                    self.db.update_crawl_status(link_id, status=DetailStatus.FAILED, error_msg="爬取失败")
                    print(f"\n[失败] SKU {sku_id} 爬取失败")

            except Exception as e:
                fail_count += 1
                error_msg = str(e)
                self.db.update_crawl_status(link_id, status=DetailStatus.FAILED, error_msg=error_msg)
                print(f"\n[异常] SKU {sku_id}: {e}")
                traceback.print_exc()

        self.db.finish_session(
            session_id, total=len(urls), success=success_count, failed=fail_count
        )

        # 打印统计
        print(f"\n{'='*80}")
        print(f"[完成] 批量爬取结束")
        print(f"  总数: {len(urls)}")
        print(f"  成功: {success_count}")
        print(f"  失败: {fail_count}")
        print(f"{'='*80}")
    
    def show_stats(self):
        """显示统计信息"""
        stats = self.db.get_total_stats()
        print("\n" + "="*60)
        print("数据库统计")
        print("="*60)
        print(f"  商品总数: {stats['total']}")
        print(f"  未爬取:   {stats['uncrawled']}")
        print(f"  已爬取:   {stats['crawled']}")
        print(f"  失败:     {stats['failed']}")
        print("="*60 + "\n")
    
    def init_database_fields(self):
        """初始化数据库表结构（确保全部核心表存在）"""
        print("[包装器] 初始化数据库表结构...")
        self.db.ensure_core_tables()
        print("[包装器] 完成")
    
    def crawl_from_json(self, data_dir: str = "data", batch_size: int = 50, init_table: bool = False):
        """
        离线模式：将 data/ 目录下由 jd_product_detail.py 生成的 JSON 批量导入 products 表。
        该模式不依赖 DrissionPage，适合把已爬取的 JSON 重新入库或迁移。
        data_dir 若为相对路径，统一解析到项目根（PROJECT_ROOT），避免 cwd 依赖导致的错位。
        """
        if not os.path.isabs(data_dir):
            data_dir = os.path.join(PROJECT_ROOT, data_dir)
        importer = JsonToProductsImporter()
        if not importer.connect():
            return
        try:
            if init_table:
                importer.init_products_table()
            importer.import_directory(data_dir, batch_size=batch_size, use_relation_category=True)
            importer.show_stats()
        finally:
            importer.close()
    
    def close(self):
        """关闭资源"""
        self.db.close()


def main():
    """主函数"""
    parser = argparse.ArgumentParser(description='京东商品详情页爬虫 - 数据库版包装器')
    parser.add_argument('--url', type=str, help='单个商品URL')
    parser.add_argument('--db', action='store_true', help='从数据库批量爬取')
    parser.add_argument('--limit', type=int, default=10, help='批量爬取数量（默认10）')
    parser.add_argument('--init-db', action='store_true', help='初始化数据库字段')
    parser.add_argument('--stats', action='store_true', help='显示统计信息')
    parser.add_argument('--retry-failed', action='store_true',
                        help='重爬 detail_status=2 的失败项（默认只爬未爬取(0)）')
    parser.add_argument('--no-manual-verify', dest='manual_verify', action='store_false',
                        default=True, help='--url 模式下不等待人工验证码（默认等待）')
    parser.add_argument('--from-json', action='store_true',
                        help='离线模式：将 data/ 目录下的 JSON 批量导入 products 表（不需要 DrissionPage）')
    parser.add_argument('--json-dir', type=str, default='data', help='JSON 导入目录（默认 data）')
    parser.add_argument('--batch', type=int, default=50, help='JSON 批量导入提交大小（默认 50）')
    parser.add_argument('--init-products', action='store_true', help='导入前初始化 products 表结构')
    parser.add_argument('--max-comments', type=int, default=None,
                        help='评论抓取目标数量（默认 None=由爬虫回落随机 20~50 条）')
    parser.add_argument('--scroll-pause', type=float, default=0.8,
                        help='详情图慢速滚动每屏停顿秒数（默认 0.8，越大越慢越稳）')
    parser.add_argument('--no-download-images', action='store_true',
                        help='不下载图片到本地，仅记录远程 URL（抓取更快、更省磁盘）')

    args = parser.parse_args()

    # 离线 JSON 导入模式：独立于实时爬取，无需 DrissionPage / 浏览器
    if args.from_json:
        importer = JsonToProductsImporter()
        if not importer.connect():
            return
        try:
            if args.init_products:
                importer.init_products_table()
            importer.import_directory(args.json_dir, batch_size=args.batch, use_relation_category=True)
            importer.show_stats()
        finally:
            importer.close()
        return

    # 创建包装器
    wrapper = DetailCrawlerWrapper()
    
    try:
        # 初始化
        if not wrapper.init():
            return

        # 透传评论数量 / 滚动停顿 / 下载开关配置（仅实时爬取生效；离线 JSON 导入不走这里）
        wrapper.max_comments = args.max_comments
        wrapper.scroll_pause = args.scroll_pause
        wrapper.download_images = not args.no_download_images
        
        # 显示统计
        if args.stats:
            wrapper.show_stats()
            return
        
        # 初始化数据库字段
        if args.init_db:
            wrapper.init_database_fields()
            return
        
        # 爬取单个URL
        if args.url:
            print(f"[包装器] 爬取单个URL: {args.url}（人工验证: {args.manual_verify}）")
            success = wrapper.crawl_single_url(args.url, wait_for_manual_verify=args.manual_verify)
            print(f"\n[完成] {'成功' if success else '失败'}")
            return
        
        # 从数据库批量爬取
        if args.db:
            wrapper.show_stats()
            wrapper.crawl_from_db(limit=args.limit, retry_failed=args.retry_failed)
            wrapper.show_stats()
            return
        
        # 显示帮助
        print("\n请选择一种运行方式：")
        print("  1. 爬取单个URL:")
        print("     python scripts/detail_crawler_wrapper.py --url https://item.jd.com/100012043978.html")
        print("  2. 从数据库批量爬取:")
        print("     python scripts/detail_crawler_wrapper.py --db")
        print("     python scripts/detail_crawler_wrapper.py --db --limit 20")
        print("  3. 离线导入 data/ 下的 JSON 到 products 表:")
        print("     python scripts/detail_crawler_wrapper.py --from-json")
        print("     python scripts/detail_crawler_wrapper.py --from-json --json-dir data --batch 50")
        print("  4. 初始化数据库字段（第一次使用）:")
        print("     python scripts/detail_crawler_wrapper.py --init-db")
        print("  5. 查看统计:")
        print("     python scripts/detail_crawler_wrapper.py --stats")
        print()
        
    finally:
        wrapper.close()


if __name__ == "__main__":
    main()
