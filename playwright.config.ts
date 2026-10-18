import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e-browser",
  globalSetup: "./tests/e2e-browser/global-setup.ts",
  timeout: 30_000,
  workers: 1,
  reporter: "list",
});
