import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// The FastAPI server (mecha serve) listens here; see src/mecha/cli.py.
const API_TARGET = 'http://127.0.0.1:7878'

// Placeholder nonce: Vite writes it on its tags and into <meta property="csp-nonce">;
// FastAPI swaps it for a fresh random value on every index.html response.
export const NONCE_PLACEHOLDER = '__MECHA_CSP_NONCE__'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  html: { cspNonce: NONCE_PLACEHOLDER },
  // Only the web demo reads it (src/demo); tests of the demo modules need a value.
  define: { __MECHA_VERSION__: JSON.stringify('test') },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    // Served by FastAPI and bundled into the wheel (git-ignored).
    outDir: '../src/mecha/static',
    emptyOutDir: true,
    assetsDir: 'assets',
  },
  server: {
    port: 5173,
    strictPort: true,
    host: 'localhost',
    proxy: {
      // changeOrigin rewrites Host to 127.0.0.1:7878 so the backend Host check passes.
      '/api': { target: API_TARGET, changeOrigin: true },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
