# -*- coding: utf-8 -*-
"""白盒测试：load_categories 的分类树解析与入库逻辑。"""
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import load_categories  # noqa: E402
from fakes import FakeCategoriesStore  # noqa: E402


class TestCountNodes(unittest.TestCase):
    """count_nodes：不依赖数据库的统计逻辑。"""

    def test_synthetic_tree(self):
        tree = [
            {"level": 1, "name": "A", "children": [
                {"level": 2, "name": "B"},  # 叶子
                {"level": 2, "name": "C", "children": [
                    {"level": 3, "name": "D"},  # 叶子
                ]},
            ]},
        ]
        stat, leaf = load_categories.count_nodes(tree)
        self.assertEqual(stat, {1: 1, 2: 2, 3: 1})
        self.assertEqual(leaf, {2: 1, 3: 1})
        # 叶子总数 = 2（B 与 D）
        self.assertEqual(sum(leaf.values()), 2)

    def test_real_seed_file(self):
        """用真实种子文件统计：应锁定 2941 节点 / 2694 叶子。"""
        data = load_categories.load_seed()
        stat, leaf = load_categories.count_nodes(data)
        total = sum(stat.values())
        self.assertEqual(total, 2941)
        self.assertEqual(sum(leaf.values()), 2694)
        # 4 级结构
        self.assertEqual(set(stat.keys()), {1, 2, 3, 4})


class TestInsertTree(unittest.TestCase):
    """insert_tree：用内存假库验证 parent_id / is_leaf / path / 自增 id。"""

    def _make_loader(self):
        store = FakeCategoriesStore()
        # 模拟 CategoryLoader：insert_tree 只用到 cursor / connection
        class _Loader:
            pass
        loader = _Loader()
        loader.cursor = store
        loader.connection = store
        return loader, store

    def test_parent_id_and_path(self):
        loader, store = self._make_loader()
        tree = [
            {"level": 1, "name": "A", "children": [
                {"level": 2, "name": "B"},  # 叶子
                {"level": 2, "name": "C", "children": [
                    {"level": 3, "name": "D"},  # 叶子
                ]},
            ]},
        ]
        load_categories.insert_tree(loader.cursor, tree)
        # id 分配：A=1, B=2, C=3, D=4
        self.assertEqual(store.rows[1]["name"], "A")
        self.assertEqual(store.rows[1]["parent_id"], 0)
        self.assertEqual(store.rows[1]["is_leaf"], 0)
        self.assertEqual(store.rows[1]["path"], "1")

        self.assertEqual(store.rows[2]["parent_id"], 1)
        self.assertEqual(store.rows[2]["is_leaf"], 1)
        self.assertEqual(store.rows[2]["path"], "1/2")

        self.assertEqual(store.rows[3]["parent_id"], 1)
        self.assertEqual(store.rows[3]["is_leaf"], 0)
        self.assertEqual(store.rows[3]["path"], "1/3")

        self.assertEqual(store.rows[4]["parent_id"], 3)
        self.assertEqual(store.rows[4]["is_leaf"], 1)
        self.assertEqual(store.rows[4]["path"], "1/3/4")

    def test_idempotent_rerun(self):
        """重复运行应幂等：已存在的同名同父节点被跳过，不新增行。"""
        loader, store = self._make_loader()
        tree = [
            {"level": 1, "name": "A", "children": [{"level": 2, "name": "B"}]},
        ]
        c1 = load_categories.insert_tree(loader.cursor, tree)
        self.assertEqual(c1["inserted"], 2)
        self.assertEqual(len(store.rows), 2)

        c2 = load_categories.insert_tree(loader.cursor, tree)
        self.assertEqual(c2["inserted"], 0)
        self.assertEqual(c2["skipped"], 2)
        self.assertEqual(len(store.rows), 2)  # 没有重复插入

    def test_level_from_json(self):
        """level 应取自 JSON 的 level 字段（而非默认 1）。"""
        loader, store = self._make_loader()
        tree = [{"level": 4, "name": "X"}]
        load_categories.insert_tree(loader.cursor, tree)
        self.assertEqual(store.rows[1]["level"], 4)
        self.assertEqual(store.rows[1]["is_leaf"], 1)


if __name__ == "__main__":
    unittest.main()
