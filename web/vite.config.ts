import { defineConfig } from "vite";
// Run as `vite web` / `vite build web`, so the root is this directory.
export default defineConfig({
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  server: {
    port: 5180,
    proxy: { "/api": "http://127.0.0.1:8787", "/health": "http://127.0.0.1:8787" },
  },
});
