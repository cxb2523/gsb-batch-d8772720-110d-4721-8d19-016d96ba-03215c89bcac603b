# macOS Support — Production Guide

axuse treats macOS as a first-class platform, not a port. This document is
the complete reference: what is supported, how permissions work, how failures
are classified, how to run the matrix, and what remains out of scope with
evidence.

- [Support matrix](#support-matrix)
- [TCC permissions model](#tcc-permissions-model)
- [Failure taxonomy](#failure-taxonomy)
- [First-run, stale grants, and recovery](#first-run-stale-grants-and-recovery)
- [Headless and CI environments](#headless-and-ci-environments)
- [Platform conventions axuse applies](#platform-conventions-axuse-applies)
- [Testing lanes](#testing-lanes)
- [Performance characteristics](#performance-characteristics)
- [Known limitations (documented blockers)](#known-limitations)
- [Release checklist](#release-checklist)
- [Migration notes](#migration-notes)

## Support matrix

| Capability | macOS 14 (Sonoma) | macOS 15 (Sequoia) | macOS 26 (Tahoe) | Notes |
|---|---|---|---|---|
| Browser tools (`ax_*`, CDP backend) | ✅ | ✅ | ✅ (this doc's evidence) | Intel + Apple Silicon |
| OOPIF frames, dialogs, popups, downloads events | ✅ | ✅ | ✅ | Same CDP surface as Windows/Linux |
| Trusted input in pages (`Input.dispatch*`) | ✅ | ✅ | ✅ | macOS native key codes + `commands` editing mapping |
| Browser screenshots (`Page.captureScreenshot`) | ✅ | ✅ | ✅ | CSS-px scale-1 contract |
| Extension bridge (native messaging + `chrome.debugger`) | ✅ | ✅ | ✅ | See browser matrix below |
| Desktop driver (`ax_desktop_*`) | opt-in | opt-in | opt-in | `AXUSE_ENABLE_MACOS_CUA=1` + TCC grants |
| **Desktop AX structure layer** (`ax_desktop_ax_*`: snapshot/refs/click/set/read) | ✅ with Accessibility | ✅ with Accessibility | ✅ (protocol-verified; granted paths in the manual lane) | System Events AX tree — structure-first desktop, browser-observe style |
| Desktop screenshots (`screencapture`+`sips`) | ✅ with grant | ✅ with grant | ✅ with grant (live-verified) | Display-point contract, Retina-normalized |
| Native input (CGEvent via JXA) | ✅ with grant | ✅ with grant | ✅ with grant | Never runs silently; opt-in only |

Verified Node: 22 LTS and 24 LTS. Architecture evidence: arm64 (M1, macOS
26.6) locally; Intel via the `macos-15-intel` CI lane.

### Browser matrix (macOS, verified 2026-10-19)

| Browser | CDP backend | Extension bridge | Notes |
|---|---|---|---|
| Google Chrome (branded, stable 155) | ✅ | n/a¹ | ¹macOS branded Chrome silently ignores `--load-extension`; load the bridge unpacked in your daily profile, or use another browser for automated extension lanes. |
| Google Chrome Beta / Canary | ✅ | n/a¹ | **Live-verified this audit**: the `--load-extension` policy covers ALL branded Chrome channels — Beta and Canary both refuse automated extension loading (extension never dials in). The extension-capable lane excludes every branded Chrome channel; the manual unpacked path still works. |
| Chrome for Testing (155) | ✅ | ✅ | Primary CI browser; native messaging verified. |
| Chromium trunk (r1721585 / v158) | ✅ | ⚠️² | ²Trunk stall on headless `Page.navigate` — axuse auto-falls back to `location.href` (one RPC timeout on the first stall); CDP backend unaffected. |
| Microsoft Edge (stable 155) | ✅ | ✅ | Full chain verified: NM → hub → debugger → click. |
| Microsoft Edge Beta | ✅ | ✅ | **Live-verified this audit**: NM (profile-local manifest under the Edge Beta dir) → hub → debugger → click, full chain. |

## TCC permissions model

The macOS desktop driver is **opt-in twice**: the environment must set
`AXUSE_ENABLE_MACOS_CUA=1`, and macOS must have granted the host binary both
privileges. axuse never requests grants silently:

- **Probes are non-interactive.** `permissions()` uses `AXIsProcessTrusted()`
  and `CGPreflightScreenCaptureAccess()` — neither can open a TCC prompt.
  The test suite enforces this (`desktop.test.js`: "probe scripts never
  request a TCC prompt").
- **Operations fail closed and typed.** Without the grants, every desktop
  op raises `DESKTOP_PERMISSION_REQUIRED` with the exact System Settings path
  and no side effects. Input is never posted; nothing is captured.
- **The grant belongs to the exact binary** that runs axuse (your Terminal,
  IDE, or node). A grant to a different app does not transfer.

Grant procedure (human step, by design):

1. System Settings → Privacy & Security → **Accessibility** → add the host.
2. System Settings → Privacy & Security → **Screen Recording** → add the host.
3. **Restart the host** if it was running when Screen Recording was granted
   (macOS applies capture grants to new processes only).
4. Verify: `AXUSE_ENABLE_MACOS_CUA=1 axuse doctor` — it prints the detected
   permission state, probes native event construction (posting nothing), and
   attempts a 1×1 px capture when allowed.

## Failure taxonomy

Every macOS desktop failure is a typed `AxError`, never a bare string:

| Code | Meaning | Agent action |
|---|---|---|
| `DESKTOP_DRIVER_UNAVAILABLE` | macOS driver not enabled (`AXUSE_ENABLE_MACOS_CUA` unset) or platform has no driver | Enable or use `ax_*` browser tools |
| `DESKTOP_PERMISSION_REQUIRED` | TCC grant missing, or an op failed with a permission-classified error | Grant per hint, retry; stale-grant hint includes `tccutil reset` guidance |
| `DESKTOP_OP_FAILED` | Native op failed (bad output, headless session, unsupported gesture) | Read hint; headless hint points to `ax_*` |
| `BAD_COORDS` | Rect outside the active display layout or non-finite values | Call `ax_desktop_screen_info`, keep the crop in bounds |
| `COMMAND_REJECTED` | Invalid params (button, steps, quality) | Fix inputs |
| `SCREENSHOT_BUDGET_EXCEEDED` | Even lowest-quality encode exceeds budget | Smaller crop or higher budget |
| `TIMEOUT` | Native command exceeded 15 s | Retry |

Denied-state matrix (all verified live on macOS 26 with both grants denied):

| State | Probe result | Operation result |
|---|---|---|
| Accessibility denied | `permissions().accessibility === false` | `move`/`click`/`type`/`press` → `DESKTOP_PERMISSION_REQUIRED` |
| Screen Recording denied | `permissions().screen_recording === false` | `screenshot` → `DESKTOP_PERMISSION_REQUIRED` before any capture attempt |
| Probe unavailable (old OS/headless) | `screen_recording === null` | Op proceeds; the failing native call is classified from its stderr |

## First-run, stale grants, and recovery

- **First run**: nothing prompts. Probes report `false`; ops fail typed.
- **Stale grant** (host binary moved/updated, TCC still trusts the old path):
  preflight may pass while the op fails. axuse classifies the failure
  (`could not create image from display` / `operation not permitted`) as
  `DESKTOP_PERMISSION_REQUIRED` with the stale-grant hint: restart the host,
  then `tccutil reset ScreenCapture` / `tccutil reset Accessibility` if it
  persists.
- **Recovery**: probe results are cached for 5 s and **invalidated on every
  permission-classified failure** — a grant made after a denial is visible on
  the next operation without restarting axuse. (macOS itself may still
  require a host restart for Screen Recording; that is OS behavior and the
  error hint says so.)
- **Display changes**: cached layout is re-probed once when a caller's rect
  falls outside it (monitor plugged/unplugged, resolution change) before the
  coordinates are rejected.

## Headless and CI environments

GitHub-hosted macOS runners have a WindowServer session but **no TCC grants**:
the suite exercises discovery/probe/typed-denial paths there, and the granted
paths run in the manual lane. In truly headless sessions (SSH, CI services
without a GUI), display probes report the condition with a typed hint to use
the `ax_*` browser tools — never a hang or a generic failure.

## Platform conventions axuse applies

- **The desktop is structure-first too (AX layer)**: `ax_desktop_ax_snapshot`
  reads the target app's accessibility tree through System Events (same
  Accessibility grant as input) — roles, titles, values, bounds, and
  budgeted, live-re-resolved refs (`ax1.2.1` style paths). Act with trusted
  AXPress (`ax_desktop_ax_click`, with an automatic CGEvent coordinate
  fallback when an app refuses programmatic press), set writable text
  fields with read-back verification (`ax_desktop_ax_set`), and re-read
  elements (`ax_desktop_ax_read`). Stale refs fail typed `REF_NOT_FOUND`
  with a reobserve hint — the browser vocabulary, applied to native apps.
  One Apple Event per node (`properties`), 250-node/depth-10 budgets with
  honest truncation facts.
- **Coordinates**: macOS global display points everywhere (`CGDisplayBounds`
  / CGEvent space); screenshots are sips-resized to point dimensions so a
  pixel in the image maps 1:1 onto a click coordinate on Retina.
- **Window rows carry geometry**: `ax_desktop_windows` returns per-window
  `bounds {x,y,w,h}` in the same display-point space (titles+bounds need the
  Accessibility grant; without it you get honest process-level rows and the
  `window_access` field says so). The **frontmost app's rows come first**
  and carry `frontmost: true` (plus a top-level `frontmost_pid`) — the row
  an agent usually wants. One Apple-Event walk costs ~0.7–1 s on a busy
  Mac — an anchor call, not a poll. Typing `""` is a guaranteed no-op (no
  spawn, no permission path).
- **Gestures never interleave**: every input op (move/click/drag/wheel/type/
  press/activate) is serialized on one chain, and a failed drag releases its
  held button inside the same chain slot — concurrent calls can never
  interleave down/up pairs.
- **Scroll direction is preference-aware**: `ax_desktop_scroll`/`wheel` uses
  the browser-tool contract (dy>0 = content down) regardless of the user's
  Natural Scrolling setting; the CG delta is flipped per
  `com.apple.swipescrolldirection` (read once, cached).
- **Activate is pid-addressed**: `ax_desktop_activate` accepts a `pid` (most
  robust), exact `title`, or `window_id` from the windows call.
- **Key codes**: two vocabularies, both frozen and tested — CDP input uses
  macOS `nativeVirtualKeyCode` (F1–F20, keypad, punctuation row, editing
  modifiers; `commands: ["selectAll"|"copy"|…]` for ⌘-editing combos); the
  desktop driver uses AppleScript key codes including F13–F20.
- **Shortcuts**: `ax_press {platform:true}` translates Windows-convention app
  shortcuts to the OS convention (macOS: `ctrl+alt+1` → `cmd+alt+1`,
  `ctrl+end` → `cmd+end`). Literal Control combos remain available for
  terminals/devtools. Select-all is `meta+a` on macOS automatically.
- **Double-click**: one CGEvent batch whose second press/up pair carries
  `kCGMouseEventClickState = 2` — what Cocoa requires to register a real
  double-click (timing alone does not).
- **Secrets can live in the Keychain — for every plugin secret, not just
  passphrases**: licenses (`license-<pkg>`), vision keys
  (`captcha-pro-vision`, `challenge-vision`, `editor-vision`,
  `remote-vision`), the Places API key (`places-api`), and the
  session-vault/auth-bridge passphrases — all resolve env-var first, then
  the login Keychain under service `axuse` (`security add-generic-password
  -s axuse -a <account> -w '<secret>'`). Lookups are once-per-process,
  cached, and typed failures name the exact command. `AXUSE_KEYCHAIN=0`
  severs the fallback (deterministic CI/test isolation; the plugin test
  harness sets it automatically).
- **Native messaging**: manifests land in each browser's
  `NativeMessagingHosts` dir (`~/Library/Application Support/…`); isolated
  launches resolve manifests **relative to `--user-data-dir`**, which the
  E2E test uses and the probe script re-verifies per browser. The generated
  launcher guards the installing node binary with an existence check and
  falls back to PATH `node`, so node upgrades cannot orphan the host.
- **Bridge security**: the hub binds 127.0.0.1 only, token-auths every
  connection role, and writes its info file owner-only (dir 0700, file 0600
  — enforced and CI-asserted; Windows relies on `%LOCALAPPDATA%` ACLs).
- **Extension-backend resilience**: when a `Page.navigate` RPC through
  `chrome.debugger` stalls (observed on Chromium trunk r1721585 headless),
  the backend routes the navigation through `Runtime.evaluate`
  (`location.href = …`) once, reports `via` in the result, and keeps the
  session alive.
- **No shell**: every native call is `execFile` (argv, no shell string).
  The one shell launcher (`/bin/sh` shebang for the NM host) is a fixed,
  generated script with a quoted `exec node`.
- **Process hygiene**: browser teardown waits for exit, then deletes the
  ephemeral profile with backoff; stale profiles (>1 h) are swept at launch.

## Testing lanes

| Lane | Where | What it proves |
|---|---|---|
| `macos-26`, `macos-15`, `macos-15-intel` | CI (`ci.yml`) | Full suite × 3 runners (2 versions × arm64 + Intel), CfT installed, gates on, skip audit, doctor, bridge-security assertion |
| `windows-latest`, `ubuntu-latest` | CI (`ci.yml`) | Cross-platform guard (Windows desktop driver live; Linux browser tools with CfT, Linux desktop driver against a CI Xvfb) |
| Plugin E2E | CI-private runner or dev machine | `AXUSE_TEST_LIVE_*=1 node --test test/plugins.test.js` — every plugin's unit + live suite on macOS |
| `tcc-manual` | `tcc-manual.yml`, self-hosted | Granted-state proofs: real (corner) capture, inert zero-delta CGEvent, recovery re-probe. Fails closed with typed instructions if the runner's grants are missing. Zero skips allowed. |

The **skip audit** (`tools/skip-audit.mjs` + `test/skip-allowlist.json`) makes
every `# SKIP` explicit, typed, and CI-visible: an undocumented skip fails
the lane, so gated coverage can never silently vanish.

## Performance characteristics

Measured on Apple M1, macOS 26.6, Node 26 (`bench/macos-hotpaths.mjs`):

| Hot path | Cost | Notes |
|---|---|---|
| `osascript` spawn flavors (JXA noop / JXA+CoreGraphics / AppleScript) | 11–13 ms idle M1; 35–47 ms loaded | The floor every desktop gesture pays once; JXA+CG is the per-gesture flavor |
| `osascript` spawn (per native gesture batch) | ~36 ms | The floor every desktop op pays once |
| `screen_info` / `permissions` cold probe | 125 / 72 ms | Once per 5 s window |
| Same, cached | ~0 ms | Introduced by this hardening: warm screenshots save ~2 spawns (~200 ms) |
| Drag (3 batches: hover+down, moves, up) | 3 spawns | Was 4 — hover and press merged |
| Double-click | 1 spawn | Was 2 + a 40 ms sleep — and now a real double-click (clickState 2) |
| CDP observe (diff) | ~1 ms | Warm path |
| CDP click + diff | ~230 ms | Settle-dominated |
| `windows()` System Events walk | ~700–1100 ms | One Apple Event per attribute; anchor call, not a poll |
| Browser launch → CDP ready | ~440 ms | 30 s cold-start allowance (`AXUSE_LAUNCH_TIMEOUT_MS`) |
| Bridge hub start/stop | ~5 ms / ~0 ms | Includes 0600 token file |
| 24-way concurrent CDP evaluate | ~4 ms total | Single WebSocket, flat sessions |

## Known limitations

1. **Trunk-Chromium headless + extension bridge** — `chrome.debugger`
   navigation RPCs can stall on Chromium r1721585 (v158) in headless mode
   (headed works; the CDP backend is unaffected). axuse now detects the
   stall and falls back to `location.href` navigation through
   `Runtime.evaluate`, so the session continues; the first stalled
   navigation still pays one RPC timeout (~30 s). Upstream regression;
   re-verified each release.
2. **macOS desktop `down()`/`up()` (held button)** — intentionally not
   implemented; typed error directs to `ax_desktop_drag`.
3. **Screen Recording grants require host restart** — macOS behavior; axuse
   detects and reports it, cannot bypass it.
4. **`windows()` cannot use CGWindowList from JXA** — on current macOS the
   ObjC bridge boxes the CFArrayRef as an opaque Ref (no `deepUnwrap`, and
   manual CF bridging segfaults — verified empirically), so window
   discovery stays on the System Events walk, which needs Accessibility for
   per-window rows and costs one Apple Event per attribute (~0.7–1 s).
5. **Per-gesture `osascript` floor (measured per flavor in
   `bench/macos-hotpaths.mjs`)** — ~11–13 ms/spawn idle on M1 (JXA+CoreGraphics
   is the floor; JXA also beats plain AppleScript, so the flavor choice is
   already optimal), 35–47 ms under load. A resident helper was evaluated
   and rejected: JXA cannot receive push callbacks (no blocks/selectors),
   so a resident process must POLL a command file — at a 10 ms tick it
   saves ≤13 ms per gesture while permanently burning wakeups and adding
   crash/cleanup failure modes. At agent action scales (≥200 ms per
   operation) the spawn is not the bottleneck; revisit only if Apple ships
   a scriptable event channel.
6. **Natural-scroll mapping: derived + unit-pinned, live pin in the manual
   lane** — the wheel sign per preference follows AppKit scroll conventions;
   the manual lane includes an automated live pin (`tcc lane: LIVE
   scroll-direction pin`) that scrolls axuse's OWN fixture window and
   asserts the direction via `scrollY` read-back, so the first manual-lane
   run closes this with measured truth.
7. **Vision-gated plugin live demos** (challenge-handler B–E) — require
   `CHALLENGE_VISION_KEY` / `CHALLENGE_CF_DEMO_URL`; they self-skip typed and
   are listed in the allowlist. Not macOS-specific.
8. **Linux desktop driver** — shipped (X11/XWayland). Structure-first via
   AT-SPI (ax_desktop_ax_snapshot/click/set/read over axuse's zero-dep
   D-Bus client) plus coordinate+vision input/capture, EWMH windows and
   RandR monitor layout — the macOS pattern, on Linux.

## Release checklist

### Evidence: 2026-10-19 audit (Apple M1, macOS 26.6.2, Node 26.10)

Core suite (private, macOS, gates on): **78 tests, 64 pass, 0 fail, 14
skipped — every skip typed and allowlisted** (audit PASS). Public open-core
suite: **78 tests, 62 pass, 0 fail** (audit PASS). TCC state during the run:
Accessibility denied, Screen Recording preflight true with a stale grant —
the denied and stale paths were exercised LIVE, not only via mocks.

Per-plugin macOS E2E (unit + live with `AXUSE_TEST_LIVE_*=1`, fixture server
+ public demos where designed):

| Plugin | tests | pass | typed skips | Live evidence on macOS |
|---|---|---|---|---|
| ats-apply | 10 | 10 | 0 | fixture ATS dry-walk + full apply + duplicate refusal; public Greenhouse board observe-only |
| auth-bridge | 13 | 13 | 0 | fixture IdP (password+TOTP+consent+webhook OTP), virtual passkey authenticator, webauthn.io |
| challenge-handler | 14 | 10 | 4 | fixture slider + interstitial; vision-gated public demos (datadome/geetest/aws-waf) and CF-URL gate self-skip typed |
| commerce-operator | 6 | 6 | 0 | fixture admin tasks, validation loop, commits |
| downloads-pdf | 10 | 10 | 0 | verified download sha256, multi-page PDF, disguised-download → `*.suspect`, large-file deadline cancel |
| enterprise-app-driver | 5 | 5 | 0 | spine state machine + drift demo (design-partner gate) |
| net-governor | 8 | 8 | 0 | block ≥2× fewer requests, tap round-trip |
| places-extractor | 7 | 7 | 0 | fixture feed dedupe; API mode typed `PLACES_NO_KEY` without a key |
| portal-extractor | 8 | 8 | 0 | 12 docs/3 pages, cross-check, dedupe across runs |
| remote-app-driver | 7 | 7 | 0 | canvas replay 10/10 bars 8, drift never confirms |
| rich-editor-driver | 7 | 7 | 0 | DOM insert verified; canvas chunking via injected OCR; public ProseMirror demo |
| session-vault | 16 | 16 | 0 | live cookie save → cold-tab restore, zero re-auth events, sealed at rest |
| transaction-guard | 12 | 12 | 0 | full cycle, wrong-total refusal, replay duplicate, export verifies |
| virtual-grid-driver | 7 | 7 | 0 | official AG Grid infinite demo, 1000 rows by identity, zero duplicates |
| captcha-pro | 4 | 4 | 0 (unit) | live gate rides `test/plugin.test.js` (`AXUSE_TEST_LIVE_CAPTCHA=1` + public demo + vision key) — typed skip here |

Skip inventory (16 total across public/private runs): 8 macOS TCC/manual
lanes, 2 external live gates (captcha demo), 6 paid-tree lanes (public
checkout). No other skips exist; the audit enforces this on every CI lane.

Live stale-grant validation (this machine, during the audit): preflight
reported `screen_recording: true` while `screencapture` failed with `could
not create image from rect` → axuse returned
`DESKTOP_PERMISSION_REQUIRED` with the stale-grant hint (restart host;
`tccutil reset ScreenCapture`; re-grant) and invalidated its probe caches —
recovery on next call without an axuse restart.

### Checklist

1. `npm test` green on macOS (all gates off) and with
   `AXUSE_ENABLE_MACOS_CUA=1 AXUSE_TEST_MACOS_DESKTOP=1`.
2. Plugin E2E: `AXUSE_TEST_LIVE_*=1 node --test test/plugins.test.js` green;
   every skip matches `test/skip-allowlist.json`.
3. `node bench/macos-hotpaths.mjs --json` recorded; no regression > 20% on
   the table above without a documented reason.
4. Browser matrix: branded Chrome + CfT (+ Edge, Chromium) —
   `node tools/macos-nm-probe.mjs` green, or blockers re-verified.
5. CI green on all three macOS runners, Windows, and Linux.
6. Manual TCC lane green on the self-hosted runner this cycle.
7. Public open-core ported and green (same CI).
8. This document's matrices updated with the new evidence and date.

## Migration notes

- **From the pre-hardening driver (≤ df34aa3)**: desktop ops now cache probes
  for 5 s. If you rely on `permissions()` reflecting an instantaneous grant
  within the same second, call `permissions({refresh:true})` (or wait for the
  automatic invalidation after any permission failure).
- **Wheel/scroll semantics (2026-10 second pass)**: `wheel(dx, dy)` now uses
  the content-direction contract (dy>0 scrolls content down, matching the
  browser tool) and flips the CG delta per the Natural Scrolling preference.
  If you compensated for inverted scrolling before, remove that
  compensation.
- **`windows()` now returns per-window rows with bounds** when Accessibility
  is granted (was title-only); process-fallback rows remain for un-granted
  hosts. `activate` accepts `{pid}` — the most robust selector — in addition
  to exact titles.
- **`press` gained `platform:true`** — plugins and harness prompts that send
  Windows-convention app shortcuts should pass it on macOS. The old behavior
  (literal `ctrl` → Control modifier) is unchanged when the flag is absent.
- **`ax_capture {kind:"reveal"}`** (downloads-pdf): shows a verified capture
  in Finder (`open -R`) / Explorer (`/select,`) / the folder on Linux —
  typed `CAPTURE_REVEAL_MISSING`/`CAPTURE_REVEAL_FAILED` errors never blame
  the capture itself.
- **Passphrase resolution order for session-vault/auth-bridge** — env var
  first, then the macOS Keychain (`-s axuse -a <plugin>`). Existing
  env-var setups are unaffected; the Keychain is strictly additive. In this
  pass the same order now applies to license tokens, vision keys, and
  `PLACES_API_KEY`; `AXUSE_KEYCHAIN=0` severs all Keychain lookups (used by
  the test harness for determinism).
- **Preview browser channels** — `chrome-beta`, `chrome-canary`, `edge-beta`
  are first-class in discovery, native-messaging registration, and
  `axuse setup --browser`; preview builds rank after the stable automation
  builds in unpinned discovery. Live-verified: Edge Beta runs the full
  extension chain; Chrome Beta/Canary refuse `--load-extension` like branded
  stable (so the extension lane excludes every branded Chrome channel, and
  `AXUSE_BROWSER` overrides pointing at them cannot defeat that).
- **`AXUSE_LAUNCH_TIMEOUT_MS`** now exists (default 30 s, was a hardcoded
  15 s). Cold macOS first launches that used to fail typed `LAUNCH_FAILED`
  now succeed.
- **Bridge info files are now written 0600** in a 0700 directory. Existing
  wider modes are tightened opportunistically when a hub starts. The NM
  launcher falls back to PATH `node` when the installing binary is gone.
- **CI**: `macos-13`/`macos-14` labels are retired/deprecated upstream;
  lanes moved to `macos-26` / `macos-15` / `macos-15-intel`.
