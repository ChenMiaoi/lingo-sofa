import { defineConfig } from "vite";
import { resolve } from "node:path";
export default defineConfig({
  root: resolve(import.meta.dirname),
  server: { port: 1420, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true },
  clearScreen: false,
});
