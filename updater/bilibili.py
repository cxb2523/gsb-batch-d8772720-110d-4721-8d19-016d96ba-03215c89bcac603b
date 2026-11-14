import logging
from typing import Dict, List, Any, Tuple
import asyncio
from .base import BaseUpdater
from plugins.bilibili.client import get_list, get_co, get_opus
from utils import config

log = logging.getLogger(__name__)

class BilibiliUpdater(BaseUpdater):
    SITE_NAME = "bilibili"
    ID_FIELD = "id"  # lid, cv, or opus id
    REQUIRED_FIELDS = BaseUpdater.REQUIRED_FIELDS + ['type', 'name']
    
    def get_chapters(self, record: Dict) -> List[Dict]:
        """
        Bilibili 合集对应章节列表 (CV IDs)。
        单项 (cv/opus) 返回单个伪章节。
        """
        task_type = record.get('type')
        task_id = record.get('id')
        
        try:
            try:
                loop = asyncio.get_event_loop()
            except RuntimeError:
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
            if task_type == 'lid':
                ids, series_name = loop.run_until_complete(get_list(int(task_id)))
                # 对应 UUID 为 CV 号，name 为 CV 号本身或从获取中补充
                return [{"uuid": str(x), "name": f"cv{x}", "index": i} for i, x in enumerate(ids)]
            else:
                # 单个 cv 或 opus
                name = record.get('name') or (f"{task_type}{task_id}")
                return [{"uuid": str(task_id), "name": name, "index": 0}]
        except Exception as e:
            log.error(f"获取 Bilibili 列表失败: {e}")
            return []

    def find_subsequent_uuids(self, chapters: List[Dict], target_chapter: str) -> List[Tuple[str, str]]:
        """
        Bilibili 的 target_chapter (latest_chapter) 存储的是最后一个下载成功的 CV/Opus ID。
        """
        if target_chapter == "Downloaded": # Special case for one-offs
            return []
            
        if target_chapter:
            target_index = -1
            for i, chapter in enumerate(chapters):
                if chapter['uuid'] == target_chapter:
                    target_index = i
                    break
            
            if target_index == -1:
                # 如果找不到上一次的记录，保守起见重头开始（或者记录里可能被清理了）
                return [(chap['uuid'], chap['name']) for chap in chapters]
            
            if target_index == len(chapters) - 1:
                return []
                
            return [(chap['uuid'], chap['name']) for chap in chapters[target_index + 1:]]
            
        return [(chap['uuid'], chap['name']) for chap in chapters]

    def create_download_task(self, record: Dict, chapter_infos: List[Tuple[str, str]]) -> Dict[str, Any]:
        """
        Modified to return a task that processor.py can handle.
        """
        return {
            "site": self.SITE_NAME,
            "type": record['type'],
            "id": record['id'],
            "chapter_infos": chapter_infos,  # We'll use this to know which ones to download
            "name": record.get('name', 'Bilibili'),
            "latest_chapter": record.get('latest_chapter')
        }
    
    @classmethod
    def validate_record(cls, record: Dict) -> bool:
        # Bilibili 允许初始记录缺少 last_download_date 和 latest_chapter
        core_fields = [cls.ID_FIELD, 'type', 'name']
        if not all(field in record for field in core_fields):
            return False
        if record.get('type') not in ['lid', 'cv', 'opus']:
            return False
        
        # 补充缺失的字段以维持后续逻辑一致性
        if 'latest_chapter' not in record:
            record['latest_chapter'] = ""
        if 'last_download_date' not in record:
            record['last_download_date'] = ""
            
        return True

    @classmethod
    def get_field_meta(cls) -> Dict[str, Dict[str, Any]]:
        meta = super().get_field_meta()
        
        # Override name and id labels/placeholders
        if "name" in meta:
            meta["name"]["label"] = "项目名称"
            meta["name"]["placeholder"] = "请输入合集或单项名称"
            meta["name"]["cols"] = 6
        
        # Add Bilibili specific 'type' field
        meta["type"] = {
            "label": "类型", 
            "type": "select", 
            "options": [
                {"value": "lid", "label": "合集 (RL ID)"},
                {"value": "cv", "label": "专栏 (CV ID)"},
                {"value": "opus", "label": "图文 (Opus ID)"}
            ], 
            "cols": 6,
            "required": True
        }
        
        # Ensure 'id' is correctly labeled
        if "id" in meta:
            meta["id"]["label"] = "ID"
            meta["id"]["placeholder"] = "数字ID"
            meta["id"]["cols"] = 6
        
        return meta
