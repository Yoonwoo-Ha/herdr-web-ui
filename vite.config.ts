import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";

let revision: string | null = null;
try { revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* non-Git build */ }

export default defineConfig({
  plugins: [react()],
  define: { __APP_REVISION__: JSON.stringify(revision) },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:7317",
      "/ws": { target: "ws://localhost:7317", ws: true },
    },
  },
  build: { outDir: "dist" },
  resolve: { alias: { "@shared": new URL("./shared", import.meta.url).pathname } },
});
