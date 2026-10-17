import {
  expect,
  type Page,
  type APIRequestContext,
  type TestInfo,
} from "@playwright/test";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
export type Entity = Record<string, any>;
export async function api(
  request: APIRequestContext,
  path: string,
  method = "GET",
  data?: unknown,
) {
  const response = await request.fetch("/api" + path, { method, data });
  if (!response.ok())
    throw new Error(`${method} ${path}: ${await response.text()}`);
  return response.json();
}
export async function login(page: Page) {
  const credentials = () => {
    const env = readFileSync(
      process.env.E2E_AUTH_ENV_FILE || resolve(process.cwd(), "../../.env"),
      "utf8",
    );
    const password = env
      .match(/^ADMIN_PASSWORD=(.*)$/m)?.[1]
      ?.trim()
      .replace(/^(["'])(.*)\1$/, "$2");
    return { username: "admin", password };
  };
  // Production has no seeded development session. Avoid knowingly invalid
  // sign-ins, and honor the real authentication rate limit during long suites.
  const data = process.env.E2E_AUTH_ENV_FILE
    ? credentials()
    : { demo_role: "admin" };
  let response = await page.request.post("/api/auth/login", { data });
  if (response.status() === 429) {
    await expect
      .poll(
        async () => {
          response = await page.request.post("/api/auth/login", { data });
          return response.status();
        },
        { timeout: 75_000, intervals: [2000, 4000] },
      )
      .not.toBe(429);
  }
  if (!response.ok() && !process.env.E2E_AUTH_ENV_FILE) {
    response = await page.request.post("/api/auth/login", {
      data: credentials(),
    });
  }
  expect(
    response.ok(),
    `Sign-in returned HTTP ${response.status()}`,
  ).toBeTruthy();
}
export async function scenario(
  page: Page,
  name: string,
  options: Entity = {},
  fixture = "planning_baseline",
) {
  await login(page);
  const generatorVersion = readFileSync(
    resolve(process.cwd(), "../../packages/engine/surge_engine/common.py"),
    "utf8",
  ).match(/^GENERATOR_VERSION = "([^"]+)"$/m)?.[1];
  expect(generatorVersion).toBeTruthy();
  const fixtureId = `demo-v${generatorVersion!.replaceAll(".", "-")}-${fixture}-41021-365`;
  const list = await api(page.request, "/datasets?limit=200"),
    dataset = (list.items || list).find(
      (d: Entity) =>
        d.id === fixtureId &&
        d.manifest?.generator_version === generatorVersion,
    );
  expect(dataset).toBeTruthy();
  const chosen = await api(page.request, "/scenarios", "POST", {
    name: `E2E ${process.env.E2E_RUN_TAG ? process.env.E2E_RUN_TAG + " " : ""}${name} ${Date.now()}`,
    dataset_version_id: dataset.id,
    horizon_calendar_days: 3,
    replications: 10,
    conditions: [],
    ...options,
  });
  return { scenario: chosen, dataset };
}
export async function waitRun(page: Page, runId: string) {
  let result: Entity = {};
  await expect
    .poll(
      async () => {
        result = await api(page.request, "/run-groups/" + runId);
        return result.status;
      },
      { timeout: 150_000, intervals: [500, 1000, 2000] },
    )
    .toBe("SUCCEEDED");
  return result;
}
export type WorkspaceView =
  | "overview"
  | "summary"
  | "replay"
  | "analytics-outcomes"
  | "analytics-patients"
  | "analytics-resources"
  | "comparison"
  | "data";

export function workspaceViewQuery(view: WorkspaceView) {
  if (view === "overview" || view === "data") return `view=${view}`;
  if (view === "analytics-outcomes")
    return "view=analysis&analysis=analytics&section=outcomes";
  if (view === "analytics-patients")
    return "view=analysis&analysis=analytics&section=patients";
  if (view === "analytics-resources")
    return "view=analysis&analysis=analytics&section=resources";
  return `view=analysis&analysis=${view}`;
}

export async function open(
  page: Page,
  scenarioId: string,
  view: WorkspaceView = "overview",
  runId?: string,
) {
  await page.goto(
    `/?scenario=${scenarioId}&${workspaceViewQuery(view)}${runId ? `&run=${runId}` : ""}`,
  );
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.getByText("Loading planning workspace")).toHaveCount(0);
  await page
    .locator(
      ".page-heading:visible,.overview-page:visible,.patients-page:visible,.analysis-empty:visible",
    )
    .first()
    .waitFor({ state: "visible" });
}
export async function capture(page: Page, name: string, testInfo: TestInfo) {
  await page.evaluate(() => document.fonts.ready);
  const file = resolve(
    process.cwd(),
    `../../${process.env.E2E_EVIDENCE_DIR || "evidence"}/browser-${testInfo.project.name}-${name}.png`,
  );
  mkdirSync(
    resolve(
      process.cwd(),
      `../../${process.env.E2E_EVIDENCE_DIR || "evidence"}`,
    ),
    { recursive: true },
  );
  await page.screenshot({ path: file, fullPage: true, animations: "disabled" });
  await testInfo.attach(name, { path: file, contentType: "image/png" });
  if (await page.getByRole("dialog").count()) return;
  let main = page.locator("main");
  // Some result pages own the single visible page scroll region.
  for (const selector of [
    ".summary-dashboard:visible",
    ".compare-page:visible",
    ".analytics-content > .mantine-Tabs-panel:visible",
    ".outcome-analytics:visible",
  ]) {
    const candidate = page.locator(selector);
    if (
      (await candidate.count()) === 1 &&
      (await candidate.evaluate((e) => e.scrollHeight - e.clientHeight)) > 100
    ) {
      main = candidate;
      break;
    }
  }
  const scroll = await main.evaluate((e) => ({
    top: e.scrollTop,
    max: e.scrollHeight - e.clientHeight,
  }));
  if (scroll.max > 100) {
    for (const [label, fraction] of [
      ["middle", 0.5],
      ["lower", 1],
    ] as const) {
      await main.evaluate(async (e, top) => {
        e.scrollTop = top;
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      }, scroll.max * fraction);
      const part = file.replace(".png", `-${label}.png`);
      await page.screenshot({
        path: part,
        fullPage: true,
        animations: "disabled",
      });
      await testInfo.attach(name + "-" + label, {
        path: part,
        contentType: "image/png",
      });
    }
    await main.evaluate((e, top) => {
      e.scrollTop = top;
    }, scroll.top);
  }
}
export async function assertPageHealthy(page: Page) {
  await expect(page.locator(".global-error .error-box")).toHaveCount(0);
  const overflow = await page.evaluate(() => ({
    viewport: innerWidth,
    body: document.documentElement.scrollWidth,
  }));
  expect.soft(overflow.body).toBeLessThanOrEqual(overflow.viewport + 1);
  const tiny = await page
    .locator("main button,main input,main select")
    .evaluateAll((elements) =>
      elements
        .filter((e) => {
          const r = e.getBoundingClientRect();
          return (
            r.width > 0 &&
            r.height > 0 &&
            r.width < 10 &&
            r.height < 10 &&
            !e.matches(".patient-token") &&
            !e.closest(".bed-grid")
          );
        })
        .map((e) => ({
          label: e.getAttribute("aria-label"),
          text: e.textContent,
          className: e.className,
        })),
    );
  expect.soft(tiny, JSON.stringify(tiny)).toEqual([]);
}
export function record(name: string, value: unknown) {
  mkdirSync(
    resolve(
      process.cwd(),
      `../../${process.env.E2E_EVIDENCE_DIR || "evidence"}`,
    ),
    { recursive: true },
  );
  writeFileSync(
    resolve(
      process.cwd(),
      `../../${process.env.E2E_EVIDENCE_DIR || "evidence"}/browser-${name}.json`,
    ),
    JSON.stringify(value, null, 2) + "\n",
  );
}

/** Use the same secondary menu entry a planner sees in the compact shell. */
export async function exportResults(page: Page) {
  await page
    .getByRole("button", { name: "Workspace options", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Export results", exact: true })
    .click();
}

export async function revealSummaryTimeline(page: Page) {
  const details = page.locator(".summary-timeline-details");
  if ((await details.getAttribute("open")) === null)
    await details.locator(":scope > summary").click();
}

export async function revealOutcomeMetrics(page: Page) {
  const control = page.getByRole("button", {
    name: /View all outcome metrics and uncertainty/,
  });
  if ((await control.getAttribute("aria-expanded")) !== "true")
    await control.click();
}
