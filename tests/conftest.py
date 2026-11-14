# -*- coding: utf-8 -*-
"""pytest 公共夹具：把 src 目录加入导入路径。"""
import sys
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parent.parent / 'src'
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))
