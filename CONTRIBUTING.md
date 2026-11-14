# Contributing

Thanks for your interest in Prism! This guide covers the essentials, with a focus on **adding a new platform adapter** — the primary extension point.

## Development setup

```bash
pip install -e ".[forecast,dev]"
pytest tests/        # offline tests — no cookies or network required
```

## Adding a new platform adapter

1. Create a file under `framework/adapters/` (e.g. `douyin.py`). Inherit from `SourceAdapter` in `framework/adapter.py` and implement two methods:
   - `fetch_entity(seed: dict) -> tuple[Entity, list[Metric]]` — fetch creator profile and metrics
   - `fetch_items(entity_id: str, limit=20) -> Iterator[tuple[Item, list[Metric]]]` — fetch content and metrics
2. **Put field mappings in `framework/config/*.yml`, not in code.** See `framework/adapters/xhs.py` + `config/xhs_selectors.yml` for a reference implementation.
3. **All user data must pass through `compliance.scrub_user`** (salted HMAC on user ID + sensitive field removal).
4. Follow the layered structure from `xhs.py`:
   - **Parse layer (pure functions)**: raw data → contract objects, no network I/O, easy to unit-test with mocks
   - **Fetch layer**: network requests + exponential backoff + cookie expiry detection + rate limiting

## Code standards

- Full type annotations throughout
- **Writer/reviewer separation**: code you write should be reviewed by another person or a different model — no self-merging
- **Never commit** `cookies.json` / `.env` / real databases (`.gitignore` covers these); use the anonymized demo from `examples/make_demo.py` for local debugging

## PR checklist

- [ ] `pytest tests/` passes
- [ ] New platform has a `framework/config/*.yml` field-mapping file
- [ ] All user data output passes through `compliance.scrub_user`
- [ ] No cookies / .env / real data included
- [ ] Code has had at least one review (writer/reviewer separation)
