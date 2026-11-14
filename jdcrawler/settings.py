# Scrapy settings for jdcrawler project

BOT_NAME = "jdcrawler"

SPIDER_MODULES = ["jdcrawler.spiders"]
NEWSPIDER_MODULE = "jdcrawler.spiders"

# 不遵守 robots.txt
ROBOTSTXT_OBEY = False

# 并发设置
CONCURRENT_REQUESTS = 1
CONCURRENT_REQUESTS_PER_DOMAIN = 1
CONCURRENT_ITEMS = 100

# 请求间隔（秒），避免触发滑块验证
DOWNLOAD_DELAY = 4
RANDOMIZE_DOWNLOAD_DELAY = True

# 请求头
DEFAULT_REQUEST_HEADERS = {
    "Accept": "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": "https://search.jd.com/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
}

# 下载中间件 — 启用 DrissionPage
DOWNLOADER_MIDDLEWARES = {
    "jdcrawler.middlewares.DrissionPageMiddleware": 543,
}

# 管道（去重 + MySQL写入）
ITEM_PIPELINES = {
    "jdcrawler.pipelines.JdPipeline": 200,             # SKU去重
    "jdcrawler.pipelines.MysqlPipeline": 300,          # 写入 product_links 表
}

# ==================== 数据库连接设置 ====================
MYSQL_HOST = '127.0.0.1'
MYSQL_USER = 'root'
MYSQL_PASSWORD = '123456'
MYSQL_DB = 'jd_data'                          # 数据库名称
MYSQL_PORT = 3306
MYSQL_CHARSET = 'utf8mb4'
MYSQL_BATCH_SIZE = 60                         # 批量插入数据量（每页约60个商品，即每页提交一次）

# ==================== 爬取控制设置 ====================
CATEGORY_LIMIT = 1                            # 爬取分类数，0 = 全部（默认只爬1个测试）
MAX_PAGES = 20                               # 每个分类最大翻页数，0 = 不限
ITEMS_PER_CATEGORY = 0                        # 每个分类爬取商品数量，0 = 不限
START_CATEGORY = 0                            # 起始分类索引
END_CATEGORY = 0                              # 结束分类索引，0 = 不限

# ==================== DrissionPage 浏览器设置 ====================
EDGE_ADDRESS = "127.0.0.1:9222"               # Edge调试地址
MIN_DELAY = 1                                 # 最小页面加载等待时间（秒）
MAX_DELAY = 30                                # 最大页面加载等待时间（秒）
MIN_SCROLL_DELAY = 2.0                        # 最小滚动间隔（秒）
MAX_SCROLL_DELAY = 4.0                        # 最大滚动间隔（秒）
SCROLL_STABLE_ROUNDS = 5                      # 滚动稳定轮数
MAX_SCROLL_TIMES = 30                         # 最大滚动次数

# ==================== 日志设置 ====================
LOG_LEVEL = "INFO"
LOG_FILE = "scrapy.log"
LOG_FILE_MAX_BYTES = 10 * 1024 * 1024   # 单日志文件最大 10MB（健壮性 L1：日志轮转，避免无限增长）
LOG_FILE_BACKUP = 5                       # 保留 5 个历史备份
LOG_ENCODING = "utf-8"
LOG_STDOUT = False
LOG_SHORT_NAMES = False

LOG_FORMAT = "%(asctime)s [%(name)s] %(levelname)s: %(message)s"
LOG_DATEFORMAT = "%Y-%m-%d %H:%M:%S"

import sys
import logging
import logging.handlers

root_logger = logging.getLogger()
root_logger.setLevel(logging.INFO)

for handler in root_logger.handlers[:]:
    root_logger.removeHandler(handler)

console_handler = logging.StreamHandler(sys.stdout)
console_handler.setLevel(logging.INFO)
console_handler.setFormatter(logging.Formatter(LOG_FORMAT, datefmt=LOG_DATEFORMAT))
root_logger.addHandler(console_handler)

# 健壮性 L1：按大小轮转，避免 scrapy.log 长期运行无限增长撑爆磁盘
file_handler = logging.handlers.RotatingFileHandler(
    LOG_FILE, maxBytes=LOG_FILE_MAX_BYTES, backupCount=LOG_FILE_BACKUP, encoding=LOG_ENCODING
)
file_handler.setLevel(logging.INFO)
file_handler.setFormatter(logging.Formatter(LOG_FORMAT, datefmt=LOG_DATEFORMAT))
root_logger.addHandler(file_handler)

logging.getLogger('urllib3').setLevel(logging.WARNING)
logging.getLogger('urllib3.connectionpool').setLevel(logging.WARNING)
logging.getLogger('DrissionPage').setLevel(logging.WARNING)
logging.getLogger('py.warnings').setLevel(logging.WARNING)
# 确保 spider 日志正常输出
logging.getLogger('jdproduct').setLevel(logging.INFO)
logging.getLogger('jdcrawler').setLevel(logging.INFO)

# ==================== 其他设置 ====================
FEED_EXPORT_ENCODING = "utf-8"
RETRY_ENABLED = True
RETRY_TIMES = 3
RETRY_HTTP_CODES = [500, 502, 503, 504, 408, 429]
DOWNLOAD_TIMEOUT = 120
