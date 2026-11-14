# Server mode — axuse on Ubuntu servers (no desktop, no display)

Server mode is the supported lane for running axuse under agent CLIs (Codex,
Claude Code, OpenCode, …) on a headless **Ubuntu server**: **fully HEADED
Chrome on an auto-provisioned X virtual framebuffer (Xvfb)**.

It exists because of one fact this repo's live testing keeps confirming:
challenge and anti-bot systems (Cloudflare Turnstile, DataDome, Geetest,
AWS WAF, reCAPTCHA, slider gates) check *is this a headless browser?* as
their **first step**. `--headless` / `--headless=new` is a detection signal,
not a workaround. A headed Chrome rendering into a private Xvfb has no
headless fingerprint at all: real window, real font stack, real raster
pipeline, WebGL (software fallback), windowed viewport — every signal a
human-driven desktop Chrome has.

```
server (no DISPLAY) ── ax_open ──► auto-boot private Xvfb (:NNN, 1920x1080x24)
                              └─► HEADED Chrome on it (never --headless)
                                  · UA has no "Headless" substring
                                  · navigator.webdriver === false (neutralized)
                                  · WebGL present (SwiftShader fallback re-enabled)
                                  · trusted CDP input — the solver lane works as-is
```

Nothing about the model-facing surface changes: `ax_open`, `ax_observe`,
`ax_click`, `ax_solve_captcha {provider}`, sliders, screenshots — all work
exactly as on a desktop. The `ax_open` result carries the fact so the agent
(and you) can see it:

```
display: :762 (virtual 1920x1080 — headed on Xvfb, server mode)
```

## One-time server setup

Two lanes. **No-sudo lane** (containers, restricted hosts — axuse provisions
a pinned Chrome-for-Testing under `~/.cache/axuse/browsers`, zero system
changes, full posture verified on that build):

```bash
sudo apt-get install -y nodejs xvfb fonts-liberation fonts-dejavu-core fontconfig
node src/cli.js install-browser            # or: --version 156.0.8078.47 to pin a fleet
node src/cli.js doctor                     # must say: "server mode: ready"
```

Fleets: mount a cached volume at `AXUSE_MANAGED_BROWSER_DIR` and every box
runs the exact same pinned build (one download, run everywhere; axuse picks
the managed build up ahead of distro packages automatically).

**Distro lane** (Google's apt repo or CfT by hand — any Chromium-family
build works; `AXUSE_BROWSER` points at it):

```bash
sudo apt-get install -y google-chrome-stable   # from Google's repo
node src/cli.js doctor
```

Fonts are not cosmetic: without fontconfig + font packages, text renders as
boxes, every screenshot is garbage, and vision-based solvers (slider
geometry crops, icon puzzles) fail. `doctor` checks this.

## Wire it into the harness on the server

Same as on a desktop — the MCP server does the rest:

```bash
codex mcp add axuse -- node /srv/axuse/src/cli.js mcp
claude mcp add --scope user axuse -- node /srv/axuse/src/cli.js mcp
node src/cli.js print-config --harness opencode   # or agy | generic
```

`doctor` under the service user must print the `server mode: ready` line
before you rely on it.

### systemd service (the whole browser stack under one cgroup)

One service per long-running harness. `KillMode=control-group` guarantees
the private Xvfb dies with the agent process — no orphans:

```ini
# /etc/systemd/system/codex-axuse.service
[Service]
Type=exec
User=codex-agent
Environment=AXUSE_BROWSER=/usr/local/bin/axuse-chrome
Environment=CAPTCHA_PRO_VISION_KEY=sk-or-v1-…        # solver vision key (see below)
# Environment=AXUSE_PROFILE_DIR=/var/lib/axuse/profiles
ExecStart=/usr/bin/codex            # or claude / opencode serve
KillMode=control-group
Restart=on-failure
```

For one-shot / cron-style runs no service is needed — `axuse solve`,
`axuse open-urls` and the MCP server all boot and reap their own Xvfb.

## Environment reference (server lane)

| variable | effect |
|---|---|
| `AXUSE_SERVER_MODE` | `auto` (default) — boot a private Xvfb when Linux + no live display. `0`/`off` disables it (headed launches then fail typed with guidance). |
| `AXUSE_DISPLAY_SIZE` | Virtual display geometry, default `1920x1080x24`. `random` = fleet lane: one **stable geometry per machine** (hostname+uid hash), spread across the weighted common-consumer list — identical fleet viewports are a cross-account correlation signal. |
| `AXUSE_TIMEZONE` | IANA zone for the Chrome process (`TZ`): drives `Date`/`Intl` in pages AND workers. Set it to the **egress persona's** zone — a UTC server behind a US residential exit is a classic timezone-mismatch score. Validated by `doctor`. |
| `AXUSE_LANG` | `--accept-lang` for Chrome (verified live: `--lang` alone does **not** move `navigator.language`): sets `navigator.language`/`languages` **and** the `Accept-Language` header. |
| `AXUSE_FP_CORES` / `AXUSE_FP_MEMORY` | Opt-in persona caps: a 96-core server's honest `hardwareConcurrency` is a persona mismatch for residential-looking traffic. `AXUSE_FP_CORES=8` overrides `navigator.hardwareConcurrency`; `AXUSE_FP_MEMORY` overrides `navigator.deviceMemory` — only where the platform exposes the API (never invents it). Honest hardware stays the default. |
| `AXUSE_PROXY` | Per-process default for the per-launch `proxy` param: `"http://host:port"`, `"socks5://user:pass@host:port"` — one browser instance per spec, credentials answered over CDP. |
| `AXUSE_PROXY_BYPASS` | Chrome proxy bypass list override (default: loopback bypassed so local fixtures work; `"<-loopback>"` includes localhost). Proxied launches also get the WebRTC `disable_non_proxied_udp` profile pref (measured: the command-line switch is ignored) and quiet-egress flags (no background component/metrics traffic through the persona). |
| `AXUSE_AMBIENT_MOTION` | `0` disables idle pointer park-fuzz; default `auto` = on exactly in server mode. |
| `AXUSE_MAX_BROWSERS` | Governance cap: concurrent launched browsers per process (default 8) — a per-proxy fan-out fails typed at the cap instead of OOM-killing the box. |
| `AXUSE_MAX_TABS` | Governance cap: concurrent tabs per process (default 48). |
| `AXUSE_EGRESS_ECHO_URL` / `AXUSE_EGRESS_GEO_URL` | Endpoints for `axuse posture --verify-egress` (defaults: ipify + ipapi.co; `{ip}` placeholder). |
| `AXUSE_MANAGED_BROWSER_DIR` | Where `axuse install-browser` puts the pinned Chrome-for-Testing build (default `~/.cache/axuse/browsers`) — mount a cached volume here for fleets. |
| `AXUSE_NO_SANDBOX` | `1` forces `--no-sandbox`. Auto-applied anyway when running as root (containers) — Chrome refuses root otherwise. |
| `AXUSE_BROWSER` | Path to the browser binary (as on any host). |
| `AXUSE_PROFILE_DIR` | Where browser profiles go (defaults to the OS temp dir). |
| `AXUSE_NEUTRALIZE_WEBDRIVER` | `0` disables the `navigator.webdriver` posture fix (see below). Default: on. |
| `AXUSE_HEADLESS` | **Do not set on servers with challenge traffic.** Forces `--headless` for every launch — the exact signal anti-bot systems look for. It stays available for trusted internal pages. |

Every knob is checked by `node src/cli.js doctor` — run it first, it tells
you what is missing (Xvfb, fonts, root sandbox, a stray `AXUSE_HEADLESS`).

## Vision solvers on servers (the multimodal LLM by API)

Solver plugins that need eyes (slider geometry on cross-origin crops, icon
puzzles) call a vision model through a plain OpenAI-compatible HTTP API —
that already *is* the server shape; no local model, no GUI needed:

| plugin env | default |
|---|---|
| `<PREFIX>_VISION_KEY` | (required) e.g. an OpenRouter key |
| `<PREFIX>_VISION_BASE` | `https://openrouter.ai/api/v1` |
| `<PREFIX>_VISION_MODEL` | plugin default (e.g. `google/gemini-4-argon`) |
| `<PREFIX>_VISION_FALLBACK_MODEL` | (optional) one escalation attempt when the primary model is degraded — provider outage, rate limits, a model retired mid-run |

`<PREFIX>` is the plugin's env namespace (`CAPTCHA_PRO_*`, `CHALLENGE_*`).
The base accepts any OpenAI-compatible endpoint — OpenRouter (default,
one key, many models), OpenAI, Gemini's OpenAI-compat endpoint
(`https://generativelanguage.googleapis.com/v1beta/openai`), Anthropic's
(`/v1/chat/completions`), or a private gateway/proxy.

### Storing keys on a server (no macOS Keychain there)

- env vars (systemd `Environment=`, shell profile), **or**
- the axuse secrets file — the server-side Keychain equivalent:

```bash
mkdir -p ~/.config/axuse
# keys are the plugin account slug OR the env-var name; owner-only mode
cat > ~/.config/axuse/secrets.json <<'EOF'
{
  "captcha-pro-vision": "sk-or-v1-…",
  "challenge-vision": "sk-or-v1-…"
}
EOF
chmod 600 ~/.config/axuse/secrets.json
```

`AXUSE_SECRETS_FILE` overrides the path. A file the group/world can read is
refused (fix: `chmod 600`). Typed failure messages name the exact options.

## Input realism (human-shaped trusted events)

All input is CDP-trusted (`isTrusted` events). The **default** paths stay
fast for agent productivity (bulk insert, direct press). Two lanes add the
dynamics human-sampling systems look for — used automatically by the solver
plugins where it matters:

- **`ax_click {human: true}`** — a jittered curved mouse approach
  (3–6 eased moves, 120–320 ms, 1–3 px overshoot-and-settle, dwell) before
  the press. The captcha-pro Turnstile checkbox click and the
  challenge-handler puzzle/confirm clicks use it.
- **`ax_type {human: true}`** — per-key trusted events (keydown→hold→keyup
  per char, 45–160 ms gaps, 6% thinking pauses, word-boundary slowdowns)
  with real layout key codes — for login/challenge fields where keystroke
  dynamics are sampled. Solver context: `ctx.type({..., human: true})`.
- **`ax_fill {human: true}`** — the human lane for WHOLE FORMS (the login
  flow itself): every field gets a human focus click + per-key typing;
  checkboxes/selects/sliders keep their trusted-input paths. Live-tested
  across a two-field credential form.
- **Sliders/interstitials** already move humanly (the challenge-handler's
  bezier trajectory engine with ≥8 velocity maxima and sub-8 ms jitter).
- **Ambient park-fuzz** (server mode default, `AXUSE_AMBIENT_MOTION=0`
  opts out): agent loops freeze for seconds between tool calls while they
  think — a pointer that NEVER moves between bursts is a correlation
  signal. Between (and during waiting) commands, axuse dispatches trusted
  micro-jitter (±1–3 px with rare 8–20 px excursions, 1.4–4.2 s cadence)
  anchored to the last action position. It pauses for every
  pointer-holding command and whenever a dialog is open — precision always
  wins over entropy.

## Per-instance personas (one process, N exits, N coherent identities)

`ax_open {timezone, lang}` override `AXUSE_TIMEZONE`/`AXUSE_LANG` **per
browser instance** — with per-launch `proxy`, one agent process hosts one
coherent persona per exit (a Tokyo-clock browser through the Tokyo exit, a
New-York-clock browser through the US exit, simultaneously). A different
persona is a different browser (never a mutation of a live one); the same
persona reuses its browser. Solver results and `axuse posture` report the
instance persona.

The persona params ride on **every surface that launches a browser**:
`ax_solve_captcha {url, proxy, timezone, lang}` (a solve that opens its own
page opens it as a coherent persona), `ax_open_many {proxy, timezone, lang}`
(one persona for a whole scraping batch), and the CLI
(`axuse solve --proxy --timezone --lang`).

## WebRTC: the leak beside proxied personas (measured, then closed)

With a proxy, HTTP leaves through the exit — but WebRTC STUN/srflx
candidates otherwise leave through the **real interface**: the page sees
the proxy IP on HTTP and the datacenter IP on WebRTC in one session (the
classic VPN-leak mismatch detector). Measured on Chrome 151: the
`--force-webrtc-ip-handling-policy` switch is **ignored** by current
builds (STUN went direct, zero CONNECTs through the proxy); the
`webrtc.ip_handling_policy` profile pref is **honored** (zero candidates
through a proxied launch). axuse writes the pref into the profile (merged,
never clobbering a persistent profile) whenever a launch is proxied —
mDNS host candidates remain, so the surface is a real Chrome-behind-VPN
shape, not a disabled one. `axuse posture` probes this live and warns on
any public candidate beside a proxied exit.

## Egress: one browser, one proxy (per-instance routing)

For fleets, each browser instance can leave through its own proxy —
`ax_open {url, proxy: "socks5://user:pass@host:port"}` or `AXUSE_PROXY`
for the process. Credentials never ride the launch flag (Chrome ignores
them there); they are answered over CDP when the proxy challenges (the
full 407 → auth → credentialed-retry round trip is covered by a live test
against a local fixture proxy). Loopback stays bypassed by default so
local fixtures keep working; override with `proxy_bypass` /
`AXUSE_PROXY_BYPASS` (e.g. `"<-loopback>"` for proxy testing). One proxy
spec = one browser instance (different specs never share a launch).

Combine with `AXUSE_TIMEZONE`/`AXUSE_LANG` so the whole persona — IP,
clock, languages — is coherent per instance.

Every `ax_solve_captcha` / `axuse solve` result carries **posture facts**
(`headed-on-virtual-display` / `headed` / `headless`, plus the virtual
display and the credentials-stripped egress endpoint) — and a loud warning
when the browser was headless, since challenge pages detect that shape
first. Agents and operators see exactly which browser shape fought the
challenge.

Note: a plugin that re-enables CDP `Fetch` with its own interception
patterns takes over interception for that session and may drop the proxy
auth subscription for those requests (documented integration seam).

## Audio posture (honest, measured)

On a GPU-less, sound-server-less host: `AudioContext` starts `suspended`
and `resume()` before any user gesture stays pending — **exactly what a
real desktop Chrome does** under the default autoplay policy.
`OfflineAudioContext` — the actual audio-fingerprint vector — renders
identically (pure math, verified live). If your flow needs audible audio
after a gesture, run a sound server (`sudo apt install pipewire-pulse`).

## Persona coherence (the parts headless-vs-headed does not cover)

Being headed removes the *headless* class of signals. A second class is
**persona coherence**: the browser's persona must match the egress persona
(the IP it leaves through). Servers fail this class by default — a UTC
clock behind a US residential exit, `en-US` behind a German IP, 96 cores in
a "consumer" session, a fleet where every account shows the exact same
1920x1080 canvas hash:

```bash
AXUSE_TIMEZONE=America/New_York      # Date/Intl in pages AND workers (TZ)
AXUSE_LANG=en-GB                     # navigator.language(s) + Accept-Language
                                     #   + Intl default locale (LC_ALL — see below)
AXUSE_DISPLAY_SIZE=random            # stable geometry per machine, fleet spread
AXUSE_FP_CORES=8                     # optional persona cap for big servers
AXUSE_FP_MEMORY=8                    # optional; only where the API exists
```

`AXUSE_LANG` mechanics (measured live, Chrome 151): `--accept-lang` drives
`navigator.language`/`languages` and the `Accept-Language` header — but the
**Intl default locale follows the process locale env, not any Chrome flag**
(`--lang` alone changes neither). axuse therefore derives `LC_ALL`/`LANG`
(`en-GB` → `en_GB.UTF-8`) for the browser process so Intl, navigator and
headers all agree. The locale must be **generated on the host** or Intl
silently falls back: `sudo locale-gen en_GB.UTF-8 && sudo update-locale` —
`doctor` checks `locale -a` and tells you exactly this.

`--disable-blink-features=AutomationControlled` is passed on every launch
(verified live on Chrome 151): with remote debugging active, Chrome reports
`navigator.webdriver === true` in **every context** — main frames and
cross-origin iframes — a fingerprint the *harness itself* creates, present
on no human-driven Chrome. The flag turns it off **at the source**.

**Tamper-visibility discipline** (the subtle part): replacing Chrome's
native getter — even with one returning the same value — changes the
prototype descriptor into JS source a page can read (the classic
`getter.toString().includes("[native code]")` check; we measured ourselves
guilty of this before fixing it). So the pre-document script patches
`webdriver` **only when the flag did not already fix it** (`if
(navigator.webdriver !== false)`), and its fallback/persona-cap getters are
toString-masked to present native source at the descriptor level. On
flag-working builds the script touches nothing at all. Honest limit: a
`Function.prototype.toString.call(getter)` bypass can still see through a
masked fallback getter — this is why the source-level flag, not the script,
is the primary mechanism (`AXUSE_NEUTRALIZE_WEBDRIVER=0` removes the
fallback entirely).

Everything is measured and printed by `doctor` (posture + persona lines in
the smoke test), and asserted by `test/server-mode.test.js`.

## Scaling out (massive operations)

- **One private Xvfb per axuse process** (display numbers are picked away
  from live ones; the display survives browser restarts within the
  process). N agent processes → N isolated displays, no contention, no
  shared mouse/keyboard state — unlike one shared desktop.
- **Bounded batches**: `ax_open_many {urls:[…]}` (≤100/round) for scraping
  lanes; solver traffic stays on one tab via `ax_solve_captcha {provider}`.
- **Aged sessions**: persistent profiles (the session-vault plugin, or
  `profile_dir`) survive process restarts — warmer profiles pass challenges
  more often. Server mode keeps killed profiles from waking up behind the
  "restore pages?" bubble.
- **Containers**: root runs get `--no-sandbox` automatically; small
  `/dev/shm` is mitigated automatically (`--disable-dev-shm-usage`);
  `doctor` reports both.
- **Cleanup**: the Xvfb is a child of the axuse process — normal exits and
  process-group kills reap it; under systemd use `KillMode=control-group`.
  A `kill -9`ed harness can still leak an orphaned Xvfb; server mode sweeps
  those at the next boot (only processes matching axuse's exact Xvfb launch
  signature whose parent is gone — verified by pattern tests, never a
  foreign X server). `doctor` reports them without killing.

## What is deliberately NOT done

- **No headless for challenge pages.** Ever. That is the whole point.
- **No DOM tampering with challenge logic.** The only page-level patch is
  the `navigator.webdriver` posture fix, applied at the source via a launch
  flag (a pre-document script as fallback): modern Chrome sets it to `true`
  merely because a DevTools client is attached — a fingerprint of *our own
  plumbing*, present on no human-driven Chrome. axuse restores the exact
  value a human browser reports (`false`), in every frame — and the script
  touches nothing on builds where the flag already fixed it (tamper-
  visibility is asserted by live tests: the prototype getter stays
  **native**). It does not fake, answer or shortcut any challenge — solvers
  still click real widgets with trusted input. Opt out:
  `AXUSE_NEUTRALIZE_WEBDRIVER=0`.
- **No invented hardware.** The WebGL renderer string stays the honest
  one (SwiftShader/ANGLE software — what every GPU-less Linux desktop
  reports too); `hardwareConcurrency`/`deviceMemory` stay honest unless the
  operator opts into the persona caps. The deviceMemory override only
  applies on platforms that expose the API — never inventing an API surface
  the platform's real Chrome lacks.
- **No egress-traffic tricks.** JA4/TLS and HTTP/2 fingerprinting live
  below the page layer — the customer's proxy vendor's product (documented
  integration point: bring your own egress).
- **No fabricated results.** Solvers report `solved: false` honestly when
  a page hard-blocks; `doctor` and tests state measured numbers.
- **A dead exit falls back to direct.** If the proxy dies mid-session,
  Chrome silently retries traffic DIRECT — the persona leaks at the IP
  layer until the next launch (the WebRTC fix holds; HTTP does not). No
  Chrome flag disables proxy fallback. Fleet practice: health-check exits
  on a schedule (`axuse posture --verify-egress` reports the live exit IP)
  and restart the lane when an exit dies — the persona is re-established
  on the next browser launch.
- **Measured, not assumed, on the CDP surface**: the classic console-getter
  DevTools detector (logging a getter-carrying object) does **not** fire
  against raw CDP — `Runtime.consoleAPICalled` serialization never invokes
  getters (measured on Chrome 151 with axuse's exact attach sequence; the
  detector targets the DevTools UI, not the protocol). `Runtime.evaluate`
  also works without `Runtime.enable` — ours is kept only for the
  console-error ring (a debugging fact agents can act on), costing nothing
  measurable. Both facts are pinned by live tests.

## Auditing a fleet (one command, machine-checkable)

`axuse posture` measures the live browser — the same facts the tests pin,
productized:

```bash
node src/cli.js posture                      # human report
node src/cli.js posture --json               # CI/consumers; exit 1 on FAIL
node src/cli.js posture --verify-egress      # + the exit IP's geo vs AXUSE_TIMEZONE
```

Checks (fail = exit 1): headed UA, `navigator.webdriver` false **via a
native getter**, WebGL present, PDF plugin surface; persona coherence
(clock vs `AXUSE_TIMEZONE`, navigator/Intl vs `AXUSE_LANG`, with the
`locale-gen` hint when Intl never took); audio fingerprint health. Info
lines: browser shape (virtual display / egress), fingerprint surface,
notifications. `--verify-egress` fetches the IP echo **through the
browser** (through the proxy when configured) and warns when the exit's
geography contradicts the persona clock — the misconfiguration challenge
pages would otherwise catch (caught a real one during development: a
Swiss exit behind an `America/New_York` persona). Echo/geo endpoints are
configurable (`AXUSE_EGRESS_ECHO_URL`, `AXUSE_EGRESS_GEO_URL`). The CI
`linux-server` lane pins the detector itself: a deliberately mismatched
persona (Tokyo clock through the runner's US exit) must produce the
warning whenever the geo service answers.

`doctor` also reports **browser currency** (best-effort, INFO on offline
hosts): the running major vs the current CfT stable — a persona several
majors behind is its own signal (distro Chrome drifts with
unattended-upgrades; `install-browser --version` pins deliberately).

## Verify it (all commands runnable on the server)

```bash
node src/cli.js doctor
# server mode: ready — no live X display; headed Chrome will auto-boot a
#   private Xvfb (1920x1080x24, NOT headless — anti-bot-safe; …)
# persona: timezone not overridden (Chrome uses this host's TZ, currently …)
#   — set AXUSE_TIMEZONE to the egress persona's zone when routing through a proxy
# stale Xvfb zombies: N leaked … (only printed when found; swept at next boot)
# fonts: … (only printed when fonts are missing)
# smoke test: server mode — booting a virtual display, launching HEADED Chrome…
# server-mode facts: display :895 (virtual) · UA headed (no Headless substring)
#   · navigator.webdriver false · viewport 1919x992 · WebGL present (ANGLE (Google, Vulkan … SwiftShader))
# server-mode persona: tz Europe/Vienna · language en-US · cores 16 · deviceMemory undefined
# server-mode anti-bot posture: OK — indistinguishable headed build

node --test test/server-mode.test.js     # the same assertions, in CI and locally
```
