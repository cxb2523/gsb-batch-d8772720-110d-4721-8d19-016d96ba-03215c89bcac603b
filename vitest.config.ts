import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // Primer React ships ESM that imports plain .css files; node can't load
    // those, so it must run through Vite's transform pipeline rather than be
    // externalized. Everything else stays external for speed.
    server: {
      deps: {
        inline: [/@primer[\\/]/, /@base-ui[\\/]/],
      },
    },
  },
});
