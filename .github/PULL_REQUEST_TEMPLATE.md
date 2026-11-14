<!-- Thanks for contributing to Prism! Please fill in the checklist below. -->

## What does this PR do?

<!-- One or two sentences. Link the issue it closes, e.g. "Closes #12". -->

## Type of change

- [ ] Bug fix
- [ ] New platform adapter
- [ ] New analysis lens / metric
- [ ] Docs / examples
- [ ] Refactor / DX

## Checklist

- [ ] `pytest tests/` passes (offline, no cookies/network needed)
- [ ] `ruff check .` and `mypy .` pass
- [ ] New platform adapter? Field mappings live in `config/*.yml`, not hard-coded
- [ ] All user data output passes through `compliance.scrub_user`
- [ ] No cookies / `.env` / real data committed (`.gitignore` covers these)
- [ ] Code reviewed by someone (or a different model) — author does not self-approve
