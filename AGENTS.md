# reader — project notes for agents

## Packaging

- The project is a **distributable package**, not just a script:
  `[build-system]` uses hatchling and `[project.scripts]` in
  `pyproject.toml` maps the `reader` command to `reader:cli`.
- `reader.py` is a single top-level module (no package directory), so the
  hatchling wheel/sdist targets name it explicitly. A new file that must
  ship has to be added to those `include` lists.
- `cli()` is the console-script entry point (argparse + printing);
  `main()` is the library API and returns a `ParseResult` dict. Keep the
  two separate — importing `reader` must not parse `sys.argv`.
- Because `[build-system]` exists, `uv sync` installs the project itself
  in editable mode, so `uv run reader` / `.venv/bin/reader` exercise the
  real entry point. Verify a packaging change end to end:

  ```sh
  uv build      # wheel + sdist into dist/
  ```
- `uv tool install` resolves **fresh from the `[project.dependencies]`
  ranges** — it does not read `uv.lock` and has no `--locked` flag. To
  install the locked set on the pinned interpreter, pass the derived
  `requirements.txt` as constraints:

  ```sh
  uv tool install --force -c requirements.txt -p 3.14 .
  ```

  Without `-c` the tool env drifts ahead of the lock; without `-p` it
  takes anything satisfying `requires-python`, so it will jump to the
  next minor release once that becomes the default interpreter.

## Python version

- `.python-version` is **tracked**, not ignored — the entry under
  `# pyenv` in `.gitignore` is deliberately commented out. It pins the
  minor series (`3.14`), so the interpreter follows patch releases
  without a repo edit.
- `requires-python` in `pyproject.toml` is the support contract;
  `[tool.pyright] pythonVersion` must be kept in step with it. Raising
  either drops support for older interpreters and is a breaking change.
- The venv does *not* follow a patch upgrade on its own: `uv sync` keeps
  an existing venv whose interpreter still satisfies the pin. Move it
  deliberately:

  ```sh
  uv venv --python 3.14.7 --clear && uv sync
  ```

## Upstream workarounds

- `reader.py` overrides trafilatura's `Accept-Encoding` to `gzip, deflate`.
  trafilatura 2.2.0 advertises `zstd` and then decompresses it with
  `zstandard.decompress()`, whose one-shot API raises on frames that omit
  their decompressed size — which is what a server compressing on the fly
  sends. The error is swallowed and the *compressed* bytes are returned, so
  affected pages arrive as binary garbage at HTTP 200 and extract to
  nothing (`simonwillison.net` is one such site).
- Fixed upstream in [adbar/trafilatura](https://github.com/adbar/trafilatura)
  by a streaming `_decompress_zstd()`, unreleased as of 2.2.0. When a
  release carries it, raise the `trafilatura` floor in `pyproject.toml` and
  delete the override.
- Check whether the release has landed, and that the override is still
  needed, with:

  ```sh
  .venv/bin/python reader.py https://simonwillison.net/tags/tools -f txt | head -3
  ```

## Dependency management

- This project is managed by **uv**: `pyproject.toml` + `uv.lock` are the
  source of truth. Never `pip install` into the venv directly.
- `requirements.txt` is **derived** from the lock as a courtesy for pip
  users. It does not update itself. Regenerate it after *any* dependency
  change — including merging a Dependabot PR (Dependabot only updates
  `uv.lock`/`pyproject.toml`):

  ```sh
  uv export --no-dev --no-hashes --no-annotate --no-header --no-emit-project -o requirements.txt
  ```

  Commit the result as `chore(deps): regenerate requirements.txt` (or fold
  it into the same commit as the dependency change).
- Dev-only tools (`lxml-stubs`) live in the dev dependency group and must
  NOT appear in `requirements.txt` (hence `--no-dev` above).

## Release checklist

1. Bump `version` in `pyproject.toml` (semver; the CLI surface, the JSON
   output schema, and the importable `main()`/`ParseResult` API are all
   public). Raising `requires-python` or removing an invocation path
   counts as breaking — major bump plus a `BREAKING CHANGE:` footer.
2. `uv lock` so the lockfile records the new version.
3. Regenerate `requirements.txt` (command above) if dependencies changed.
4. Commit as `chore(release): bump version to X.Y.Z`.
5. Annotated tag: `git tag -a vX.Y.Z` with release notes in the message.
6. `git push origin master vX.Y.Z`.
7. `gh release create vX.Y.Z --title "reader X.Y.Z" --notes "..."` with
   notes grouped by theme and a `compare` changelog link.

## Linting

Run before every commit (CI enforces these on push/PR):

```sh
uv run ruff check .        # lint (ruff is pinned in the dev group)
uv run basedpyright        # strict type check: zero errors AND warnings
```

- `basedpyright` (not plain pyright) is the checker — it matches the
  editor's language server, including its stricter rules (`reportAny`,
  `reportUnusedCallResult`, ...). Config lives in `[tool.pyright]` in
  `pyproject.toml`.
- `uvx pyflakes reader.py` is a useful independent second opinion, but
  its findings overlap ruff's `F` rules; only report non-duplicates.
- Auto-fix with `ruff check --fix` (safe fixes only; never
  `--unsafe-fixes` without asking).
- lxml typing gaps are handled with targeted `# pyright: ignore[rule]`
  comments, never blanket suppressions, and never `# noqa` to silence
  ruff without cause.

## Conventions

- Conventional Commits (`feat:`, `fix:`, `chore:`, `feat!:` + a
  `BREAKING CHANGE:` footer for breaking changes).
- Test changes against a local HTML fixture (write a temporary
  `.fixture.html`, delete it afterwards) plus live pages:
  https://www.paulgraham.com/greatwork.html (pathological 1990s
  table/br-based layout) and https://www.gnu.org/philosophy/free-sw.en.html
  (modern, metadata-rich). Check all four formats (`json`, `html`, `md`,
  `txt`) and `-w` wrapping.
- Run via `.venv/bin/python reader.py`, or `.venv/bin/reader` to go
  through the installed console script (the venv is `.venv`).
- `~/Dropbox/Scripts/Shell/newspaper.sh` (outside this repo, not in git)
  consumes the JSON output (`.title`, `.author`, `.content.text`) — keep
  those fields stable or update the script in tandem.
