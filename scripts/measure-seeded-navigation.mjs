/** Read-only initial seeded workspace navigation with a safe resource waterfall. */
import { chromium } from "../apps/web/node_modules/playwright/index.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const baseURL = process.env.E2E_BASE_URL;
if (!baseURL) throw Error("E2E_BASE_URL is required");
const generatorVersion = readFileSync(
  resolve(root, "packages/engine/surge_engine/common.py"),
  "utf8",
).match(/^GENERATOR_VERSION = "([^"]+)"$/m)?.[1];
if (!generatorVersion) throw Error("Current generator version was not found");
const config = readFileSync(
  process.env.E2E_AUTH_ENV_FILE ||
    resolve(root, "data/deployment/production.env"),
  "utf8",
);
const password = config
  .match(/^ADMIN_PASSWORD=(.*)$/m)?.[1]
  ?.trim()
  .replace(/^(["'])(.*)\1$/, "$2");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
  baseURL,
  viewport: { width: 1600, height: 1000 },
});
const result = {
  recorded_at: new Date().toISOString(),
  base_url: baseURL,
  scope:
    "Read-only initial seeded source census; five warm authenticated reloads after an untimed first asset load. Useful means three populated current-state KPIs, source-census identity and six facility markers.",
  deployed_commit: JSON.parse(
    readFileSync(resolve(root, "evidence/deployment.json"), "utf8"),
  ).code_commit,
  samples: [],
  errors: [],
  model_mutations: [],
};
try {
  const login = await context.request.post("/api/auth/login", {
    data: { username: "admin", password },
  });
  if (!login.ok()) throw Error("Authentication failed");
  const all = async (path) => {
    const items = [];
    let cursor = null;
    do {
      const response = await context.request.get(path, {
        params: { limit: 200, ...(cursor ? { cursor } : {}) },
      });
      if (!response.ok()) throw Error(`Seed lookup failed: ${path}`);
      const page = await response.json();
      items.push(...page.items);
      cursor = page.next_cursor;
    } while (cursor);
    return items;
  };
  const [scenarios, datasets] = await Promise.all([
    all("/api/scenarios"),
    all("/api/datasets"),
  ]);
  const expectedIdentity = `demo-v${generatorVersion.replaceAll(".", "-")}-planning_baseline-41021-365`;
  const dataset = datasets.find(
    (value) =>
      value.id === expectedIdentity &&
      value.manifest?.generator_version === generatorVersion &&
      value.manifest?.generator_seed === 41021 &&
      value.manifest?.coverage_days === 365,
  );
  const seeded = scenarios.find(
    (value) =>
      value.id === `scenario-${expectedIdentity}` &&
      value.dataset_version_id === expectedIdentity &&
      value.seed_provenance?.identity === expectedIdentity &&
      value.seed_provenance?.generator_version === generatorVersion &&
      value.conditions?.some(
        (condition) => condition.id === "condition-ed-surge",
      ),
  );
  if (!seeded || !dataset)
    throw Error(
      `Current curated generator ${generatorVersion} starter was not found`,
    );
  result.scenario_id = seeded.id;
  result.dataset_version_id = seeded.dataset_version_id;
  result.generator_version = generatorVersion;
  result.generator_seed = dataset.manifest.generator_seed;
  result.seed_source_identity = seeded.seed_provenance.identity;
  result.dataset_input_sha256 = dataset.input_sha256;
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  page.on("pageerror", (e) => result.errors.push(e.message));
  page.on("request", (request) => {
    if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method()))
      result.model_mutations.push(new URL(request.url()).pathname);
  });
  const useful = async () => {
    await page.waitForFunction(
      () =>
        document
          .querySelector(".map-caption")
          ?.textContent.includes("synthetic planning dataset") &&
        document.querySelectorAll(".maplibregl-marker").length >= 6 &&
        [...document.querySelectorAll(".kpi-strip .stat-value")].slice(0, 3)
          .length === 3 &&
        [...document.querySelectorAll(".kpi-strip .stat-value")]
          .slice(0, 3)
          .every((e) => !e.textContent.includes("—")),
    );
    await page.evaluate(() => document.fonts.ready);
  };
  await page.goto(`/?scenario=${seeded.id}&view=overview`);
  await useful();
  for (let i = 0; i < 5; i++) {
    await page.reload();
    await useful();
    result.samples.push(
      await page.evaluate(() => ({
        useful_ms: performance.now(),
        source: document.querySelector(".map-caption")?.textContent,
        resources: performance
          .getEntriesByType("resource")
          .map((e) => ({
            path: new URL(e.name).pathname,
            start_ms: e.startTime,
            duration_ms: e.duration,
            transfer_bytes: e.transferSize,
            decoded_bytes: e.decodedBodySize,
          }))
          .filter((e) => e.path.includes("/api/"))
          .sort((a, b) => a.start_ms - b.start_ms),
      })),
    );
  }
  const durations = result.samples
    .map((s) => s.useful_ms)
    .sort((a, b) => a - b);
  result.median_ms = durations[Math.floor(durations.length / 2)];
  result.max_ms = Math.max(...durations);
  result.target_ms = 3000;
  result.all_within_target = durations.every((n) => n < result.target_ms);
  await page.screenshot({
    path: resolve(root, "evidence/browser-hosted-seeded-navigation.png"),
    fullPage: true,
  });
} finally {
  writeFileSync(
    resolve(root, "evidence/browser-hosted-seeded-navigation.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  await browser.close();
}
console.log(
  JSON.stringify({
    scenario: result.scenario_id,
    median_ms: result.median_ms,
    max_ms: result.max_ms,
    all_within_target: result.all_within_target,
    errors: result.errors,
    mutations: result.model_mutations,
  }),
);
