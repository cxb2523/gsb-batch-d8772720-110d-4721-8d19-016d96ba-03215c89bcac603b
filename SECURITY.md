# Security Policy

## Supported version

Security fixes are applied to the latest release on the `main` branch.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/wyg916/douyin-fabu/security/advisories/new). Do not open a public issue for a suspected vulnerability.

Do not include real cookies, QR codes, access tokens, `.env` files, browser profiles, user images, account names, or unredacted logs. Provide the affected commit, a sanitized reproduction, the expected impact, and any safe workaround.

## Security boundaries

- The control panel listens only on loopback.
- The HTTP bridge also defaults to loopback. A non-loopback `HOST` requires a non-placeholder `BRIDGE_SECRET` of at least 16 characters.
- Real publishing requires dry-run to be disabled and an exact batch authorization value.
- Local image uploads are constrained to configured workspace/download roots. Remote image downloads require public HTTPS destinations, validate every redirect, cap size, and verify the decoded file signature.
- Browser profiles, local state, screenshots, downloaded media, workspace content, `.env`, and `config.json` must never be committed.

Browser RPA depends on third-party page structure and should run on a dedicated, patched machine under an authorized account.
