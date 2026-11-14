#!/usr/bin/env python3
"""Check every skills/*/SKILL.md for valid frontmatter (name matches folder, description <= 1024 chars) and a body."""
from pathlib import Path
import re
import sys

root = Path(__file__).resolve().parents[1]
errors = []
paths = sorted(root.glob("skills/*/SKILL.md"))
for path in paths:
    rel = path.relative_to(root)
    text = path.read_text(encoding="utf-8")
    m = re.match(r"---\n(.*?)\n---\n(.*)", text, re.S)
    if not m:
        errors.append(f"{rel}: missing frontmatter fences")
        continue
    head, body = m.groups()
    name = re.search(r"^name:\s*(.+)$", head, re.M)
    desc = re.search(r"^description:\s*(.+)$", head, re.M)
    if not name or name.group(1).strip().strip('"') != path.parent.name:
        errors.append(f"{rel}: name must equal the folder name")
    if not desc:
        errors.append(f"{rel}: missing description")
    elif len(desc.group(1).strip().strip('"')) > 1024:
        errors.append(f"{rel}: description is longer than 1024 characters")
    if not body.strip():
        errors.append(f"{rel}: empty body")

if errors:
    print("Skill validation failed:\n" + "\n".join(f"- {e}" for e in errors))
    sys.exit(1)
print(f"Validated {len(paths)} skills")
