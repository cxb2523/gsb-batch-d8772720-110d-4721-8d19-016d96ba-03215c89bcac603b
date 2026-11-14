# Social Media Agent Skills

Agent skills for social media research powered by ScrapeAtlas.

- Skills live in `skills/<skill-name>/SKILL.md`; `name` must equal the folder name.
- Keep workflow skills outcome-first: inputs, tools, steps, output template, pitfalls.
  The `scrapeatlas` skill owns connection, result reading, pagination and credits;
  workflow skills point to it instead of repeating it.
- Reference real ScrapeAtlas operation IDs only (for example `tiktokVideoComments`).
- Public data only. Never ask for platform logins, cookies or API keys in prompts.
- Copy is direct and concise. Say what the skill does and what the user gets.

Validate before committing:

```bash
git diff --check
python3 scripts/validate-skills.py
```
