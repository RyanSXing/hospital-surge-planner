import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
const baseURL = process.env.E2E_BASE_URL || "http://127.0.0.1:5173";
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  outputDir: "../../output/playwright/results",
  reporter: [
    ["list"],
    [
      "json",
      {
        outputFile:
          process.env.E2E_REPORT_FILE || "../../evidence/browser-tests.json",
      },
    ],
    ["html", { outputFolder: "../../output/playwright/report", open: "never" }],
  ],
  use: {
    baseURL,
    browserName: "chromium",
    channel: existsSync(chrome) ? "chrome" : undefined,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
    serviceWorkers: "block",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1600, height: 1000 } } },
    {
      name: "mobile",
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 1,
      },
    },
  ],
  webServer: process.env.E2E_SKIP_SERVER
    ? undefined
    : {
        command: "../../.venv/bin/python ../../scripts/dev.py",
        url: baseURL + "/api/health/ready",
        reuseExistingServer: true,
        timeout: 90_000,
      },
});
