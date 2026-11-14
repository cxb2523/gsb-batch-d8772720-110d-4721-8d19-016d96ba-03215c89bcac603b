# Security policy

Mecha stores API keys, so security reports are very welcome.

## Reporting a vulnerability

Please report vulnerabilities **privately** through GitHub:
[Report a vulnerability](https://github.com/JoaquinRuiz/mecha/security/advisories/new)
(the repository's *Security* tab → *Report a vulnerability*). Do not open a public issue.

Include what you found, how to reproduce it and the version (`mecha --version`). Never
include real API keys: use made-up values in the provider's format.

You will get an acknowledgement within 7 days. Once a fix is ready, it is released and a
GitHub security advisory is published, crediting you unless you prefer otherwise.

## Supported versions

Mecha is in alpha: only the latest release receives security fixes.

## Scope

In scope: anything that exposes a stored secret (on disk, in logs, in the browser, in
backups, in network traffic other than to the key's own provider), bypasses the local
server's protections (session token, `Host` check, CSP), or makes Mecha send a key to
the wrong host.

Out of scope, by design (see the threat model in the [README](README.md#threat-model)):
code already running as your user (it can read the keyring, the process memory and the
session token), and a provider's own endpoints.
