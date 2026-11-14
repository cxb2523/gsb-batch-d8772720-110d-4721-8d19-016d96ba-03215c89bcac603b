import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/**
 * Static web demo for GitHub Pages (`pnpm build:pages` -> web/dist-pages).
 *
 * Same app, but the modules that talk to the local server are swapped for in-memory
 * versions with the same interface (src/demo), fed by data dumped from `mecha serve --demo`
 * (scripts/dump_demo.py). Pages cannot send headers, so the CSP goes in a <meta> tag, with
 * `connect-src 'none'`: anyone can read in the page source that it cannot send anything.
 */
const src = (path: string) => fileURLToPath(new URL(`./src/${path}`, import.meta.url))
const SITE = 'https://joaquinruiz.github.io/mecha/'
// MECHA_SOCIAL_PNG only for local tries before the image exists; CI uses docs/social.png.
const SOCIAL =
  process.env.MECHA_SOCIAL_PNG ?? fileURLToPath(new URL('../docs/social.png', import.meta.url))

// Real module (resolved path) -> its web demo replacement.
const SWAPS: Record<string, string> = {
  [src('lib/api.ts')]: src('demo/api.ts'),
  [src('lib/events.ts')]: src('demo/events.ts'),
  [src('lib/session.ts')]: src('demo/session.ts'),
  [src('lib/edition.ts')]: src('demo/edition.tsx'),
}

export const PAGES_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  // Radix and Motion inject <style> at runtime; a fixed nonce in a static page protects
  // nothing, so styles (only styles) allow inline. Scripts stay strict.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'none'",
  "manifest-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

const TITLE = 'Mecha · web demo'
const DESCRIPTION =
  'Try Mecha in your browser: how much fuse is left on your AI API keys (validity, funds, ' +
  'expiry), with made-up data. Nothing is sent anywhere. To use your keys: uvx mecha-keys'

function version(): string {
  const pyproject = readFileSync(new URL('../pyproject.toml', import.meta.url), 'utf8')
  const m = pyproject.match(/^version\s*=\s*"([^"]+)"/m)
  if (!m?.[1]) throw new Error('no version in pyproject.toml')
  return m[1]
}

function swapForDemo(): Plugin {
  return {
    name: 'mecha-web-demo-swap',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
      const swap = resolved && SWAPS[resolved.id]
      // The demo modules may import *types* from the real ones; never swap inside src/demo.
      if (!swap || importer?.startsWith(src('demo'))) return null
      return swap
    },
  }
}

function pagesHtml(): Plugin {
  const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
  const meta = [
    `<meta http-equiv="Content-Security-Policy" content="${PAGES_CSP}" />`,
    `<meta name="description" content="${esc(DESCRIPTION)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Mecha" />`,
    `<meta property="og:title" content="${esc(TITLE)}" />`,
    `<meta property="og:description" content="${esc(DESCRIPTION)}" />`,
    `<meta property="og:url" content="${SITE}" />`,
    `<meta property="og:image" content="${SITE}social.png" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    // The image's text is in Spanish, so its description is too.
    `<meta property="og:image:alt" content="Mecha: ¿cuánta mecha le queda a tus API keys?" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
  ].join('\n    ')
  return {
    name: 'mecha-web-demo-html',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) =>
        html
          // The CSP must come before anything it governs.
          .replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    ${meta}`)
          .replace('<title>Mecha</title>', `<title>${TITLE}</title>`),
    },
    generateBundle() {
      if (!existsSync(SOCIAL)) {
        this.error('docs/social.png (1200x630) is missing: the Open Graph image is required')
      }
      this.emitFile({ type: 'asset', fileName: 'social.png', source: readFileSync(SOCIAL) })
    },
  }
}

export default defineConfig({
  base: '/mecha/',
  plugins: [swapForDemo(), pagesHtml(), react(), tailwindcss()],
  define: { __MECHA_VERSION__: JSON.stringify(version()) },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: {
    outDir: 'dist-pages',
    emptyOutDir: true,
    assetsDir: 'assets',
    // Nothing inlined as data: URIs, so the CSP can stay at 'self'.
    assetsInlineLimit: 0,
  },
})
