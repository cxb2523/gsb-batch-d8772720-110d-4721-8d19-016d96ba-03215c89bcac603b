import scrapy


class JdItem(scrapy.Item):
    """
    京东商品数据模型（简化版）
    
    只提取核心字段：sku_id 和 source_url
    其他字段后续通过详情爬虫补充
    """
    # ==================== 分类关联 ====================
    category_id = scrapy.Field()       # 三级分类ID（对应 categories.id）
    
    # ==================== 商品核心信息 ====================
    sku_id = scrapy.Field()            # SKU ID（京东商品唯一标识）
    source_url = scrapy.Field()        # 原商品链接
    
    # ==================== 分类名称（用于日志和调试） ====================
    category_name = scrapy.Field()     # 分类名称（完整路径，如 "家用电器>冰洗>冰箱"）
