import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const rootDir = dirname(fileURLToPath(import.meta.url));

/** Must match daemon `health_port` / HEALTH_PORT (templates default to 8080). */
const apiPort = process.env.VITE_API_PORT || process.env.HEALTH_PORT || "8080";
const apiOrigin = `http://127.0.0.1:${apiPort}`;

export default defineConfig({
  plugins: [react()],
  base: "/",
  build: {
    outDir: "../dist/dashboard",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    fs: {
      allow: [rootDir, join(rootDir, "..")],
    },
    proxy: {
      "/api": apiOrigin,
      "/health": apiOrigin,
    },
  },
});
