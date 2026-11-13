import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('pdf') || id.includes('html2canvas')) return 'vendor-pdf';
            if (id.includes('react')) return 'vendor-react';
            if (id.includes('lucide')) return 'vendor-icons';
            // Let Vite handle the rest automatically to avoid circular deps
          }
        },
      },
    },
  },
  server: {
    host: true,
    allowedHosts: true,
    proxy: {} // All proxy logic moved to Node.js Express backend (c:/liya/backend/server.js)
  },
  optimizeDeps: {
    include: ['lucide-react']
  }
})
