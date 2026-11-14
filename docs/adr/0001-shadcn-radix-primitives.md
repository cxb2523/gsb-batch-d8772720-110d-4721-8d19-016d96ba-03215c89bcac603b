# ADR 0001: shadcn/ui on Radix primitives

- Status: accepted
- Date: 2026-11-04
- Phase: 0

## Context

SPEC.md asks for shadcn/ui with "Radix primitives, the default ones" and marks the claim as
needing verification. A third-party article (PkgPulse) suggested that in 2026 the shadcn CLI
might default to Base UI instead.

What the official docs say (checked 2026-11-04):

- [CLI reference](https://ui.shadcn.com/docs/cli): `shadcn init` accepts
  `-b, --base <base>` with values `base`, `radix` and `aria`. **No default is documented.**
  `--defaults` is documented as `--template=next --preset=nova` and says nothing about the base.
- [Vite installation](https://ui.shadcn.com/docs/installation/vite) only says `init` prompts
  for "base, preset, monorepo, and more".

So "Radix is the default" cannot be confirmed; the choice depends on the prompt or flag.

## Decision

Pin Radix explicitly and never depend on the CLI default:

```bash
pnpm dlx shadcn@latest init --base radix --preset nova --template vite
```

`web/components.json` records `"style": "radix-nova"`, so later `shadcn add` calls pull the
Radix variants. Components import primitives from the unified `radix-ui` package.

## Consequences

- Behaviour matches the spec regardless of future CLI defaults.
- If the project ever moves to Base UI it is a deliberate change with its own ADR, re-running
  `init --base base` and regenerating `src/components/ui/`.
- The generated `cn()` helper comes from the [`cn`](https://github.com/shadcn-ui/cn) package
  (published by the shadcn-ui organisation, replaces clsx + tailwind-merge). Verified as an
  official shadcn-ui repository before accepting the dependency.
- Resolved in phase 3 (CSP and injected styles): several libraries insert `<style>` elements
  at runtime, which the strict `style-src 'self'` CSP blocks. Mecha uses a **per-response
  nonce**, never `'unsafe-inline'`:
  - `vite build` writes a placeholder nonce (`html.cspNonce`) on its tags and in
    `<meta property="csp-nonce">`; FastAPI replaces it with a fresh value on every
    `index.html` response (`Cache-Control: no-store`) and puts the same value in the CSP header.
  - The app reads it with `meta.nonce` (browsers blank the attribute under a CSP header) and
    calls `setNonce` from `get-nonce` before the first render. `get-nonce` is a direct
    dependency pinned to the version `react-style-singleton` uses: with two copies,
    `setNonce` would not reach Radix's scroll lock.
  - Motion gets it through `MotionConfig nonce` (`AnimatePresence mode="popLayout"`); the
    shadcn chart's `<style>` element gets it as a prop.
  - Sonner 2.0.8 injects its CSS on import without a nonce, so toasts are built on Radix Toast.
  - The theme is applied before first paint by `/theme.js`, a file, not an inline script.
  - The Playwright smoke test fails on any CSP violation or console error, so a dependency
    update that injects un-nonced styles breaks CI. Verified by removing `setNonce`: the test
    reports `style-src-elem` violations.
