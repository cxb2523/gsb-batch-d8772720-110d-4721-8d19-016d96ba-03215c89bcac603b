# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-11-12

### Added

- Scan from the dashboard: a «Scan» tab in the add dialog scans your home folder (offline,
  in the background, with a Stop button), lists what it found redacted and imports the
  keys you choose. The report stays in the server's memory for 30 minutes at most.
- The detail sheet of a stored key says where `mecha scan` found it in plaintext, and can
  scan just those files again after you clean them up. `mecha where <id> [--rescan]` does
  the same from the CLI.
- `mecha serve --demo` scans a made-up home folder instead of your disk, and the web
  demo replays that scan.

### Fixed

- A scan no longer drops the stored locations of files it did not read: a protected
  folder scanned only the time before, a file now only in the cloud, or one it could not
  read keep their locations. A deleted file still loses them.
- `mecha scan --import` keeps where the key was found (it no longer waits for the next
  scan), and the same key found in two files is imported once instead of failing as a
  duplicate. Import also checks again that the file is not cloud-only or too large.
- macOS: `--include-protected` and the dashboard's checkbox now really scan iCloud Drive
  and `~/Library/CloudStorage` (Dropbox, Google Drive, OneDrive). Both sit inside
  `~/Library`, which the walk skips, so they were never reached. Without the flag they
  count as skipped protected folders, and a location stored there is kept without
  looking inside.

## [0.2.0] - 2026-11-09

### Added

- `mecha scan`: find AI keys in plaintext on this machine (files, AI tool configs, shell
  histories, notebooks), offline and on demand; severity by location, confidence by
  variable name, import of findings and an optional `--check` with each key's provider.
  Locations of keys Mecha keeps are stored encrypted and turn their card amber.

### Fixed

- The dashboard no longer requests the listing twice when the event stream opens late,
  and no longer misses a change made between loading the listing and opening the stream:
  events carry a sequence number and the stream starts with the current position.

## [0.1.2] - 2026-11-09

### Added

- Language switch (EN/ES) next to the theme toggle, remembered in the browser; the
  browser's language is still the default. In the app and the web demo.
- Footer crediting the author, with links to YouTube, GitHub and his books.

## [0.1.1] - 2026-11-09

### Added

- Web demo on GitHub Pages (https://joaquinruiz.github.io/mecha/): the dashboard with
  made-up data, in the browser, with no install. Its data comes from demo mode, it never
  asks for a key ("Add" offers sample keys) and its CSP forbids any connection.
- README: a link to the web demo and to the launch post (in Spanish).

## [0.1.0] - 2026-11-09

First public release (alpha).

### Added

- Encrypted local store (AES-256-GCM; key in the system keyring or wrapped with a
  passphrase) and offline detection of Anthropic, OpenAI, Gemini, xAI and OpenRouter keys.
- Free passive checks against each provider's official endpoints, with a closed list of
  method, host and path per kind of key; traffic-light state with the source of every value.
- Web dashboard on `127.0.0.1` (session token, `Host` check, CSP with nonces) and CLI with
  Nagios exit codes; demo mode with fake data.
- Admin and management keys: expiry, last use and status of their keys; xAI team balance;
  OpenAI estimated organization balance.
- Opt-in paid active probes with their cost shown first, at most one per hour per key.
- Read-only linking of Codex, Claude Code and Gemini CLI session files; `.env` import with
  a redacted preview.
- `mecha export` / `mecha restore`: encrypted backups with their own passphrase.

[0.3.0]: https://github.com/JoaquinRuiz/mecha/releases/tag/v0.3.0
[0.2.0]: https://github.com/JoaquinRuiz/mecha/releases/tag/v0.2.0
[0.1.2]: https://github.com/JoaquinRuiz/mecha/releases/tag/v0.1.2
[0.1.1]: https://github.com/JoaquinRuiz/mecha/releases/tag/v0.1.1
[0.1.0]: https://github.com/JoaquinRuiz/mecha/releases/tag/v0.1.0
