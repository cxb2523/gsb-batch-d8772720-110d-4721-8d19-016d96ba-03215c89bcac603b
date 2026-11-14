import logging
import random
import time
import httpx
from utils.dep_check import require_package

log = logging.getLogger(__name__)

# Try to import bilibili_api
# note: we will import inner modules only when needed to avoid early import errors
bilibili_api = require_package("bilibili-api-dev", "bilibili_api")
if bilibili_api:
    from bilibili_api import article, opus
else:
    article = None
    opus = None

async def get_list(lid):
    if not article:
        raise ImportError("缺少 bilibili-api-dev 依赖")
    a = article.ArticleList(rlid=lid)
    info = await a.get_content()
    id_list = []
    for item in info['articles']:
        id_list.append(item['id'])
    return id_list, info['list']['name']

async def get_co(id):
    """通过 cv 号获取专栏图片，内部转为 Opus 处理"""
    if not article:
        raise ImportError("缺少 bilibili-api-dev 依赖")
    a = article.Article(cvid=id)
    log.info(f"专栏cv号：{id}")
    o = await a.turn_to_opus()
    return await get_opus_images(o)

async def get_opus(oid):
    """通过 opus id 获取图文图片"""
    if not opus:
        raise ImportError("缺少 bilibili-api-dev 依赖")
    o = opus.Opus(opus_id=oid)
    log.info(f"图文opus号：{oid}")
    return await get_opus_images(o)

async def get_opus_images(o):
    """从 Opus 对象提取图片列表和标题"""
    info = await o.get_info()

    # 从 modules 中获取标题
    cname = "Unknown_Title"
    for module in info.get("item", {}).get("modules", []):
        if module.get("module_title"):
            cname = module["module_title"]["text"]
            break

    # 获取图片 URL 列表
    raw_images = await o.get_images_raw_info()
    images = []
    for pic in raw_images:
        url = pic["url"].replace("http://", "https://")
        if url not in images:
            images.append(url)

    log.debug(f"图片列表: {images}")
    return images, cname

async def download_image(path, url, request_handler=None):
    log.debug(f"正在下载图片：{url}")
    
    response = None
    if request_handler:
        response = request_handler.get(url)
    else:
        response = httpx.get(url, follow_redirects=True)
        
    if not response or not response.content:
        log.error(f"图片下载失败，URL：{url}")
        return False
        
    with open(path, "wb") as f:
        f.write(response.content)
        
    # 防止速率过高导致临时403
    sleep_time = random.randint(1, 2)
    time.sleep(sleep_time)
    return True
