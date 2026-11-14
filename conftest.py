"""Shared pytest configuration: make repo-root packages importable."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
