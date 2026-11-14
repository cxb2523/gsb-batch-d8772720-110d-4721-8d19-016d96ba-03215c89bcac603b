import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Frontend dev + preview both listen on 9762.
// Backend API is expected at localhost:8000 (CORS is enabled on the adapter).
// Override via VITE_API_URL at build time if deploying elsewhere.
export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 9762,
    strictPort: true,
  },
  preview: {
    host: "0.0.0.0",
    port: 9762,
  },
});
