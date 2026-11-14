# Provider notes

Provider data that SPEC.md marks as «verificar» and that could not be confirmed in the
official documentation, or that differs from it. Each entry says what the spec claims,
what the docs say, the date checked and what Mecha does meanwhile (usually `unknown`).

Only provider data belongs here; architecture decisions live in [`adr/`](adr/).

## Key prefixes (phase 1, checked 2026-11-04)

`verified` in `src/mecha/data/detect_patterns.toml` is `true` only when the prefix appears in
the provider's official documentation. Unverified patterns still work, but the CLI/UI say
«format not confirmed in official docs».

| Pattern | Prefix / format | Official docs | `verified` | Mecha behaviour |
| --- | --- | --- | --- | --- |
| `anthropic_api_key` | `sk-ant-api03-` | Yes: `partial_key_hint` example `sk-ant-api03-R2D...igAA` in [List API Keys](https://platform.claude.com/docs/en/api/admin/api_keys/list) | true | — |
| `anthropic_admin_key` | `sk-ant-admin01-` | Not found in the Admin API pages | false | Detected as admin key |
| `anthropic_oauth_access` | `sk-ant-oat01-` | Undocumented (third-party sources only) | false | `oauth_token`, local inspection only |
| `anthropic_oauth_refresh` | `sk-ant-ort01-` | Undocumented (third-party sources only). SPEC: «verificar» | false | **Never stored**; the user is told it looks like a refresh token. Safe even if the prefix changes |
| `openai_project_key` | `sk-proj-` | Not found in the [Admin API reference](https://developers.openai.com/api/reference/resources/admin/subresources/organization.md) | false | Detected as project key |
| `openai_service_account_key` | `sk-svcacct-` | Not found in the Admin API reference | false | Detected as service account key |
| `openai_admin_key` | `sk-admin-` | Yes: examples `sk-admin-1234abcd` in the Admin API reference | true | — |
| `openai_legacy_key` | `sk-` (rest) | n/a (ambiguous by design) | false | User must confirm the provider |
| `gemini_auth_key` | `AQ.` | [API keys page](https://aistudio.google.com/docs/api-key) describes auth keys but not their format | false | Detected as auth key |
| `gemini_standard_key` | `AIza` + 35 | Same page: no format documented. It does confirm: since 2026-05-28 AI Studio only creates auth keys; unrestricted standard keys are rejected; the API «will move from standard keys to auth keys» (no date). The September 2026 cutoff comes from third parties only | false | Always amber («key type being retired») |
| `xai_api_key` | `xai-` | Yes: examples in [Management API, auth](https://docs.x.ai/developers/rest-api-reference/management/auth.md) | true | — |
| `openrouter_api_key` | `sk-or-v1-` | Yes: masked labels `sk-or-v1-au7...890` in [Get current API key](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key.md) | true | — |

xAI management keys have no documented prefix: they are added with
`--provider xai --kind management_key`.

## Error mapping and free endpoints (phase 2, checked 2026-11-04)

Two sources: the official docs, and **live responses to deliberately fake keys** (random
strings with the right prefix; no real credential, free endpoints only). Live findings that
contradict the docs are marked ⚠.

| Provider | Item | Spec said | Docs / live say | Mecha does |
| --- | --- | --- | --- | --- |
| Anthropic | 402 | — | [Errors](https://platform.claude.com/docs/en/api/errors): 402 `billing_error` | Funds `empty`, red, «billing problem» |
| Anthropic | 401 | invalid | Docs: malformed, revoked **or expired** are all 401; live fake key: 401 `authentication_error` «invalid x-api-key» | Invalid, or expired if a known expiry passed |
| Anthropic | 400 at a spend limit you set | — | Docs: 400 when an org/workspace spend limit is reached; message text not documented | No mapping (`unknown`) |
| Anthropic | Tier spend cap | — | Docs: 429 without `retry-after`; indistinguishable from a rate limit by status alone | `throttled` |
| OpenAI | No credit | 429 `insufficient_quota` | [Error codes](https://developers.openai.com/api/docs/guides/error-codes): 429 `code: credit_balance_exhausted`; `type` may still be `insufficient_quota` | `empty` (both) |
| OpenAI | Spend limits | — | 429 `organization_spend_limit_exceeded`, `project_spend_limit_exceeded`, `organization_usage_limit_exceeded` | `capped` |
| OpenAI | Expired key | «verificar» | No specific code documented: 401 | Invalid (or expired with a known date) |
| OpenAI | Restricted key without `api.model.read` | — | Docs: missing permissions is a 401 cause and `/v1/models` needs `api.model.read`; the text «Missing scopes» is **not** in the docs | Amber «no permission» when the 401 message contains «missing scopes» / «insufficient permissions» |
| OpenAI | Invalid key (live) | 401 `invalid_api_key` | Live: 401 `invalid_api_key`, message already masks the key | Invalid |
| Gemini | Prepay depleted | 429 «prepayment credits are depleted» | [API errors](https://aistudio.google.com/docs/api-errors): **402** `payment_required`; the 429 text comes from a forum | `empty` (402 and the 429 variant) |
| Gemini | Invalid key | 400 `API_KEY_INVALID` | Docs: 401. Live: an `AIza` key gets 400 `INVALID_ARGUMENT` + `API_KEY_INVALID`; an `AQ.` key gets 401 | Invalid (both) |
| Gemini | `ACCESS_TOKEN_TYPE_UNSUPPORTED` | Known `AQ.` account issue | ⚠ Live: **every** invalid `AQ.` key gets this reason | Invalid plus a *hint* («if it works in AI Studio, see the known `AQ.` issue»), not a diagnosis |
| Gemini | Monthly spend cap | 429, `capped` («verificar texto») | Docs describe the caps but not the error; only a 10-minute spend rate limit is documented (429 `RESOURCE_EXHAUSTED`) | **No mapping** until the real error is seen |
| Gemini | 400/403 with `ErrorInfo.reason` | Generic «sin permiso» | [google.api.ErrorReason](https://github.com/googleapis/googleapis/blob/master/google/api/error_reason.proto) (checked 2026-11-05) | Amber when it depends on the caller (IP, referrer, Android/iOS app, VPC-SC, org restriction, TLS policy); red when it fails from anywhere (service blocked or disabled, billing disabled, project suspended or invalid, org policy, IAM denied). Reasons that cannot apply to an API key listing models fall back to «sin permiso». Texts in fixtures are built from the error model, not seen live |
| Gemini | Leaked key | «reported as leaked» | [Troubleshooting](https://aistudio.google.com/docs/troubleshooting): 403 «Your API key was reported as leaked. Please use another API key.» | `blocked` |
| Gemini | Models list | key in header | Docs example uses `?key=` in the URL; other examples use `x-goog-api-key` | Always the header; `pageSize=1000` (documented max) |
| xAI | Invalid API key | 401 | [Debugging](https://docs.x.ai/developers/debugging.md): 401. ⚠ Live: **400** `{"code": "invalid-argument", "error": "Incorrect API key provided…"}` | Invalid on 400 + «Incorrect API key» |
| xAI | Invalid management key | 401 | Live: 401 «Invalid bearer token. Please ensure you use a valid management key.» | Invalid |
| xAI | Management key prefix | «no documented prefix» | The validation example shows `xai-...r42q`: same prefix as API keys | Detected as API key; use `--kind management_key` |
| xAI | `GET /v1/api-key` times | — | Docs say «Unix timestamp», example shows ISO strings | Both accepted |
| xAI | Key list `disabled` | boolean | Docs example: `"disabled": "false"` (string) | Both accepted |
| xAI | Out of credit error text | «por verificar» | Not documented | No mapping (`unknown`) |
| xAI | Billing reads method | «verificar» | Phase 4 | — |

## Phase 4 (checked 2026-11-06)

| Provider | Item | Spec said | Docs say | Mecha does |
| --- | --- | --- | --- | --- |
| Anthropic | `count_tokens` as default probe | «verificar si devuelve el error de saldo» | [Token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting): free, own rate limit. Whether it returns the credit error is **not documented** | Paid `messages` (max_tokens 1) by default; free probe opt-in (`[probes] free = true`) |
| Gemini | `countTokens` reflects depleted prepay | «verificar» | Not documented | Paid `generateContent` (maxOutputTokens 1) by default; free probe opt-in |
| OpenAI | Admin reads | — | `GET /v1/organization/projects`, `.../projects/{id}/api_keys` (`redacted_value`, `last_used_at`, optional `expires_at`, `owner_project_access`), `admin_api_keys` | Only these GETs (plus `costs`) are allowed for an admin key |
| OpenAI | Costs API | — | `GET /v1/organization/costs`: `bucket_width` only `1d`, `limit` ≤ 180, `amount.value` + lowercase `currency`, `next_page` | Estimate = budget − sum since purchase; last bucket start shown as «up to» |
| xAI | Billing read methods | «verificar el método HTTP» | [Billing](https://docs.x.ai/developers/rest-api-reference/management/billing.md): `GET prepaid/balance`, `GET postpaid/spending-limits`, `GET postpaid/invoice/preview` | Only those GETs, on management-api.x.ai |
| xAI | Prepaid sign | — | Purchases are negative changes, spend positive; example `total: "-1000"` after buying 10 USD; invoice preview `prepaidCredits: "-4500"` | **Interpretation**: balance = −`total`/100. To confirm against the xAI console |
| xAI | When the API stops | — | «once the team has consumed all of the prepaid credits, and the postpaid usage amount has reached the user-set soft spending limit» | Available = prepaid + max(0, `effectiveSl` − `amountBeforeVat`); red only at 0 |
| xAI | Out-of-credit error text on chat completions | «por verificar» | Not documented | Unmapped (grey «check failed» if unexpected) |
| xAI | Model list | — | `GET /v1/models` (free) | Used to pick the probe model |
| All | Probe prices | — | Official pricing pages (see `capabilities.toml`, `prices_checked`) | Haiku 5.5 0.10/0.50, text-embedding-3-small 0.02, Gemini 3.5 Flash-Lite 0.30/2.50, grok-4.20 non-reasoning 1.25/2.50 USD per 1M tokens |
| Codex / Claude Code / Gemini CLI | Session file formats | undocumented | Undocumented (third-party sources) | Tolerant parsers; data marked `file`, unverified; tokens never stored |

## Notes for phase 4 (hint matching)

- Anthropic `partial_key_hint` uses three ASCII dots: `sk-ant-api03-R2D...igAA`.
- OpenAI `redacted_value` examples: `sk-abc...def`, `sk-admin...def`.
- Matching generates each provider's hint format from the decrypted secret; it never
  compares against Mecha's own `redacted` form.

## Scan: known locations (checked 2026-11-09)

`mecha scan` reads these by default, even where the home walk does not go (e.g. `~/Library`
on macOS). Project-level files (`.cursor/mcp.json`, `.vscode/mcp.json`, `.mcp.json`,
`.devin/mcp_config.json`, `.continue/…`) are found by the walk.

| Tool | macOS | Linux | Windows | Source |
| --- | --- | --- | --- | --- |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | `~/.config/Claude/claude_desktop_config.json` | `%APPDATA%\Claude\claude_desktop_config.json` | [modelcontextprotocol.io](https://modelcontextprotocol.io/docs/develop/connect-local-servers) |
| Cursor | `~/.cursor/mcp.json` | same | `%USERPROFILE%\.cursor\mcp.json` | [cursor.com/docs/context/mcp](https://cursor.com/docs/context/mcp) (gives `~` only) |
| VS Code | `~/Library/Application Support/Code/User/mcp.json` and `profiles/*/mcp.json` | `~/.config/Code/User/…` | `%APPDATA%\Code\User\…` | [MCP configuration](https://code.visualstudio.com/docs/agents/reference/mcp-configuration), [Profiles](https://code.visualstudio.com/docs/configure/profiles) (User folder = parent of `profiles`); also `Code - Insiders` and `~/.copilot/mcp-config.json` |
| Windsurf (now Devin Desktop) | `~/.config/devin/mcp_config.json` | same | same under `%USERPROFILE%` | [docs.devin.ai](https://docs.devin.ai/desktop/cascade/mcp) (docs.windsurf.com redirects there) |
| Windsurf (old path) | `~/.codeium/windsurf/mcp_config.json` | same | same | **Not in the current docs**; scanned as a legacy path |
| Continue | `~/.continue/config.yaml` (and `config.json`), `~/.continue/mcpServers/*` | same | `%USERPROFILE%\.continue\…` | [Understanding configs](https://docs.continue.dev/guides/understanding-configs), [MCP](https://docs.continue.dev/customize/deep-dives/mcp) |
| Continue secrets | `~/.continue/.env` | same | same | **Unverified**: only in mirrors of Continue's docs |

| Shell history | Path | Source |
| --- | --- | --- |
| bash | `~/.bash_history` (`HISTFILE` default); timestamps as `#…` comment lines | [GNU Bash manual](https://www.gnu.org/software/bash/manual/html_node/Bash-Variables.html) |
| zsh | No default `HISTFILE` in zsh; macOS sets `~/.zsh_history` in `/etc/zshrc`; extended format `: <time>:<elapsed>;<command>` | [zsh Parameters](https://zsh.sourceforge.io/Doc/Release/Parameters.html), [Options](https://zsh.sourceforge.io/Doc/Release/Options.html) |
| `$HISTFILE` | When exported | |
| fish | `~/.local/share/fish/fish_history` (or `$XDG_DATA_HOME/fish/`; `<session>_history` with `fish_history`) | [fish interactive use](https://fishshell.com/docs/current/interactive.html) |
| PowerShell (PSReadLine) | `%APPDATA%\Microsoft\Windows\PowerShell\PSReadLine\<host>_history.txt`; elsewhere `$XDG_DATA_HOME/powershell/PSReadLine` or `~/.local/share/powershell/PSReadLine`. PSReadLine skips lines containing `apikey`, `token` or `secret`, but not `API_KEY` | [about_PSReadLine](https://learn.microsoft.com/en-us/powershell/module/psreadline/about/about_psreadline) |
| macOS Terminal sessions | `~/.zsh_sessions/*.history*`, `~/.bash_sessions/*.history*` | `/etc/zshrc_Apple_Terminal`, `/etc/bashrc_Apple_Terminal` (on the system) |
