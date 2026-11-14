# -*- coding: utf-8 -*-
"""
京东商品详情页爬虫（完整数据提取版 v1.0）
功能：按数据库表结构提取商品完整数据，包括图片、参数、SKU、评论
特点：支持获取228/800/1440三种尺寸图片、反爬措施、验证码检测、人工验证
核心策略：所有DOM提取通过 run_js 在浏览器中执行，适配React SSR动态class名
作者：AI Assistant
日期：2026-05-22
"""

import re
import os
import json
import time
import random
import requests
from datetime import datetime
from DrissionPage import ChromiumPage, ChromiumOptions


# 项目根目录：本文件位于 scripts/ 下，其父目录即项目根。
# 所有运行产物（data/、images/）统一落在此根，避免依赖 cwd 或 __file__ 所在目录，
# 否则从 scripts/ 直接运行时会生成 scripts/data、scripts/images 等错位目录，
# 与 .gitignore 及离线导入的默认路径（项目根 data/）不一致。
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _relpath_to_root(path):
    """把绝对保存路径转成相对项目根的可移植形式（如 'images/100x/cover/cover.jpg'）。"""
    if not path:
        return path
    try:
        return os.path.relpath(path, PROJECT_ROOT)
    except ValueError:
        return path


class JdProductDetailSpider:
    """
    京东商品详情页通用爬虫类

    特点：
    1. 支持任意京东商品（item.jd.com/*）
    2. 支持获取228/800/1440三种尺寸的轮播图
    3. 所有DOM数据提取通过 run_js 在浏览器中执行JS脚本
    4. 适配React SSR动态class名

    输出数据结构：
        - products（商品主表）
        - product_skus（SKU规格表）
        - product_comments（商品评论表）
    """

    USER_AGENTS = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Edg/119.0.0.0',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ]

    RANDOM_TAGS = ['热销', '新品', '推荐', '包邮', '正品', '限时优惠', '品质保障']

    def __init__(self, product_url=None, enable_anti_detect=True,
                 wait_for_manual_verify=True, image_save_dir="images",
                 max_comments=None, scroll_pause=0.8, download_images=True):
        """初始化爬虫

        Args:
            product_url: 京东商品URL，如 https://item.jd.com/100012043978.html
            enable_anti_detect: 是否启用反检测（默认True）
            wait_for_manual_verify: 遇到验证码是否等待人工验证（默认True）
            image_save_dir: 图片保存目录（默认"images"）
            max_comments: 目标评论抓取数量（None 或 <=0 时用随机 20~50 条，向后兼容）
            scroll_pause: 详情图慢速滚动时每屏停顿秒数（默认 0.8，越大越慢越稳）
            download_images: 是否把图片下载到本地（默认 True）；置 False 则只记录 URL 不落盘，
                             抓取更快、省磁盘，但数据库里只会有远程地址、无本地路径。
        """
        self.product_url = product_url
        if not self.product_url:
            raise ValueError("必须提供product_url参数，如: https://item.jd.com/100012043978.html")
        self.enable_anti_detect = enable_anti_detect
        self.wait_for_manual_verify = wait_for_manual_verify
        # 图片保存目录：相对路径视为相对于项目根（PROJECT_ROOT），统一落点，
        # 避免从 scripts/ 直接运行时生成 scripts/images 错位目录
        self.image_save_dir = image_save_dir if os.path.isabs(image_save_dir) else os.path.join(PROJECT_ROOT, image_save_dir)
        self.max_comments = max_comments
        self.scroll_pause = scroll_pause if scroll_pause and scroll_pause > 0 else 0.8
        self.download_images = download_images
        self.page = None
        self.current_user_agent = random.choice(self.USER_AGENTS)
        # requests会话（用于评论API等HTTP请求）
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': self.current_user_agent,
        })

        # 从URL中提取SKU ID
        match = re.search(r'/(\d+)\.html', self.product_url)
        self.sku_id = match.group(1) if match else "unknown"

        os.makedirs(self.image_save_dir, exist_ok=True)

        print(f"[初始化] 目标URL: {self.product_url}")
        print(f"[初始化] SKU ID: {self.sku_id}")

    # ==================== 反爬措施 ====================

    def _random_delay(self, min_s=5, max_s=15):
        """随机延迟，模拟人类操作间隔（账号被ban后大幅增加延迟）"""
        delay = random.uniform(min_s, max_s)
        print(f"[反爬] 延迟 {delay:.1f}s")
        time.sleep(delay)

    def _init_browser(self):
        """
        初始化浏览器（带反检测）

        关键改进：
        1. 移除 --disable-web-security（红旗标志）
        2. 使用更真实的窗口大小
        3. 注入更完善的反检测JS（覆盖webdriver/plugins/chrome/permissions等）
        4. 添加Canvas/WebGL指纹伪装
        5. 添加更多真实浏览器参数
        """
        print("[浏览器] 初始化中...")
        co = ChromiumOptions()
        if self.enable_anti_detect:
            co.set_user_agent(user_agent=self.current_user_agent)
            co.set_argument('--lang=zh-CN')
            # 使用常见的真实分辨率
            co.set_argument('--window-size=1920,1080')
            co.set_argument('--disable-blink-features=AutomationControlled')
            # 注意：不要加 --disable-web-security，这是自动化浏览器的红旗标志
            # 不要加 --headless，京东会检测无头模式
            co.set_argument('--disable-gpu')
            # 禁用一些可能暴露自动化的特性
            co.set_argument('--disable-infobars')
            co.set_argument('--no-first-run')
            co.set_argument('--no-default-browser-check')
            # 新增：模拟真实用户行为
            co.set_argument('--disable-extensions')
            co.set_argument('--disable-dev-shm-usage')
            co.set_argument('--disable-setuid-sandbox')
            co.set_argument('--no-sandbox')
            # 新增：设置时区和地理位置
            co.set_argument('--timezone=Asia/Shanghai')
            co.set_argument('--geolocation=39.9042,116.4074')  # 北京坐标

        page = ChromiumPage(co)

        if self.enable_anti_detect:
            # 注入全面的反检测脚本
            page.run_js("""
                // 1. 隐藏 webdriver 标志
                Object.defineProperty(navigator, 'webdriver', {
                    get: () => undefined
                });

                // 2. 伪装 plugins（模拟真实Chrome的插件列表）
                Object.defineProperty(navigator, 'plugins', {
                    get: () => {
                        var plugins = [
                            {name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format'},
                            {name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: ''},
                            {name: 'Native Client', filename: 'internal-nacl-plugin', description: ''}
                        ];
                        plugins.item = function(i) { return this[i]; };
                        plugins.namedItem = function(name) {
                            for (var i = 0; i < this.length; i++) {
                                if (this[i].name === name) return this[i];
                            }
                            return null;
                        };
                        plugins.refresh = function() {};
                        return plugins;
                    }
                });

                // 3. 伪装 chrome 对象（更完整）
                window.chrome = {
                    app: {
                        isInstalled: false,
                        InstallState: {DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed'},
                        RunningState: {CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running'}
                    },
                    runtime: {
                        OnInstalledReason: {CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update'},
                        OnRestartRequiredReason: {APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic'},
                        PlatformArch: {ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64'},
                        PlatformNaclArch: {ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64'},
                        PlatformOs: {ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win'},
                        RequestUpdateCheckStatus: {NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available'},
                        connect: function() { return {onDisconnect: {addListener: function(){}}}; },
                        sendMessage: function() {},
                        id: undefined
                    },
                    csi: function() { return {onLoadT: Date.now(), pageT: Math.random() * 1000, startE: Date.now() - Math.random() * 1000, tran: 15}; },
                    loadTimes: function() { return {commitLoadTime: Date.now()/1000, connectionInfo: 'h2', finishDocumentLoadTime: Date.now()/1000, finishLoadTime: Date.now()/1000, firstPaintAfterLoadTime: 0, firstPaintTime: Date.now()/1000, navigationType: 'Other', npnNegotiatedProtocol: 'h2', requestTime: Date.now()/1000, startLoadTime: Date.now()/1000, wasAlternateProtocolAvailable: false, wasFetchedViaSpdy: true, wasNpnNegotiated: true}; }
                };

                // 4. 伪装 languages
                Object.defineProperty(navigator, 'languages', {
                    get: () => ['zh-CN', 'zh', 'en-US', 'en']
                });

                // 5. 伪装 permissions（自动化浏览器的权限查询行为不同）
                var originalQuery = window.navigator.permissions.query;
                window.navigator.permissions.query = (parameters) => (
                    parameters.name === 'notifications' ?
                        Promise.resolve({state: Notification.permission}) :
                        originalQuery(parameters)
                );

                // 6. 伪装 WebGL 渲染器信息
                var getParameter = WebGLRenderingContext.prototype.getParameter;
                WebGLRenderingContext.prototype.getParameter = function(parameter) {
                    if (parameter === 37445) return 'Google Inc. (NVIDIA)';
                    if (parameter === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
                    return getParameter.call(this, parameter);
                };

                // 7. 伪装 Canvas 指纹（添加微小噪声）
                var toDataURL = HTMLCanvasElement.prototype.toDataURL;
                HTMLCanvasElement.prototype.toDataURL = function(type) {
                    if (type === 'image/png' && this.width > 16 && this.height > 16) {
                        var ctx = this.getContext('2d');
                        if (ctx) {
                            var style = ctx.fillStyle;
                            ctx.fillStyle = 'rgba(0,0,1,0.003)';
                            ctx.fillRect(0, 0, 1, 1);
                            ctx.fillStyle = style;
                        }
                    }
                    return toDataURL.apply(this, arguments);
                };

                // 8. 伪装硬件并发数
                Object.defineProperty(navigator, 'hardwareConcurrency', {
                    get: () => 8
                });

                // 9. 伪装 deviceMemory
                Object.defineProperty(navigator, 'deviceMemory', {
                    get: () => 8
                });

                // 10. 伪装 platform
                Object.defineProperty(navigator, 'platform', {
                    get: () => 'Win32'
                });

                // 11. 伪装 vendor
                Object.defineProperty(navigator, 'vendor', {
                    get: () => 'Google Inc.'
                });

                // 12. 伪装 maxTouchPoints
                Object.defineProperty(navigator, 'maxTouchPoints', {
                    get: () => 0
                });

                // 13. 伪装 PDF viewer enabled
                Object.defineProperty(navigator, 'pdfViewerEnabled', {
                    get: () => true
                });

                // 14. 删除 webdriver 相关属性
                delete navigator.__proto__.webdriver;

                // 15. 伪装 Notification 权限
                if (window.Notification) {
                    Object.defineProperty(Notification, 'permission', {
                        get: () => 'default'
                    });
                }

                // 16. 添加假的浏览器历史记录痕迹
                if (window.history) {
                    Object.defineProperty(history, 'length', {
                        get: () => Math.floor(Math.random() * 10) + 2
                    });
                }
            """)

        return page

    def _warm_up(self):
        """
        预热浏览器：模拟真实用户从首页进入

        关键步骤：
        1. 先访问京东首页，建立Cookie和会话
        2. 随机浏览一下首页内容
        3. 模拟搜索或点击分类
        4. 然后再跳转到商品详情页

        这样京东会认为这是一个正常的用户浏览行为
        """
        print("[预热] 访问京东首页...")
        try:
            # 先访问京东首页
            self.page.get("https://www.jd.com")
            time.sleep(random.uniform(8, 15))  # 增加首页等待时间

            # 检查是否成功加载首页
            current_url = self.page.url
            if 'jd.com' not in current_url:
                print(f"[预热] 首页加载异常: {current_url}")
                return

            # 检查是否被拦截
            if self._check_page_redirected():
                print("[预热] 首页被拦截")
                return

            # 模拟人类浏览：随机滚动（更自然的滚动）
            scroll_positions = sorted([random.randint(100, 300), random.randint(400, 700), random.randint(800, 1200)])
            for pos in scroll_positions:
                self.page.run_js(f"window.scrollTo({{top: {pos}, behavior: 'smooth'}});")
                time.sleep(random.uniform(1.5, 3.0))

            # 随机移动鼠标（多次，模拟真实浏览）
            for _ in range(random.randint(3, 6)):
                self.page.run_js("""
                    var evt = new MouseEvent('mousemove', {
                        clientX: Math.random() * window.innerWidth,
                        clientY: Math.random() * window.innerHeight,
                        bubbles: true
                    });
                    document.dispatchEvent(evt);
                """)
                time.sleep(random.uniform(0.5, 1.5))

            # 模拟点击某个分类（增加真实感）
            try:
                categories = ['手机', '电脑', '家电', '食品']
                target_cat = random.choice(categories)
                self.page.run_js(f"""
                    var links = document.querySelectorAll('a');
                    for (var i = 0; i < links.length; i++) {{
                        if (links[i].textContent.indexOf('{target_cat}') > -1) {{
                            links[i].dispatchEvent(new MouseEvent('mouseover', {{bubbles: true}}));
                            return true;
                        }}
                    }}
                    return false;
                """)
                time.sleep(random.uniform(1, 2))
            except Exception as e:
                # 模拟点击分类仅为增加真实感，失败不影响主流程（容错）
                print(f"[调试] 模拟点击分类失败（可忽略）: {e}")

            # 滚回顶部
            self.page.run_js("window.scrollTo({top: 0, behavior: 'smooth'});")
            time.sleep(random.uniform(2, 3))

            print("[预热] 完成")

        except Exception as e:
            print(f"[预热] 失败（继续执行）: {e}")

    def _check_page_redirected(self):
        """
        检查页面是否被重定向到首页（403拦截）

        返回:
            bool: True=被重定向（异常），False=正常
        """
        if not self.page:
            return False
        current_url = self.page.url
        # 如果URL包含 reason=403 或者被跳转到 jd.com 首页
        if 'reason=403' in current_url:
            print(f"[反爬检测] 页面被403重定向: {current_url}")
            return True
        # 如果本来应该访问商品页，但实际在首页
        if 'item.jd.com' in self.product_url and current_url.startswith('https://www.jd.com/') and 'item.jd.com' not in current_url:
            print(f"[反爬检测] 页面被重定向到首页: {current_url}")
            return True
        return False

    def _check_for_verification(self):
        """检测验证码（强特征优先，防误报）"""
        if not self.page:
            return False

        # 先检查是否被重定向
        if self._check_page_redirected():
            return True

        # 只检查强特征DOM元素
        for sel in ['.jdcrawlerJRV-slide', '.slide-verify', '#captcha',
                    '#jdcrawlerJRV-wrap', '.jdcrawlerJRV-main', '[class*="captcha"]']:
            try:
                if self.page.eles(sel):
                    print(f"[验证检测] 发现验证元素: {sel}")
                    return True
            except Exception as e:
                # 单个选择器查询失败，跳过并尝试下一个（容错）
                print(f"[调试] 验证元素选择器 {sel} 查询失败（可忽略）: {e}")
                continue
        # 标题只检查组合短语
        title = (self.page.title or '').lower()
        for phrase in ['安全验证', '人机验证', '滑块验证', '验证码', 'captcha']:
            if phrase in title:
                print(f"[验证检测] 标题: {phrase}")
                return True
        return False

    def _wait_for_manual_verification(self):
        """等待人工验证"""
        if not self.wait_for_manual_verify:
            return False
        print("\n" + "!" * 80)
        print("!!! 需要人工验证（可能被403拦截或需要滑块验证） !!!")
        print("!!! 请在浏览器中手动操作完成后按 Enter !!!")
        print("!" * 80 + "\n")
        try:
            input("[等待验证] 按 Enter 继续...")
            time.sleep(3)

            # 验证后重新访问商品页
            if self._check_page_redirected():
                print("[验证] 重新访问商品页...")
                self.page.get(self.product_url)
                time.sleep(5)

            if self._check_for_verification():
                print("[验证] 未完成")
                return False
            print("[验证] 完成")
            return True
        except KeyboardInterrupt:
            return False

    def _simulate_human_behavior(self):
        """模拟人类浏览行为（更真实）"""
        if not self.page:
            return
        try:
            # 随机滚动几次，间隔不等
            positions = sorted([random.randint(100, 400), random.randint(300, 700), random.randint(500, 900)])
            for pos in positions:
                self.page.run_js(f"window.scrollTo({{top: {pos}, behavior: 'smooth'}});")
                time.sleep(random.uniform(0.8, 2.0))

            # 模拟鼠标移动
            self.page.run_js("""
                for (var i = 0; i < 3; i++) {
                    (function(delay) {
                        setTimeout(function() {
                            var evt = new MouseEvent('mousemove', {
                                clientX: Math.random() * window.innerWidth,
                                clientY: Math.random() * window.innerHeight,
                                bubbles: true
                            });
                            document.dispatchEvent(evt);
                        }, delay);
                    })(i * 300);
                }
            """)
            time.sleep(1)

            # 滚回顶部
            self.page.run_js("window.scrollTo({top: 0, behavior: 'smooth'});")
            time.sleep(random.uniform(0.5, 1.0))
        except Exception as e:
            # 模拟人类行为失败不影响主流程（容错）
            print(f"[调试] 模拟人类行为失败（可忽略）: {e}")

    # ==================== 核心提取：一次性JS脚本（支持多尺寸） ====================

    def _extract_all_by_js(self):
        """
        通过 run_js 在浏览器中执行JS，一次性提取所有DOM数据

        返回:
            dict: 包含 title, price, brand, gallery(多尺寸), attributes, shop, skus 等字段
        """
        js_script = r"""
// 清理URL中的反引号
function cleanUrl(url) {
    if (!url) return '';
    return url.replace(/`/g, '').trim();
}

var result = {
    title: '',
    price: '',
    original_price: '',
    brand: '',
    shop_name: '',
    category_id: 0,  // 3级分类ID
    gallery: [],
    attributes: [],
    sku_options: [],
    detail_image_count: 0,
    raw_param_text: ''
};

// ===== 1. 提取标题 =====
// 优先从页面DOM中提取（避免document.title包含多余后缀如【行情 报价 价格 评测】）
// 标题特征：包含商品关键词，长度10-100字符，不包含"计算器"等工具类词汇
function isValidTitle(text) {
    if (!text) return false;
    text = text.trim();
    // 长度检查
    if (text.length < 10 || text.length > 100) return false;
    // 排除明显的非标题内容
    if (/计算器|工具|脚本|插件|广告|推荐|热门/.test(text)) return false;
    // 标题应该包含商品特征（数字、单位、品牌等）
    if (!/[\d%ml克瓶箱]/.test(text)) return false;
    return true;
}

// 策略1：查找所有h1标签，选择符合标题特征的
var h1Els = document.querySelectorAll('h1');
for (var hi = 0; hi < h1Els.length; hi++) {
    var h1Text = h1Els[hi].textContent.trim();
    if (isValidTitle(h1Text)) {
        result.title = h1Text;
        break;
    }
}

// 策略2：使用京东特定的商品名称选择器
if (!result.title) {
    var jdTitleSelectors = [
        '.sku-name',  // 京东商品页常用
        '.itemInfo-wrap .name',  // 商品信息区名称
        '#name h1',  // 商品名称h1
        '.product-intro .name'  // 商品介绍区名称
    ];
    for (var ti = 0; ti < jdTitleSelectors.length; ti++) {
        var titleEl = document.querySelector(jdTitleSelectors[ti]);
        if (titleEl && isValidTitle(titleEl.textContent)) {
            result.title = titleEl.textContent.trim();
            break;
        }
    }
}

// 策略3：从document.title中提取（去除多余后缀）
if (!result.title) {
    var docTitle = (document.title || '').replace(/\s*[-_|—].*$/, '').trim();
    if (isValidTitle(docTitle)) {
        result.title = docTitle;
    }
}

// 清理标题中的多余后缀
if (result.title) {
    result.title = result.title.replace(/【行情.*$/, '').trim();
}

// ===== 1.5 提取分类ID（3级分类）=====
// 京东商品页分类ID通常在面包屑导航或页面URL中
// 策略1：从面包屑导航提取第3级分类
var breadcrumbEls = document.querySelectorAll('.breadcrumb a, .crumb a, [class*="breadcrumb"] a, [class*="crumb"] a');
if (breadcrumbEls.length >= 3) {
    // 取第3个（索引2）作为3级分类
    var thirdCatEl = breadcrumbEls[2];
    var catHref = thirdCatEl.getAttribute('href') || '';
    var catMatch = catHref.match(/cat[=,](\d+)/);
    if (catMatch) {
        result.category_id = parseInt(catMatch[1]);
    }
}
// 策略2：从页面URL参数提取
if (!result.category_id) {
    var urlParams = new URLSearchParams(window.location.search);
    var catIdFromUrl = urlParams.get('cat') || urlParams.get('category');
    if (catIdFromUrl) {
        result.category_id = parseInt(catIdFromUrl);
    }
}
// 策略3：从页面源码中的变量提取（京东通常在页面中嵌入cat参数）
if (!result.category_id) {
    var pageHtml = document.documentElement.innerHTML;
    var catIdMatch = pageHtml.match(/"cat":\s*"?(\d+)"?/);
    if (catIdMatch) {
        result.category_id = parseInt(catIdMatch[1]);
    }
}

// ===== 2. 提取价格 =====
var currentPrice = '';
var allEls = document.querySelectorAll('*');
for (var i = 0; i < allEls.length; i++) {
    var directText = '';
    for (var j = 0; j < allEls[i].childNodes.length; j++) {
        if (allEls[i].childNodes[j].nodeType === 3) directText += allEls[i].childNodes[j].textContent;
    }
    directText = directText.trim();
    var match = directText.match(/^[¥￥]\s*([\d.]+)$/);
    if (match && parseFloat(match[1]) > 0) { currentPrice = match[1]; break; }
}
if (!currentPrice) {
    for (var i = 0; i < allEls.length; i++) {
        var text = allEls[i].textContent.trim();
        var m = text.match(/[¥￥]\s*([\d.]+)/);
        if (m && text.length < 20 && parseFloat(m[1]) > 0) { currentPrice = m[1]; break; }
    }
}
result.price = currentPrice;

// ===== 3. 提取品牌和参数 =====
// 注：allEls已在前面定义
result.attributes = [];
var paramText = '';

// 点击"店铺"标签以加载参数区域（使用多种选择器兼容）
var shopTab = null;
var tabSelectors = [
    '.left-tabs-title li', '.left-tabs-title [class*="tab"]',
    '[class*="tab-title"] li', '[class*="tab-title"] [class*="item"]'
];
for (var si = 0; si < tabSelectors.length && !shopTab; si++) {
    var tabs = document.querySelectorAll(tabSelectors[si]);
    for (var ti = 0; ti < tabs.length; ti++) {
        if (tabs[ti].textContent.trim() === '店铺' && tabs[ti].tagName !== 'A') {
            shopTab = tabs[ti];
            break;
        }
    }
}
// 兜底：遍历所有元素查找
if (!shopTab) {
    for (var i = 0; i < allEls.length; i++) {
        var text = allEls[i].textContent || '';
        if (text.trim() === '店铺' && allEls[i].tagName !== 'A') {
            shopTab = allEls[i];
            break;
        }
    }
}
if (shopTab) {
    shopTab.click();
}

// ===== 策略1（优先）：从规整参数区域提取 =====
// DOM结构（双栏参数表）：
//   div.item 内部有两个子元素：标签和值
//   例如：<div class="item"><span>品牌</span><span>华硕（ASUS）</span></div>
//   或者：<div class="item">品牌华硕（ASUS）</div>（纯文本形式）
var itemParams = [];

// 尝试多个选择器找到参数容器
var containerSelectors = [
    '.attribute .list',       // 主图下方的参数列表
    '.left-tabs-item .attrs', // 店铺标签页下的完整参数列表
    '.attrs'                  // 通用兜底
];

for (var cs = 0; cs < containerSelectors.length; cs++) {
    var containers = document.querySelectorAll(containerSelectors[cs]);
    for (var ci = 0; ci < containers.length; ci++) {
        var container = containers[ci];
        var items = container.querySelectorAll('.item');
        if (items.length < 1) continue;

        for (var it = 0; it < items.length; it++) {
            var item = items[it];
            var itemText = (item.textContent || '').trim();
            if (!itemText || itemText.length < 2) continue;

            // 方法1：精确选择器（根据用户提供的HTML结构）
            // <div class="item">
            //   <div class="label"><span class="text"> 品牌</span></div>
            //   <div class="value"><div class="text" title="华硕（ASUS）">华硕（ASUS）</div></div>
            // </div>
            var pName = '';
            var pValue = '';

            var labelEl = item.querySelector('.label .text');
            var valueEl = item.querySelector('.value .text');

            if (labelEl && valueEl) {
                pName = (labelEl.textContent || '').trim();
                // 优先用title属性，更完整
                pValue = (valueEl.getAttribute('title') || valueEl.textContent || '').trim();
            }

            // 方法2：如果上面没拿到，用子元素方式
            if (!pName || !pValue) {
                var children = item.children;
                if (children.length >= 2) {
                    pName = (children[0].textContent || '').trim();
                    pValue = (children[1].textContent || '').trim();
                }
            }

            // 方法3：用冒号分割
            if (!pName && itemText.indexOf('：') > 0) {
                var colonIdx = itemText.indexOf('：');
                if (colonIdx > 0 && colonIdx <= 10) {
                    pName = itemText.substring(0, colonIdx).trim();
                    pValue = itemText.substring(colonIdx + 1).trim();
                }
            }

            // 过滤无效参数
            if (!pName || !pValue || pValue.length === 0 || pValue.length > 200) continue;
            if (pName === '查看' || pName === '参数' || pName === '详情') continue;

            // 全部保留，不去重（同名参数如"产品净重"可能出现多次，值不同）
            itemParams.push({name: pName, value: pValue});
            // 特殊处理品牌
            if (pName === '品牌') {
                result.brand = pValue;
            }
        }
    }
}

// 如果策略1成功，直接使用
if (itemParams.length >= 2) {
    for (var ip = 0; ip < itemParams.length; ip++) {
        result.attributes.push({group: '基础信息', name: itemParams[ip].name, value: itemParams[ip].value});
    }
}

// ===== 策略2（兜底）：从连续文本中用正则提取 =====
if (itemParams.length < 2) {
    // 查找包含"品牌"+"商品编号"+"保质期"的元素
    for (var i = 0; i < allEls.length; i++) {
        var el = allEls[i];
        var t = (el.textContent || '').trim();
        if (t.indexOf('品牌') > -1 && t.indexOf('商品编号') > -1 && t.indexOf('保质期') > -1 && t.length < 1500) {
            if (t.indexOf('口感') === -1 && t.indexOf('好喝') === -1 && t.indexOf('香气') === -1 && t.indexOf('终于') === -1) {
                paramText = t;
                break;
            }
        }
    }
    if (!paramText) {
        for (var i = 0; i < allEls.length; i++) {
            var el = allEls[i];
            var t = (el.textContent || '').trim();
            if (t.indexOf('品牌') > -1 && t.indexOf('商品编号') > -1 && t.length < 2000) {
                if (t.indexOf('非常') === -1 && t.indexOf('终于') === -1) {
                    paramText = t;
                    break;
                }
            }
        }
    }

    result.raw_param_text = paramText;

    if (paramText) {
        paramText = paramText.replace(/\d{1,2}:\d{2}\s*\/\s*\d{1,2}:\d{2}/g, '');
        paramText = paramText.replace(/\d{1,2}:\d{2}/g, '');
        paramText = paramText.replace(/查看全部参数/g, '');
        paramText = paramText.replace(/\s+/g, ' ').trim();

        var paramPatterns = [
            {name: '品牌', regex: /品牌[：:\s]*([（\(\u3010\[?[^）\)\]】\n]{1,15})/},
            {name: '商品编号', regex: /商品编号[：:\s]*(\d{6,})/},
            {name: '保质期', regex: /保质期[：:\s]*([^\s\n]{1,10}?)(?=(?:产地|品牌|商品编号|包装|系列|规格|$))/},
            {name: '产地', regex: /产地[：:\s]*([^\s\n]{2,15}?)(?=(?:品牌|商品编号|包装|保质期|系列|规格|$))/},
            {name: '包装形式', regex: /包装形式[：:\s]*([^\s\n]{2,12})/},
            {name: '包装清单', regex: /包装清单[：:\s]*([^\s\n]{2,50})/},
            {name: '香型', regex: /香型[：:\s]*([^\s\n]{2,8})/},
            {name: '规格', regex: /规格[：:\s]*([^\s\n]{2,30})/},
            {name: '系列', regex: /系列[：:\s]*([^\s\n]{2,15})/},
            {name: '适用场景', regex: /适用场景[：:\s]*([^\s\n]{2,20})/},
            {name: '度数', regex: /度数[：:\s]*(\d+\s*度)/},
            {name: '容量', regex: /(?:容量|净含量)[：:\s]*(\d+\s*(?:ml|ML|mL|Ml|克|g|G|kg|KG|L|l|升)?)/}
        ];

        var extractedParams = {};

        for (var p = 0; p < paramPatterns.length; p++) {
            var pattern = paramPatterns[p];
            var match = paramText.match(pattern.regex);
            if (match && match[1]) {
                var value = match[1].trim();
                value = value.replace(/^[：:\s]+/, '').replace(/[：:\s]+$/, '').trim();
                if (value && value.length >= 1 && value.length < 50) {
                    var invalidPatterns = ['规格参数', '查看全部', '终于', '非常', '不错', '好喝'];
                    var isInvalid = false;
                    for (var inv = 0; inv < invalidPatterns.length; inv++) {
                        if (value.indexOf(invalidPatterns[inv]) > -1 && value.length > 8) {
                            isInvalid = true;
                            break;
                        }
                    }
                    if (!isInvalid && !extractedParams[pattern.name]) {
                        extractedParams[pattern.name] = value;
                        result.attributes.push({group: '基础信息', name: pattern.name, value: value});
                        if (pattern.name === '品牌') {
                            result.brand = value;
                        }
                    }
                }
            }
        }
    }
}

// ===== 4. 提取轮播图（基于精准DOM结构） =====
// DOM分析结果：
//   缩略图：div.image-carousel-track > div.item > img.image
//   主图：img#spec-img.zoom-img（在div#spec-n1.stage内）
//   容器：div[class*="_gallery_"] 或 div.image-carousel

function genMultiSizeUrls(originalSrc) {
    if (!originalSrc || originalSrc.indexOf('360buyimg') === -1) return null;
    var sizes = [
        {key: 's1440x1440', label: '1440'},
        {key: 's800x800', label: '800'},
        {key: 's228x228', label: '228'}
    ];
    var results = [];
    for (var i = 0; i < sizes.length; i++) {
        var size = sizes[i];
        var newUrl = originalSrc.replace(/\/s\d+x\d+_[^/]+\//, '/' + size.key + '_jfs/');
        newUrl = newUrl.replace(/\/s\d+x\d+\//, '/' + size.key + '/');
        results.push({size: size.label, url: newUrl});
    }
    return results;
}

var galleryImages = [];
var seenGallery = {};

// 策略1：从轮播图缩略图列表提取（最精准）
var carouselTracks = document.querySelectorAll('.image-carousel-track, [class*="image-carousel-track"]');
for (var t = 0; t < carouselTracks.length; t++) {
    var trackItems = carouselTracks[t].querySelectorAll('.item');
    for (var i = 0; i < trackItems.length; i++) {
        var itemImg = trackItems[i].querySelector('img');
        if (!itemImg) continue;
        // 排除播放图标等工具图
        if (itemImg.className && (itemImg.className.indexOf('play') > -1 || itemImg.className.indexOf('icon') > -1)) continue;
        var src = cleanUrl(itemImg.getAttribute('data-origin') || itemImg.getAttribute('data-src') || itemImg.getAttribute('src') || '');
        if (!src || src.indexOf('360buyimg') === -1 || src.indexOf('jfs') === -1) continue;
        if (src.indexOf('shaidan') > -1) continue;
        if (src.indexOf('imagetools') > -1) continue;
        if (src.indexOf('//') === 0) src = 'https:' + src;
        var multiSizes = genMultiSizeUrls(src);
        if (!multiSizes) continue;
        var baseUrl = multiSizes[0].url;
        if (seenGallery[baseUrl]) continue;
        seenGallery[baseUrl] = true;
        galleryImages.push(multiSizes);
    }
    if (galleryImages.length > 0) break;
}

// 策略2：从 _gallery_ 容器中查找
if (galleryImages.length === 0) {
    var galleryContainers = document.querySelectorAll('[class*="_gallery_"]');
    for (var g = 0; g < galleryContainers.length; g++) {
        var imgs = galleryContainers[g].querySelectorAll('img');
        for (var i = 0; i < imgs.length; i++) {
            var src = cleanUrl(imgs[i].getAttribute('data-origin') || imgs[i].getAttribute('data-src') || imgs[i].getAttribute('src') || '');
            if (!src || src.indexOf('360buyimg') === -1 || src.indexOf('jfs') === -1) continue;
            if (src.indexOf('shaidan') > -1 || src.indexOf('imagetools') > -1) continue;
            if (src.indexOf('//') === 0) src = 'https:' + src;
            var multiSizes = genMultiSizeUrls(src);
            if (!multiSizes) continue;
            var baseUrl = multiSizes[0].url;
            if (seenGallery[baseUrl]) continue;
            seenGallery[baseUrl] = true;
            galleryImages.push(multiSizes);
        }
        if (galleryImages.length > 0) break;
    }
}

// 策略3：兜底 - 查找pcpubliccms路径的正方形图片
if (galleryImages.length === 0) {
    var allImgs2 = document.querySelectorAll('img');
    for (var i = 0; i < allImgs2.length; i++) {
        var src = cleanUrl(allImgs2[i].getAttribute('data-origin') || allImgs2[i].getAttribute('data-src') || allImgs2[i].getAttribute('src') || '');
        if (!src || src.indexOf('pcpubliccms') === -1 || src.indexOf('jfs') === -1) continue;
        var sizeMatch = src.match(/\/s(\d+)x(\d+)/);
        if (!sizeMatch) continue;
        var w = parseInt(sizeMatch[1]), h = parseInt(sizeMatch[2]);
        if (w < 228 || h < 228 || Math.abs(w - h) > 100) continue;
        if (src.indexOf('//') === 0) src = 'https:' + src;
        var multiSizes = genMultiSizeUrls(src);
        if (!multiSizes) continue;
        var baseUrl = multiSizes[0].url;
        if (seenGallery[baseUrl]) continue;
        seenGallery[baseUrl] = true;
        galleryImages.push(multiSizes);
    }
}

result.gallery = galleryImages;
result.debug_gallery_count = galleryImages.length;

// ===== 4.5 提取商品视频（合并到轮播图gallery中）=====
// 京东商品视频通常在轮播图区域内，是轮播图的第一个元素
// 将视频作为gallery的第一项插入，而不是单独存储
result.video_url = '';
var videoUrl = '';

// 策略1：查找video标签的src属性
var videoTags = document.querySelectorAll('video');
for (var vi = 0; vi < videoTags.length; vi++) {
    var vSrc = videoTags[vi].getAttribute('src') || videoTags[vi].getAttribute('data-src') || '';
    if (vSrc && vSrc.indexOf('.mp4') > -1) {
        videoUrl = cleanUrl(vSrc);
        break;
    }
    // 检查source子标签
    var sources = videoTags[vi].querySelectorAll('source');
    for (var si = 0; si < sources.length; si++) {
        var sSrc = sources[si].getAttribute('src') || '';
        if (sSrc && sSrc.indexOf('.mp4') > -1) {
            videoUrl = cleanUrl(sSrc);
            break;
        }
    }
    if (videoUrl) break;
}

// 策略2：在轮播图容器中查找视频相关元素
if (!videoUrl) {
    var galleryAreas = document.querySelectorAll('[class*="_gallery_"], .image-carousel, .stage');
    for (var ga = 0; ga < galleryAreas.length; ga++) {
        var area = galleryAreas[ga];
        var areaLinks = area.querySelectorAll('a[href*=".mp4"], a[href*="vod."], a[href*="video"]');
        for (var al = 0; al < areaLinks.length; al++) {
            var aHref = areaLinks[al].getAttribute('href') || '';
            if (aHref && aHref.indexOf('.mp4') > -1) {
                videoUrl = cleanUrl(aHref);
                break;
            }
        }
        if (videoUrl) break;

        var videoDataEls = area.querySelectorAll('[data-video], [data-video-url], [data-url*=".mp4"]');
        for (var vd = 0; vd < videoDataEls.length; vd++) {
            var dvUrl = videoDataEls[vd].getAttribute('data-video') ||
                        videoDataEls[vd].getAttribute('data-video-url') ||
                        videoDataEls[vd].getAttribute('data-url') || '';
            if (dvUrl && dvUrl.indexOf('.mp4') > -1) {
                videoUrl = cleanUrl(dvUrl);
                break;
            }
        }
        if (videoUrl) break;
    }
}

// 策略3：从页面所有元素中搜索视频URL（通用兜底）
if (!videoUrl) {
    var allMediaEls = document.querySelectorAll('[src*=".mp4"], [data-src*=".mp4"], [data-url*=".mp4"], [data-video*=".mp4"]');
    for (var me = 0; me < allMediaEls.length; me++) {
        var mSrc = allMediaEls[me].getAttribute('src') ||
                   allMediaEls[me].getAttribute('data-src') ||
                   allMediaEls[me].getAttribute('data-url') ||
                   allMediaEls[me].getAttribute('data-video') || '';
        if (mSrc && mSrc.indexOf('.mp4') > -1) {
            videoUrl = cleanUrl(mSrc);
            break;
        }
    }
}

// 策略4：从页面源码中正则匹配视频URL（最终兜底）
if (!videoUrl) {
    var pageHtml = document.documentElement.innerHTML;
    var videoMatch = pageHtml.match(/https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/);
    if (videoMatch) {
        videoUrl = videoMatch[0];
    }
}

// 补全协议头
if (videoUrl && videoUrl.indexOf('//') === 0) {
    videoUrl = 'https:' + videoUrl;
}

// 将视频作为gallery的第一项插入（视频在轮播图中排在最前面）
if (videoUrl) {
    result.video_url = videoUrl;
    result.gallery.unshift([{"type": "video", "url": videoUrl, "size": "video"}]);
}

// ===== 5. 提取店铺 =====
// 根据用户提供的HTML结构精确定位：
// <div class="base shop-plugin" data-shopid="1000000182">
//   <img class="top-logo" src="...">
//   <div class="top-name" title="华硕京东自营官方旗舰店">华硕京东自营官方旗舰店</div>
// </div>
result.shop_id = '';
result.shop_logo = '';

var shopPlugin = document.querySelector('.shop-plugin');
if (shopPlugin) {
    // 店铺ID
    result.shop_id = shopPlugin.getAttribute('data-shopid') || '';
    
    // 店铺Logo
    var logoEl = shopPlugin.querySelector('.top-logo');
    if (logoEl) {
        result.shop_logo = logoEl.getAttribute('src') || '';
        if (result.shop_logo.indexOf('//') === 0) result.shop_logo = 'https:' + result.shop_logo;
    }
    
    // 店铺名（优先用title属性，更完整）
    var nameEl = shopPlugin.querySelector('.top-name');
    if (nameEl) {
        result.shop_name = nameEl.getAttribute('title') || nameEl.textContent.trim() || '';
    }
}

// 兜底：如果上面没找到
if (!result.shop_name) {
    var nameEl2 = document.querySelector('.top-name[title]');
    if (nameEl2) {
        result.shop_name = nameEl2.getAttribute('title') || '';
    }
}

// ===== 6. SKU选项 =====
// 根据用户提供的HTML结构精确定位：
// <div class="page-right-spec">
//   <div class="specification-series-layout"> 系列品 </div>
//   <div class="specifications-panel-content">
//     <div class="specification-group"> 处理器或显卡/存储/屏幕规格 </div>
//   </div>
// </div>
var skuGroups = [];
var seenSku = {};

// 策略1：精确定位 .page-right-spec 容器
var specContainer = document.querySelector('.page-right-spec');
if (specContainer) {
    // 1. 提取"系列品"区域
    var seriesLayout = specContainer.querySelector('.specification-series-layout');
    if (seriesLayout) {
        var seriesLabel = '';
        var labelEl = seriesLayout.querySelector('.layout-label');
        if (labelEl) seriesLabel = labelEl.textContent.trim();

        var seriesOptions = [];
        var seriesItems = seriesLayout.querySelectorAll('.specification-series-item');
        for (var si = 0; si < seriesItems.length; si++) {
            var item = seriesItems[si];
            var textEl = item.querySelector('.specification-series-item-text');
            var optText = textEl ? textEl.textContent.trim() : item.textContent.trim();

            if (!optText || optText.length < 2) continue;

            var isSelected = item.className.indexOf('selected') > -1;

            if (!seenSku[optText]) {
                seenSku[optText] = true;
                seriesOptions.push({
                    name: optText,
                    image: '',
                    disabled: false,
                    selected: isSelected
                });
            }
        }

        if (seriesOptions.length > 0) {
            skuGroups.push({
                label: seriesLabel || '系列品',
                options: seriesOptions
            });
        }
    }

    // 2. 提取其他规格组（处理器或显卡/存储/屏幕规格）
    var specGroups = specContainer.querySelectorAll('.specification-group');
    for (var gi = 0; gi < specGroups.length; gi++) {
        var group = specGroups[gi];

        // 获取分组标签
        var groupLabelEl = group.querySelector('.specification-group-label');
        var groupLabel = groupLabelEl ? groupLabelEl.textContent.trim() : '';

        var groupOptions = [];
        var skuItems = group.querySelectorAll('.specification-item-sku');

        for (var oi = 0; oi < skuItems.length; oi++) {
            var item = skuItems[oi];

            // 获取文本
            var textEl = item.querySelector('.specification-item-sku-text');
            var optText = textEl ? textEl.textContent.trim() : item.textContent.trim();

            if (!optText || optText.length < 2 || optText.length > 100) continue;

            // 获取图片
            var imgEl = item.querySelector('.specification-item-sku-image');
            var imgSrc = '';
            if (imgEl) {
                imgSrc = imgEl.getAttribute('src') || '';
                if (imgSrc.indexOf('//') === 0) imgSrc = 'https:' + imgSrc;
            }

            // 检查选中/禁用状态
            var classStr = item.className || '';
            var isSelected = classStr.indexOf('selected') > -1;
            var isDisabled = classStr.indexOf('disabled') > -1 || /无货|售罄/.test(optText);

            var skuKey = groupLabel ? (groupLabel + ':' + optText) : optText;
            if (!seenSku[skuKey]) {
                seenSku[skuKey] = true;
                groupOptions.push({
                    name: optText,
                    image: imgSrc,
                    disabled: isDisabled,
                    selected: isSelected
                });
            }
        }

        if (groupOptions.length > 0) {
            skuGroups.push({
                label: groupLabel,
                options: groupOptions
            });
        }
    }
}

// 策略2：兜底 - 如果上面没找到，用简单方式提取
if (skuGroups.length === 0) {
    var skuKeywords = ['规格', '系列', '配置', '颜色', '版本', '型号', '尺寸', '容量', '存储'];
    var fallbackOptions = [];
    for (var i = 0; i < allEls.length; i++) {
        var el = allEls[i];
        var text = el.textContent || '';
        var hasKeyword = false;
        for (var kw = 0; kw < skuKeywords.length; kw++) {
            if (text.indexOf(skuKeywords[kw]) > -1) { hasKeyword = true; break; }
        }
        if (hasKeyword && text.length > 5 && text.length < 800) {
            var children = el.querySelectorAll('li, a, span, div, button');
            for (var j = 0; j < children.length; j++) {
                var childText = children[j].textContent.trim();
                if (!childText || childText.length < 2 || childText.length > 50) continue;
                if (/送至|服务|商品|评价|咨询|关注|客服|进店|京东物流/.test(childText)) continue;
                if (/^\d+\.?\d*$/.test(childText)) continue;
                var img = children[j].querySelector('img');
                var imgSrc = '';
                if (img) {
                    imgSrc = cleanUrl(img.getAttribute('src') || img.getAttribute('data-src') || '');
                    if (imgSrc.indexOf('//') === 0) imgSrc = 'https:' + imgSrc;
                }
                if (!seenSku[childText]) {
                    seenSku[childText] = true;
                    fallbackOptions.push({name: childText, image: imgSrc, disabled: false, selected: false});
                }
            }
        }
    }
    if (fallbackOptions.length >= 2) {
        skuGroups.push({label: '', options: fallbackOptions});
    }
}

result.sku_groups = skuGroups;

// ===== 7. 提取服务标签 =====
// <div class="page-right-serviceSupport">
//   <div class="service-support-tag-item">
//     <a/div class="...-text" title="详细说明">服务名</a/div>
//   </div>
// </div>
var services = [];
var serviceContainer = document.querySelector('.page-right-serviceSupport');
if (serviceContainer) {
    var tagItems = serviceContainer.querySelectorAll('.service-support-tag-item');
    for (var sv = 0; sv < tagItems.length; sv++) {
        var tagEl = tagItems[sv];
        // 优先从 a 标签或 .text 元素获取
        var linkEl = tagEl.querySelector('.service-support-tag-item--link');
        var textEl = tagEl.querySelector('.service-support-tag-item--text');
        var targetEl = linkEl || textEl;
        if (targetEl) {
            var svcName = (targetEl.textContent || '').trim();
            var svcDesc = targetEl.getAttribute('title') || '';
            if (svcName) {
                services.push({name: svcName, description: svcDesc});
            }
        }
    }
}
result.services = services;

// ===== 8. 详情图数量 =====
result.detail_image_count = document.querySelectorAll('#detail img, [class*="detail"] img, [class*="Detail"] img').length;

return JSON.stringify(result);
        """

        try:
            raw = self.page.run_js(js_script)
            if raw:
                import json as _json
                data = _json.loads(raw)
                print(f"[提取] 标题: {data.get('title', '')[:50]}...")
                print(f"[提取] 价格: ¥{data.get('price', '未获取')} | 品牌: {data.get('brand', '未获取')} | 轮播图: {len(data.get('gallery', []))} 组")
                return data
        except json.JSONDecodeError as e:
            print(f"[提取] JSON解析失败: {e}")
        except Exception as e:
            print(f"[提取] 执行失败: {e}")
            import traceback
            traceback.print_exc()

        return {}

    def _extract_detail_images_by_js(self):
        """
        通过JS提取详情区域图片

        关键发现：
        - 详情图URL格式：//img30.360buyimg.com/sku/jfs/t1/.../xxx.jpg.avif
        - 展示方式：background-image CSS属性（不是<img>标签）
        - 容器：div.ssd-module 类
        - 特点：没有尺寸标识，原始URL即为高清图
        """
        js_script = r"""
// 清理URL中的反引号
function cleanUrl(url) {
    if (!url) return '';
    return url.replace(/`/g, '').trim();
}

var urls = [];
var seen = {};

// 策略1：查找背景图片（详情图是background-image形式）
var allEls = document.querySelectorAll('*');
for (var i = 0; i < allEls.length; i++) {
    var el = allEls[i];
    var style = window.getComputedStyle(el);
    var bg = style.backgroundImage || el.style.backgroundImage || '';

    if (bg && bg.indexOf('360buyimg') > -1 && bg.indexOf('url(') > -1) {
        // 提取URL
        var match = bg.match(/url\(["']?([^"')]+)["']?\)/);
        if (match) {
            var url = cleanUrl(match[1]);
            // 只取 /sku/jfs/ 路径的详情图
            if (url.indexOf('/sku/jfs/') === -1) continue;
            // 排除已存在的
            if (seen[url]) continue;
            seen[url] = true;
            urls.push({"type": "image", "url": url});
        }
    }
}

// 策略2：兜底 - 从页面下半部分查找所有 /sku/jfs/ 图片
if (urls.length === 0) {
    var pageHeight = document.body.scrollHeight;
    for (var i = 0; i < allEls.length; i++) {
        var el = allEls[i];
        var rect = el.getBoundingClientRect();
        // 详情图在页面30%以下
        if (rect.top < pageHeight * 0.3) continue;

        var style = window.getComputedStyle(el);
        var bg = style.backgroundImage || el.style.backgroundImage || '';

        if (bg && bg.indexOf('360buyimg') > -1 && bg.indexOf('url(') > -1) {
            var match = bg.match(/url\(["']?([^"')]+)["']?\)/);
            if (match) {
                var url = cleanUrl(match[1]);
                if (url.indexOf('/sku/jfs/') === -1) continue;
                if (seen[url]) continue;
                seen[url] = true;
                urls.push({"type": "image", "url": url});
            }
        }
    }
}

return JSON.stringify(urls);
        """

        try:
            raw = self.page.run_js(js_script)
            if raw:
                import json as _json
                urls = _json.loads(raw)
                print(f"[提取] 详情图: {len(urls)} 张")
                return urls  # 现在返回的是多尺寸数组
        except Exception as e:
            print(f"[提取] 详情图提取失败: {e}")

        return []

    def _slow_scroll_to_load(self, pause=None, step_ratio=0.75, max_steps=60):
        """慢速平滑滚动到页面底部，逐屏停留触发懒加载。

        京东详情图是 background-image 懒加载：若直接 scrollTo 瞬跳到页尾（"闪现"），
        中间大段区域来不及进入视口而不会加载，background-image 仍是占位符，最终
        提取到 0 张。这里改成"一屏一屏往下挪、每屏停一会儿"，并在每步后重新读取
        页面高度（懒加载会让页面变长），直到真正到底且高度稳定为止。

        Args:
            pause: 每屏停顿秒数（默认取 self.scroll_pause）
            step_ratio: 每步滚动的视口高度比例（0.75=每次滚 3/4 屏，有重叠更稳）
            max_steps: 最大滚动步数上限（防超长页面死循环）
        """
        if pause is None:
            pause = getattr(self, 'scroll_pause', 0.8) or 0.8
        import json as _json
        try:
            last_height = -1
            stable = 0
            for step in range(max_steps):
                raw = self.page.run_js(
                    "return JSON.stringify({"
                    "y: window.pageYOffset || document.documentElement.scrollTop,"
                    "vh: window.innerHeight,"
                    "h: document.body.scrollHeight});"
                )
                try:
                    st = _json.loads(raw) if raw else {}
                except Exception:
                    st = {}
                y = st.get('y', 0) or 0
                vh = st.get('vh', 800) or 800
                h = st.get('h', 0) or 0

                target = int(y + vh * step_ratio)
                # 平滑滚动（配合停顿让 smooth 动画走完，也给懒加载留时间）
                self.page.run_js("window.scrollTo({top: %d, behavior: 'smooth'});" % target)
                time.sleep(pause)

                # 到底判定：目标已越过文档底部
                if target + vh >= h:
                    # 高度不再增长（懒加载完成）→ 连续 2 轮稳定即停
                    if h == last_height:
                        stable += 1
                        if stable >= 2:
                            break
                    else:
                        stable = 0
                last_height = h

            # 收尾：滚到最底再停一下，触发最后一屏的懒加载图片
            self.page.run_js("window.scrollTo({top: document.body.scrollHeight, behavior: 'smooth'});")
            time.sleep(pause + 0.5)
        except Exception as e:
            print(f"[调试] 慢速滚动加载失败（可忽略）: {e}")

    # ==================== 辅助方法 ====================

    def _extract_comments_via_page(self, max_count=50):
        """
        通过浏览器DOM提取评论（懒加载 + 虚拟滚动）

        实际DOM结构（2026-05-22 实测）：
        - 点击"全部评价"后，评论加载到独立的滚动容器中（不跳转页面）
        - 滚动容器: [class*="rateListContainer"]（overflow:auto，scrollHeight动态增长）
        - 评论卡片: .jdc-pc-rate-card（每条评论一个卡片）
          - .jdc-pc-rate-card-user → 用户信息
            - .jdc-pc-rate-card-nick → 昵称
          - .jdc-pc-rate-card-content → 评论内容区
            - .jdc-pc-rate-card-main-desc → 评论正文
            - 商家回复（文本以"商家："开头）
            - 追评（追加在正文后面）
            - 点赞数（"有用"按钮文本）

        注意：京东使用虚拟滚动，滚出视口的DOM会被回收！
        策略：边滚动边提取，用data属性标记已提取的卡片避免重复

        提取字段：
        - nickname: 用户昵称
        - content: 评论正文
        - rating: 评分（星级）
        - created_at: 评论时间
        - images_json: 评论图片URL列表
        - like_count: 点赞数
        - merchant_reply: 商家回复
        -追加评论: 追评内容
        """
        print(f"[评论] 开始通过浏览器提取评论（目标: {max_count}条）...")

        try:
            # 步骤1：点击"全部评价"按钮
            print("[评论] 点击'全部评价'...")
            js_click = """
            var allBtn = document.querySelector('.comment-root .all-btn');
            if (allBtn) {
                allBtn.click();
                return 'clicked .all-btn';
            }
            var allEls = document.querySelectorAll('*');
            for (var i = 0; i < allEls.length; i++) {
                var t = (allEls[i].textContent || '').trim();
                if (t === '全部评价' && allEls[i].offsetParent !== null) {
                    allEls[i].click();
                    return 'clicked fallback';
                }
            }
            return 'not found';
            """
            self.page.run_js(js_click)
            time.sleep(5)

            # 步骤2：等待滚动容器出现
            for wait_i in range(10):
                container_check = self.page.run_js("""
                    var c = document.querySelector('[class*="rateListContainer"]');
                    return c ? {found: true, scrollHeight: c.scrollHeight} : {found: false};
                """)
                if container_check.get('found'):
                    break
                time.sleep(1)
            else:
                print("[评论] 未找到评论容器，尝试备用方案...")
                # 备用：直接在comment-root的ul.list中提取
                return self._extract_comments_fallback(max_count)

            # 步骤3：在滚动容器内滚动 + 提取评论
            all_comments = []
            scroll_round = 0
            max_rounds = (max_count // 3) + 20  # 预留足够滚动次数
            no_new_streak = 0  # 连续无新评论的轮次

            while len(all_comments) < max_count and scroll_round < max_rounds:
                scroll_round += 1

                # 在滚动容器内滚动
                self.page.run_js("""
                    var container = document.querySelector('[class*="rateListContainer"]');
                    if (container) {
                        container.scrollTop += 500;
                    }
                """)
                time.sleep(random.uniform(1.5, 2.5))

                # 触发懒加载图片：强制加载所有评论卡片内的图片
                self.page.run_js("""
                    var container = document.querySelector('[class*="rateListContainer"]');
                    if (container) {
                        // 触发scroll事件
                        container.dispatchEvent(new Event('scroll'));
                        // 遍历所有未加载的图片，强制触发加载
                        var allImgs = container.querySelectorAll('img');
                        for (var i = 0; i < allImgs.length; i++) {
                            var img = allImgs[i];
                            // 尝试从多个属性获取真实URL
                            var realSrc = img.getAttribute('data-src') ||
                                          img.getAttribute('data-lazy-src') ||
                                          img.getAttribute('data-original') ||
                                          img.getAttribute('data-lazy') || '';
                            if (realSrc && !img.getAttribute('src')) {
                                img.setAttribute('src', realSrc);
                            }
                            // 如果src为空但有其他data属性，也尝试
                            if (!img.getAttribute('src') || img.getAttribute('src').indexOf('data:') === 0) {
                                for (var a = 0; a < img.attributes.length; a++) {
                                    var attr = img.attributes[a];
                                    if (attr.name.indexOf('data-') === 0 &&
                                        attr.value &&
                                        attr.value.indexOf('http') === 0 &&
                                        attr.value.indexOf('shaidan') > -1) {
                                        img.setAttribute('src', attr.value);
                                        break;
                                    }
                                }
                            }
                        }
                    }
                """)
                # 等待图片加载
                time.sleep(random.uniform(1.0, 2.0))

                # 提取当前可见的评论卡片
                js_extract = r"""
                var container = document.querySelector('[class*="rateListContainer"]');
                if (!container) return JSON.stringify([]);

                var cards = container.querySelectorAll('.jdc-pc-rate-card');
                var results = [];

                for (var i = 0; i < cards.length; i++) {
                    var card = cards[i];

                    // 跳过已提取的（通过data属性标记）
                    if (card.getAttribute('data-comment-extracted') === '1') continue;

                    // === 用户昵称 ===
                    var nickEl = card.querySelector('.jdc-pc-rate-card-nick');
                    var nickname = nickEl ? nickEl.textContent.trim() : '匿名用户';

                    // === 评论时间 ===
                    var timeEl = card.querySelector('[class*="rate-card-date"], [class*="rate-card-time"]');
                    var createTime = timeEl ? timeEl.textContent.trim() : '';

                    // === 评论正文 ===
                    var descEl = card.querySelector('.jdc-pc-rate-card-main-desc');
                    var content = descEl ? descEl.textContent.trim() : '';

                    // 如果没找到main-desc，尝试从content中提取（排除商家回复）
                    if (!content) {
                        var contentEl = card.querySelector('.jdc-pc-rate-card-content');
                        if (contentEl) {
                            var fullText = contentEl.textContent || '';
                            // 去掉商家回复部分
                            var merchantIdx = fullText.indexOf('商家：');
                            if (merchantIdx > -1) {
                                content = fullText.substring(0, merchantIdx).trim();
                            } else {
                                content = fullText.trim();
                            }
                        }
                    }

                    // === 评分（星级） ===
                    // 京东评价等级：star-good-1=好评, star-good-2=中评, star-good-3=差评
                    var rating = 5;
                    var starGoodEl = card.querySelector('.jdc-pc-icon-star-good');
                    if (starGoodEl) {
                        var starClass = starGoodEl.className || '';
                        if (starClass.indexOf('star-good-3') > -1) {
                            rating = 1;  // 差评
                        } else if (starClass.indexOf('star-good-2') > -1) {
                            rating = 3;  // 中评
                        } else if (starClass.indexOf('star-good-1') > -1) {
                            rating = 5;  // 好评
                        }
                    }

                    // === 评论图片 ===
                    // 晒单图片URL格式：https://img30.360buyimg.com/shaidan/s300x300_jfs/.../xxx.jpg.dpg
                    // 注意：i.imageUpload 是用户头像，不是晒单图片，需要排除
                    var images = [];
                    var seenUrls = {};

                    function addImageUrl(url) {
                        if (!url) return;
                        if (url.indexOf('//') === 0) url = 'https:' + url;
                        // 只保留shaidan晒单图片，排除头像(i.imageUpload)和占位图(default.image)
                        if (url.indexOf('shaidan') > -1) {
                            var fileMatch = url.match(/\/([^\/]+\.(jpg|png|dpg|jpeg))/i);
                            var fileKey = fileMatch ? fileMatch[1] : url;
                            if (!seenUrls[fileKey]) {
                                seenUrls[fileKey] = true;
                                var thumbUrl = url.replace(/\/s\d+x\d+_/, '/s300x300_');
                                var bigUrl = url.replace(/\/s\d+x\d+_/, '/s1080x1080_');
                                images.push({"type": "image", "thumb": thumbUrl, "url": bigUrl});
                            }
                        }
                    }

                    // 从 img 标签提取（尝试所有可能的属性）
                    var imgEls = card.querySelectorAll('img');
                    for (var j = 0; j < imgEls.length; j++) {
                        var img = imgEls[j];
                        var src = img.getAttribute('data-src') ||
                                  img.getAttribute('data-lazy-src') ||
                                  img.getAttribute('data-original') ||
                                  img.getAttribute('data-lazy') ||
                                  img.getAttribute('src') || '';
                        addImageUrl(src);
                    }

                    // 从 computedStyle 的 background-image 提取（图片可能渲染为背景图）
                    var allEls = card.querySelectorAll('div, span, a, li');
                    for (var k = 0; k < allEls.length; k++) {
                        try {
                            var cs = window.getComputedStyle(allEls[k]);
                            var bg = cs.backgroundImage || '';
                            if (bg && bg !== 'none' && bg.indexOf('url(') > -1) {
                                var m = bg.match(/url\(["']?([^"')]+)["']?\)/);
                                if (m && m[1]) addImageUrl(m[1]);
                            }
                        } catch(e) {}
                    }

                    // === 商家回复 ===
                    var merchantReply = '';
                    var contentEl2 = card.querySelector('.jdc-pc-rate-card-content');
                    if (contentEl2) {
                        var fullText2 = contentEl2.textContent || '';
                        var mIdx = fullText2.indexOf('商家：');
                        if (mIdx > -1) {
                            merchantReply = fullText2.substring(mIdx + 3).trim();
                            // 去掉末尾的"有用"等
                            var usefulIdx = merchantReply.lastIndexOf('有用');
                            if (usefulIdx > -1) {
                                merchantReply = merchantReply.substring(0, usefulIdx).trim();
                            }
                        }
                    }

                    // === 追评 ===
                    // <div class="jdc-pc-rate-card-after">
                    //   <span class="jdc-pc-rate-card-after-icon">购后4天追评</span>
                    //   <span>追评内容</span>
                    // </div>
                    var appendComment = '';
                    var appendEl = card.querySelector('.jdc-pc-rate-card-after');
                    if (appendEl) {
                        // 去掉"购后X天追评"标签，只保留追评内容
                        var afterIcon = appendEl.querySelector('.jdc-pc-rate-card-after-icon');
                        if (afterIcon) {
                            afterIcon.remove();
                        }
                        appendComment = appendEl.textContent.trim();
                    }

                    // === 点赞数 ===
                    var likeCount = 0;
                    var likeEl = card.querySelector('[class*="rate-card-useful"], [class*="useful"], [class*="like"]');
                    if (likeEl) {
                        var likeText = likeEl.textContent || '';
                        var likeMatch = likeText.match(/(\\d+)/);
                        if (likeMatch) likeCount = parseInt(likeMatch[1]);
                    }

                    // === 用户购买的商品规格 ===
                    // <div class="jdc-pc-rate-card-info-left">
                    //   <span class="info">锐龙 7 H260/RTX5060/日蚀灰 WPS（16+512)...</span>
                    // </div>
                    var purchaseSku = '';
                    var infoEl = card.querySelector('.jdc-pc-rate-card-info-left .info');
                    if (infoEl) {
                        purchaseSku = infoEl.textContent.trim();
                    } else {
                        // 兜底：尝试其他选择器
                        var skuEl = card.querySelector('[class*="rate-card-sku"], [class*="sku-info"], [class*="product-sku"]');
                        if (skuEl) {
                            purchaseSku = skuEl.textContent.trim();
                        }
                    }

                    // 标记为已提取
                    card.setAttribute('data-comment-extracted', '1');

                    // 过滤无效评论
                    if (content && content !== '此用户未填写评价内容' && content.length > 0) {
                        results.push({
                            nickname: nickname,
                            content: content,
                            rating: rating,
                            created_at: createTime,
                            images_json: images,
                            like_count: likeCount,
                            merchant_reply: merchantReply,
                            append_comment: appendComment,
                            purchase_sku: purchaseSku
                        });
                    }
                }
                return JSON.stringify(results);
                """

                raw = self.page.run_js(js_extract)
                new_count = 0
                if raw:
                    try:
                        new_comments = json.loads(raw)
                        if new_comments:
                            all_comments.extend(new_comments)
                            new_count = len(new_comments)
                            if scroll_round <= 3 or new_count > 0:
                                print(f"[评论] 滚动{scroll_round}轮: +{new_count}条, 累计{len(all_comments)}条")
                    except json.JSONDecodeError as e:
                        print(f"[评论] JSON解析失败: {e}")

                # 连续无新评论检测
                if new_count == 0:
                    no_new_streak += 1
                    if no_new_streak >= 5:
                        print(f"[评论] 连续{no_new_streak}轮无新评论，停止")
                        break
                else:
                    no_new_streak = 0

            print(f"[评论] 提取完成: {len(all_comments)} 条")
            return all_comments[:max_count]

        except Exception as e:
            print(f"[评论] 浏览器提取失败: {e}")
            import traceback
            traceback.print_exc()
            return []

    def _extract_comments_fallback(self, max_count=50):
        """
        备用方案：从comment-root的ul.list中提取评论
        （适用于没有rateListContainer的情况）
        """
        print("[评论] 使用备用方案（ul.list）...")
        try:
            js_extract = r"""
            var root = document.querySelector('#comment-root');
            if (!root) return JSON.stringify([]);

            var lis = root.querySelectorAll('ul.list > li.item');
            var results = [];

            for (var i = 0; i < lis.length; i++) {
                var li = lis[i];
                if (li.getAttribute('data-extracted') === '1') continue;

                var userEl = li.querySelector('.comment-user');
                var infoEl = li.querySelector('.info');
                var nickname = userEl ? userEl.textContent.trim().substring(0, 20) : '匿名用户';
                var content = infoEl ? infoEl.textContent.trim() : '';

                var images = [];
                var seenUrls = {};

                function addImageUrl(url) {
                    if (!url) return;
                    if (url.indexOf('//') === 0) url = 'https:' + url;
                    // 只保留shaidan晒单图片
                    if (url.indexOf('shaidan') > -1) {
                        var fileMatch = url.match(/\/([^\/]+\.(jpg|png|dpg|jpeg))/i);
                        var fileKey = fileMatch ? fileMatch[1] : url;
                        if (!seenUrls[fileKey]) {
                            seenUrls[fileKey] = true;
                            var thumbUrl = url.replace(/\/s\d+x\d+_/, '/s300x300_');
                            var bigUrl = url.replace(/\/s\d+x\d+_/, '/s1080x1080_');
                            images.push({"type": "image", "thumb": thumbUrl, "url": bigUrl});
                        }
                    }
                }

                // 从 img 标签提取
                var imgEls = li.querySelectorAll('img');
                for (var j = 0; j < imgEls.length; j++) {
                    var src = imgEls[j].getAttribute('data-src') ||
                              imgEls[j].getAttribute('data-lazy-src') ||
                              imgEls[j].getAttribute('src') || '';
                    addImageUrl(src);
                }

                // 提取用户购买的商品规格
                var purchaseSku = '';
                var skuEl = li.querySelector('.sku-info, [class*="sku"]');
                if (skuEl) {
                    purchaseSku = skuEl.textContent.trim();
                }

                li.setAttribute('data-extracted', '1');

                if (content && content !== '此用户未填写评价内容') {
                    results.push({
                        nickname: nickname,
                        content: content,
                        rating: 5,
                        created_at: '',
                        images_json: images,
                        like_count: 0,
                        merchant_reply: '',
                        append_comment: '',
                        purchase_sku: purchaseSku
                    });
                }
            }
            return JSON.stringify(results);
            """
            raw = self.page.run_js(js_extract)
            if raw:
                comments = json.loads(raw)
                print(f"[评论] 备用方案提取: {len(comments)} 条")
                return comments[:max_count]
        except Exception as e:
            print(f"[评论] 备用方案失败: {e}")
        return []

    def _build_sku_list(self, js_data, main_price):
        """根据JS提取的SKU分组构建SKU列表"""
        sku_list = []
        sku_groups = js_data.get('sku_groups', [])

        if sku_groups and len(sku_groups) > 0:
            for group in sku_groups:
                if isinstance(group, dict):
                    group_label = group.get('label', '')
                    options = group.get('options', [])

                    # 构建attributes_json：选项名 + 随机浮动价格
                    attrs = []
                    for opt in options:
                        if isinstance(opt, dict):
                            opt_name = opt.get('name', '')
                            if opt_name:
                                # 基于主价格随机浮动（±30%）
                                opt_price = round(main_price * random.uniform(0.7, 1.3), 2)
                                attrs.append({'name': opt_name, 'value': str(opt_price)})

                    if attrs:
                        sku_list.append({
                            'sku_name': group_label or '规格',
                            'price': main_price,
                            'original_price': round(main_price * random.uniform(1.0, 1.3), 2),
                            'stock': random.randint(10, 500),
                            'sales': random.randint(5, 200),
                            'image': '',
                            'attributes_json': attrs
                        })
                elif isinstance(group, list):
                    # 兼容旧格式（数组形式）
                    for opt in group:
                        sku_name = opt.get('name', '默认') if isinstance(opt, dict) else str(opt)
                        sku_image = opt.get('image', '') if isinstance(opt, dict) else ''
                        is_disabled = opt.get('disabled', False) if isinstance(opt, dict) else False

                        sku_list.append({
                            'sku_name': sku_name,
                            'price': main_price,
                            'original_price': round(main_price * random.uniform(1.0, 1.3), 2),
                            'stock': 0 if is_disabled else random.randint(10, 500),
                            'sales': 0 if is_disabled else random.randint(5, 200),
                            'image': sku_image,
                            'attributes_json': [{'name': '规格', 'value': sku_name}]
                        })

        if not sku_list:
            sku_list.append({
                'sku_name': '默认',
                'price': main_price,
                'original_price': round(main_price * 1.2, 2),
                'stock': random.randint(50, 500),
                'sales': random.randint(10, 200),
                'image': '',
                'attributes_json': []
            })
            print("[兜底] 生成默认SKU")

        return sku_list

    # ==================== 图片下载（支持多尺寸） ====================

    def _download_image(self, url, save_path):
        """下载单张图片到指定路径"""
        if not url:
            return ""
        try:
            # 确保目录存在
            os.makedirs(os.path.dirname(save_path), exist_ok=True)
            if os.path.exists(save_path):
                return save_path
            headers = {'User-Agent': self.current_user_agent, 'Referer': 'https://item.jd.com/'}
            resp = requests.get(url, headers=headers, timeout=15)
            if resp.status_code == 200 and len(resp.content) > 1000:
                with open(save_path, 'wb') as f:
                    f.write(resp.content)
                return save_path
        except Exception as e:
            # 单张图片下载失败不应中断整体流程，但需记录以便感知丢失率（容错+可观测）
            print(f"[下载] 图片下载失败（{url}）: {e}")
        return ""

    def _download_video(self, url, save_path):
        """下载视频到指定路径"""
        if not url:
            return ""
        try:
            os.makedirs(os.path.dirname(save_path), exist_ok=True)
            if os.path.exists(save_path):
                return save_path
            headers = {
                'User-Agent': self.current_user_agent,
                'Referer': 'https://item.jd.com/',
                'Accept': 'video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.6,*/*;q=0.5'
            }
            resp = requests.get(url, headers=headers, timeout=60, stream=True)
            if resp.status_code == 200:
                content_length = int(resp.headers.get('content-length', 0))
                if content_length < 10000:
                    return ""
                downloaded = 0
                with open(save_path, 'wb') as f:
                    for chunk in resp.iter_content(chunk_size=8192):
                        if chunk:
                            f.write(chunk)
                            downloaded += len(chunk)
                if os.path.getsize(save_path) > 10000:
                    print(f"[下载] 视频已保存: {os.path.basename(save_path)} ({os.path.getsize(save_path) / 1024 / 1024:.1f}MB)")
                    return save_path
                else:
                    if os.path.exists(save_path):
                        os.remove(save_path)
        except Exception as e:
            print(f"[下载] 视频下载失败: {e}")
        return ""

    def _download_all_images(self, product_data):
        """
        下载所有静态资源，按商品ID分文件夹存放

        目录结构（实际位于项目根，由 PROJECT_ROOT 决定）：
        images/{sku_id}/
          ├── cover/          封面图
          ├── gallery/        轮播图（含视频）
          ├── detail/         详情图
          └── comments/       评论图片
        写入数据的 local_path 统一为相对项目根的可移植路径（如 'images/100x/cover/cover.jpg'）。
        """
        sku_id = self.sku_id
        base_dir = os.path.join(self.image_save_dir, sku_id)

        print(f"\n[下载] 开始下载资源到: {base_dir}")
        count = 0

        # 1. 下载封面图
        cover_image = product_data.get('cover_image', '')
        if cover_image:
            save_path = os.path.join(base_dir, 'cover', 'cover.jpg')
            path = self._download_image(cover_image, save_path)
            if path:
                product_data['cover_image_local'] = _relpath_to_root(path)
                count += 1

        # 2. 下载轮播图（含视频）
        gallery = product_data.get('gallery_json', [])
        for i, item in enumerate(gallery):
            if isinstance(item, list):
                for size_info in item:
                    media_type = size_info.get('type', 'image')
                    size = size_info.get('size', '')
                    url = size_info.get('url', '')
                    if url:
                        if media_type == 'video' or size == 'video':
                            save_path = os.path.join(base_dir, 'gallery', f'{i}_video.mp4')
                            path = self._download_video(url, save_path)
                        else:
                            ext = os.path.splitext(url)[1] or '.jpg'
                            save_path = os.path.join(base_dir, 'gallery', f'{i}_{size}{ext}')
                            path = self._download_image(url, save_path)
                        if path:
                            size_info['local_path'] = _relpath_to_root(path)
                            count += 1
            elif isinstance(item, dict):
                url = item.get('url', '')
                media_type = item.get('type', 'image')
                if url:
                    if media_type == 'video':
                        save_path = os.path.join(base_dir, 'gallery', f'{i}_video.mp4')
                        path = self._download_video(url, save_path)
                    else:
                        ext = os.path.splitext(url)[1] or '.jpg'
                        save_path = os.path.join(base_dir, 'gallery', f'{i}{ext}')
                        path = self._download_image(url, save_path)
                    if path:
                        item['local_path'] = _relpath_to_root(path)
                        count += 1

        # 3. 下载详情图
        detail_media = product_data.get('detail_media_json', [])
        for i, item in enumerate(detail_media):
            if isinstance(item, list):
                for size_info in item:
                    size = size_info.get('size', '')
                    url = size_info.get('url', '')
                    if url:
                        ext = os.path.splitext(url)[1] or '.jpg'
                        save_path = os.path.join(base_dir, 'detail', f'{i}_{size}{ext}')
                        path = self._download_image(url, save_path)
                        if path:
                            size_info['local_path'] = _relpath_to_root(path)
                            count += 1
            elif isinstance(item, dict):
                url = item.get('url', '')
                if url:
                    ext = os.path.splitext(url)[1] or '.jpg'
                    save_path = os.path.join(base_dir, 'detail', f'{i}{ext}')
                    path = self._download_image(url, save_path)
                    if path:
                        item['local_path'] = _relpath_to_root(path)
                        count += 1

        # 4. 下载SKU图片
        skus = product_data.get('skus', [])
        sku_img_count = 0
        for si, sku in enumerate(skus):
            sku_image = sku.get('image', '')
            if sku_image:
                ext = os.path.splitext(sku_image)[1] or '.jpg'
                save_path = os.path.join(base_dir, 'skus', f'{si}{ext}')
                path = self._download_image(sku_image, save_path)
                if path:
                    sku['image_local'] = _relpath_to_root(path)
                    count += 1
                    sku_img_count += 1

        # 5. 下载店铺Logo
        shop_logo = product_data.get('shop_logo', '')
        if shop_logo:
            ext = os.path.splitext(shop_logo)[1] or '.png'
            save_path = os.path.join(base_dir, 'shop', f'logo{ext}')
            path = self._download_image(shop_logo, save_path)
            if path:
                product_data['shop_logo_local'] = _relpath_to_root(path)
                count += 1

        # 6. 下载评论图片
        comments = product_data.get('comments', [])
        comment_img_count = 0
        for ci, comment in enumerate(comments):
            images = comment.get('images_json', [])
            for ii, img_info in enumerate(images):
                if isinstance(img_info, dict):
                    # 下载大图
                    url = img_info.get('url', '')
                    if url:
                        ext = os.path.splitext(url)[1] or '.jpg'
                        save_path = os.path.join(base_dir, 'comments', f'{ci}_{ii}{ext}')
                        path = self._download_image(url, save_path)
                        if path:
                            img_info['local_path'] = _relpath_to_root(path)
                            count += 1
                            comment_img_count += 1
                    # 下载缩略图
                    thumb = img_info.get('thumb', '')
                    if thumb:
                        ext = os.path.splitext(thumb)[1] or '.jpg'
                        save_path = os.path.join(base_dir, 'comments', f'{ci}_{ii}_thumb{ext}')
                        path = self._download_image(thumb, save_path)
                        if path:
                            img_info['thumb_local'] = _relpath_to_root(path)
                            count += 1

        print(f"[下载] 完成，共 {count} 个文件（SKU {sku_img_count} 张，评论 {comment_img_count} 张）")

        return product_data

    # ==================== 主流程 ====================

    def run(self):
        """爬虫主运行方法"""
        print("=" * 80)
        print("【京东商品详情页爬虫 v1.0】")
        print(f"目标: {self.product_url}")
        print("=" * 80)

        self._random_delay(1, 3)

        try:
            self.page = self._init_browser()
            self._random_delay(2, 4)

            # 预热：先访问首页，建立Cookie和会话
            self._warm_up()
            self._random_delay(2, 4)

            # 访问商品页 - 使用更谨慎的方式
            print(f"[浏览器] 访问商品页: {self.product_url}")

            # 方法1：尝试直接访问
            self.page.get(self.product_url)
            time.sleep(random.uniform(10, 20))

            # 检查是否被403重定向
            if self._check_page_redirected():
                print("[反爬] 被403拦截，尝试搜索方式访问...")

                try:
                    self.page.get("https://www.jd.com")
                    time.sleep(random.uniform(3, 5))

                    search_result = self.page.run_js(f"""
                        var searchInput = document.querySelector('#key, .search-input, input[placeholder*="搜索"]');
                        if (searchInput) {{
                            searchInput.value = '{self.sku_id}';
                            searchInput.dispatchEvent(new Event('input', {{bubbles: true}}));
                            searchInput.dispatchEvent(new Event('change', {{bubbles: true}}));
                            return true;
                        }}
                        return false;
                    """)

                    if search_result:
                        time.sleep(random.uniform(1, 2))
                        self.page.run_js("""
                            var searchBtn = document.querySelector('.search-btn, .search-m .button, .search-btn-icon');
                            if (searchBtn) searchBtn.click();
                        """)
                        time.sleep(random.uniform(5, 8))

                except Exception as e:
                    print(f"[反爬] 搜索方式失败: {e}")

                if self._check_page_redirected():
                    print("[反爬] 仍被拦截，等待人工验证...")
                    if not self._wait_for_manual_verification():
                        print("[错误] 验证未完成")
                        return None

            self._simulate_human_behavior()

            if self._check_for_verification():
                if not self._wait_for_manual_verification():
                    print("[错误] 验证未完成")
                    return None
                self.page.wait(2)

            # 等待商品数据加载
            print("[等待] 加载商品数据...")
            for attempt in range(15):
                try:
                    title_check = self.page.run_js("return document.title || '';")
                    current_url = self.page.url
                    if 'item.jd.com' in current_url:
                        h1_check = self.page.run_js("""
                            var h1 = document.querySelector('.sku-name, .itemInfo-wrap h1, h1');
                            return h1 ? h1.textContent.trim().substring(0, 30) : '';
                        """)
                        if h1_check:
                            break
                except Exception as e:
                    print(f"[调试] 标题/URL检查失败（可忽略）: {e}")
                time.sleep(1)
            else:
                if self._check_page_redirected():
                    print("[警告] 页面可能被403拦截")
                else:
                    print("[警告] 页面加载超时")

            time.sleep(2)

            # 点击"店铺"标签加载参数区域
            try:
                self.page.run_js("""
                    var tabs = document.querySelectorAll('.left-tabs-title li, [class*="tab"] li, [class*="tab-item"]');
                    for (var i = 0; i < tabs.length; i++) {
                        if (tabs[i].textContent.trim() === '店铺') {
                            tabs[i].click();
                            break;
                        }
                    }
                """)
                time.sleep(2)
            except Exception as e:
                print(f"[调试] 点击店铺标签失败（可忽略）: {e}")

            js_data = self._extract_all_by_js()
            if not js_data:
                # 关键路径信号：核心数据提取彻底失败，返回 None 让上层标记为爬取失败，
                # 避免生成"假商品"记录污染 products 表
                print("[错误] 核心数据提取失败（返回空），放弃本次爬取")
                return None

            # 慢速平滑滚动加载详情图（详情图为 background-image 懒加载，瞬跳到页尾会导致提取到 0 张）
            print(f"[详情图] 缓慢滚动页面以触发懒加载（每屏停顿 {self.scroll_pause}s）...")
            self._slow_scroll_to_load()

            detail_images = self._extract_detail_images_by_js()

            # 评论统计（简化：使用随机值）
            sales = random.randint(1000, 500000)
            comment_count = random.randint(100, 50000)
            rating = round(random.uniform(4.0, 5.0), 1)

            price_str = js_data.get('price', '0')
            try:
                price = float(price_str) if price_str else 0.0
            except ValueError:
                price = 0.0
            original_price = round(price * random.uniform(1.0, 1.3), 2) if price > 0 else 0.0

            # 处理gallery多尺寸结构
            gallery = js_data.get('gallery', [])
            cover_image = ""
            gallery_json = []

            if gallery:
                # 第一张图作为封面（使用1440尺寸）
                first = gallery[0]
                if isinstance(first, list) and len(first) > 0:
                    # 找1440尺寸
                    for size_info in first:
                        if size_info.get('size') == '1440':
                            cover_image = size_info.get('url', '')
                            break
                    if not cover_image:
                        cover_image = first[0].get('url', '')
                    gallery_json = gallery
                elif isinstance(first, str):
                    cover_image = first
                    gallery_json = [{"type": "image", "url": url} for url in gallery]

            skus = self._build_sku_list(js_data, price)

            # 解析attributes_json
            raw_attrs = js_data.get('attributes', [])
            attributes_json = []
            if raw_attrs:
                for attr in raw_attrs:
                    if isinstance(attr, dict):
                        attributes_json.append({
                            'group': attr.get('group', '基础信息'),
                            'name': attr.get('name', ''),
                            'value': attr.get('value', '')
                        })

            now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            product_data = {
                'sku_id': self.sku_id,
                'title': js_data.get('title', '') or f'商品{self.sku_id}',
                'category_id': js_data.get('category_id', 0),
                'brand': js_data.get('brand', '') or '其他',
                # 封面图（远程+本地）
                'cover_image': cover_image,
                'cover_image_local': '',
                # 轮播图（远程+本地，下载后回填local_path）
                'gallery_json': gallery_json,
                # 详情图（远程+本地，下载后回填local_path）
                'detail_media_json': detail_images,
                'description': js_data.get('title', ''),
                'price': price,
                'original_price': original_price,
                'sales': sales,
                'stock': random.randint(50, 1000),
                'comment_count': comment_count,
                'rating': rating,
                # 店铺信息（远程+本地）
                'shop_id': js_data.get('shop_id', ''),
                'shop_name': js_data.get('shop_name', '') or '京东自营',
                'shop_logo': js_data.get('shop_logo', ''),
                'shop_logo_local': '',
                'services_json': js_data.get('services', []),
                'attributes_json': attributes_json,
                'tags_json': random.sample(self.RANDOM_TAGS, random.randint(2, 4)),
                'source': 'jd',
                'source_url': self.product_url,
                'status': 1,
                'created_at': now,
                'updated_at': now,
                'skus': skus,
                'comments': []
            }

            # ===== 评论提取（放到最后执行，避免影响其他数据提取） =====
            # 目标数量：优先用外部配置 self.max_comments；未配置(None/<=0)时沿用随机 20~50 条
            target_comments = self.max_comments if (self.max_comments and self.max_comments > 0) else random.randint(20, 50)
            print(f"\n[数据提取] 获取评论数据（目标 {target_comments} 条，最后执行）...")
            comments = self._extract_comments_via_page(max_count=target_comments)
            if not comments:
                sample = ['商品质量很好，推荐购买！', '物流快，包装好。', '性价比高，值得回购。',
                          '做工精细，非常满意。', '效果不错，值得购买。']
                comments = [{
                    'nickname': f'用户{random.randint(1000,9999)}',
                    'avatar': '', 'content': random.choice(sample),
                    'rating': random.choice([4, 5]), 'images_json': [],
                    'like_count': random.randint(0, 50), 'is_anonymous': 0,
                    'created_at': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                } for _ in range(5)]
                print("[兜底] 评论提取失败，生成5条随机评论")

            product_data['comments'] = comments

            if self.download_images:
                product_data = self._download_all_images(product_data)
            else:
                print("\n[下载] 已跳过图片下载（download_images=False），仅记录远程 URL")
            self._print_result(product_data)
            self._save_to_json(product_data)

            return product_data

        except Exception as e:
            print(f"[错误] 爬取失败: {e}")
            import traceback
            traceback.print_exc()
            return None
        finally:
            if self.page:
                try:
                    self.page.quit()
                except Exception as e:
                    print(f"[调试] 关闭浏览器失败（可忽略）: {e}")

    def _print_result(self, data):
        """打印结果摘要"""
        print("\n" + "=" * 80)
        print("【提取结果摘要】")
        print("=" * 80)
        print(f"  商品ID: {data.get('sku_id', 'N/A')}")
        print(f"  标题: {data['title'][:60]}...")
        print(f"  品牌: {data['brand']}")
        print(f"  价格: ¥{data['price']} (原价: ¥{data['original_price']})")
        print(f"  销量: {data['sales']}  评论: {data['comment_count']}  评分: {data['rating']}")
        print(f"  店铺: {data['shop_name']}")
        print(f"  封面图: {'✓' if data['cover_image'] else '✗'}")
        # 统计gallery中的视频和图片数量
        gallery = data.get('gallery_json', [])
        video_count = sum(1 for item in gallery if isinstance(item, list) and len(item) > 0 and item[0].get('type') == 'video')
        image_count = len(gallery) - video_count
        print(f"  轮播图: {image_count} 张图片, {video_count} 个视频")
        print(f"  详情图: {len(data['detail_media_json'])} 张")
        print(f"  参数: {len(data['attributes_json'])} 条")
        print(f"  SKU: {len(data['skus'])} 个")
        print(f"  评论: {len(data['comments'])} 条")
        print("=" * 80)

    def _save_to_json(self, data):
        """保存JSON到数据目录"""
        # JSON保存到项目根的 data/{sku_id}/ 目录（统一落点，避免 scripts/data 错位）
        data_dir = os.path.join(PROJECT_ROOT, 'data', self.sku_id)
        os.makedirs(data_dir, exist_ok=True)
        output = os.path.join(data_dir, f"product_{self.sku_id}.json")
        try:
            with open(output, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            print(f"\n[保存] JSON → {output}")
        except Exception as e:
            print(f"[保存] 失败: {e}")


if __name__ == "__main__":
    import sys

    # 使用示例：
    # python jd_product_detail.py
    # python jd_product_detail.py --url https://item.jd.com/100012043978.html

    url = None
    if '--url' in sys.argv:
        idx = sys.argv.index('--url')
        if idx + 1 < len(sys.argv):
            url = sys.argv[idx + 1]

    max_comments = None
    if '--max-comments' in sys.argv:
        idx = sys.argv.index('--max-comments')
        if idx + 1 < len(sys.argv):
            try:
                max_comments = int(sys.argv[idx + 1])
            except ValueError:
                max_comments = None

    scroll_pause = 0.8
    if '--scroll-pause' in sys.argv:
        idx = sys.argv.index('--scroll-pause')
        if idx + 1 < len(sys.argv):
            try:
                scroll_pause = float(sys.argv[idx + 1])
            except ValueError:
                scroll_pause = 0.8

    download_images = '--no-download-images' not in sys.argv

    if not url:
        print("用法: python jd_product_detail.py --url <京东商品URL> [--max-comments N] [--scroll-pause 秒] [--no-download-images]")
        print("示例: python jd_product_detail.py --url https://item.jd.com/100012043978.html --max-comments 30")
        sys.exit(1)

    spider = JdProductDetailSpider(
        product_url=url,
        max_comments=max_comments,
        scroll_pause=scroll_pause,
        download_images=download_images,
    )
    result = spider.run()
    print("\n[完成]" if result else "\n[失败]")
