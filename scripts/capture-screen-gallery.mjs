/** Durable, read-only screenshots of an existing completed workflow. */
import { chromium } from "../apps/web/node_modules/playwright/index.mjs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const baseURL = process.env.E2E_BASE_URL || "http://127.0.0.1:5173";
const local = ["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname);
const source = JSON.parse(
  readFileSync(
    resolve(
      root,
      process.env.GALLERY_CONTEXT_FILE || "evidence/browser-workflow.json",
    ),
    "utf8",
  ),
);
const directory = resolve(
  root,
  process.env.GALLERY_DIRECTORY ||
    (local ? "evidence/screens/local-final" : "evidence/screens/hosted-final"),
);
mkdirSync(directory, { recursive: true });
const deployment = JSON.parse(
  readFileSync(resolve(root, "evidence/deployment.json"), "utf8"),
);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const result = {
  recorded_at: new Date().toISOString(),
  base_url: baseURL,
  scope:
    "Existing completed workflow; navigation and screenshots only; no simulation or data mutations",
  deployed_commit: local ? null : deployment.code_commit,
  scenario_id: source.scenario_id,
  run_id: source.run_id,
  comparison_id: source.comparison_id,
  screens: [],
  page_errors: [],
};
const references = {
  overview: "01-command-overview.png",
  scenarios: "02-visual-scenario-builder-v2.png",
  patients: "03-patient-unit-explorer.png",
  resources: "04-resources-and-updates.png",
  compare: "05-visual-plan-comparison-v2.png",
  replay: "06-visual-patient-flow-replay.png",
};
try {
  for (const mode of ["desktop", "mobile"]) {
    const context = await browser.newContext({
      baseURL,
      viewport:
        mode === "desktop"
          ? { width: 1600, height: 1000 }
          : { width: 390, height: 844 },
      isMobile: mode === "mobile",
      hasTouch: mode === "mobile",
    });
    let credentials = { demo_role: "admin" };
    if (!local) {
      const env = readFileSync(
        process.env.E2E_AUTH_ENV_FILE ||
          resolve(root, "data/deployment/production.env"),
        "utf8",
      );
      credentials = {
        username: "admin",
        password: env
          .match(/^ADMIN_PASSWORD=(.*)$/m)?.[1]
          ?.trim()
          .replace(/^(["'])(.*)\1$/, "$2"),
      };
    }
    const login = await context.request.post("/api/auth/login", {
      data: credentials,
    });
    if (!login.ok()) throw Error("Gallery login failed");
    const page = await context.newPage();
    page.on("pageerror", (e) => result.page_errors.push(e.message));
    const views =
      mode === "desktop"
        ? [
            "overview",
            "scenarios",
            "patients",
            "resources",
            "compare",
            "replay",
            "data",
          ]
        : ["overview", "patients", "compare", "replay"];
    for (const view of views) {
      await page.goto(
        `/?scenario=${source.scenario_id}&run=${source.run_id}&view=${view}${source.comparison_id && view === "compare" ? "&comparison=" + source.comparison_id : ""}`,
      );
      await page.locator(".app-shell").waitFor();
      await page
        .getByText("Loading planning workspace", { exact: true })
        .waitFor({ state: "hidden" });
      await page.locator("h1").first().waitFor();
      await page
        .getByText("Loading the exact state at this timestamp…", {
          exact: true,
        })
        .waitFor({ state: "hidden" });
      if (view === "patients")
        await page.locator(".patient-table tbody tr").first().waitFor();
      if (view === "compare") {
        await page.locator(".comparison-chart").waitFor();
        await page.waitForFunction(() =>
          [...document.querySelectorAll("button")].some(
            (b) => b.textContent.includes("Evaluate responses") && !b.disabled,
          ),
        );
      }
      if (view === "scenarios")
        await page.waitForFunction(() =>
          [
            ...document.querySelectorAll(
              ".scenarios-page .heading-actions button",
            ),
          ].some((b) => b.textContent.includes("Run scenario") && !b.disabled),
        );
      await page.evaluate(() => document.fonts.ready);
      let map = null;
      if (["overview", "resources"].includes(view)) {
        await page.waitForFunction(
          () => document.querySelectorAll(".maplibregl-marker").length >= 6,
        );
        await page
          .getByRole("button", { name: "Fit all sites", exact: true })
          .click();
        map = await page.evaluate(
          () =>
            new Promise((resolve, reject) => {
              let previous = "",
                stable = 0,
                start = performance.now();
              const check = () => {
                const nodes = [
                  ...document.querySelectorAll(".maplibregl-marker"),
                ];
                const rects = nodes.map((n) => {
                  const r = n.getBoundingClientRect();
                  return {
                    label: n.getAttribute("aria-label") || n.textContent,
                    x: Math.round(r.x * 10) / 10,
                    y: Math.round(r.y * 10) / 10,
                    width: r.width,
                    height: r.height,
                  };
                });
                const signature = JSON.stringify(rects);
                stable = signature === previous ? stable + 1 : 0;
                previous = signature;
                const spread =
                  Math.max(...rects.map((r) => r.x)) -
                  Math.min(...rects.map((r) => r.x));
                if (stable >= 30 && spread > 120)
                  return resolve({
                    marker_count: rects.length,
                    stable_animation_frames: stable,
                    projected_spread_px: spread,
                    markers: rects,
                    scale: document.querySelector(".maplibregl-ctrl-scale")
                      ?.textContent,
                    canvas: !!document.querySelector(".maplibregl-canvas"),
                  });
                if (performance.now() - start > 15000)
                  return reject(
                    Error("Facility map did not finish fitting/rendering"),
                  );
                requestAnimationFrame(check);
              };
              requestAnimationFrame(check);
            }),
        );
      }
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      const filename = `${mode}-${view}.png`;
      await page.screenshot({
        path: resolve(directory, filename),
        fullPage: true,
        animations: "disabled",
      });
      const row = {
        mode,
        view,
        file: filename,
        title: await page.locator("h1").allTextContents(),
        horizontal_overflow: await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth + 1,
        ),
        reference: references[view] || null,
        map,
        additional_files: [],
      };
      const main = page.locator("main");
      const max = await main.evaluate((e) => e.scrollHeight - e.clientHeight);
      if (max > 200) {
        await main.evaluate(async (e) => {
          e.scrollTop = e.scrollHeight;
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
        });
        const lower = `${mode}-${view}-lower.png`;
        await page.screenshot({
          path: resolve(directory, lower),
          fullPage: true,
          animations: "disabled",
        });
        row.additional_files.push(lower);
      }
      result.screens.push(row);
    }
    await context.close();
  }
} finally {
  await browser.close();
  writeFileSync(
    resolve(directory, "index.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
}
const rows = result.screens
  .map(
    (x) =>
      `| ${x.mode} | ${x.title.join(" / ")} | [Screenshot](${x.file})${x.additional_files.map((f) => ` · [Lower panel](${f})`).join("")} | ${x.reference ? `[Reference](../../../docs/reference/gotham-inspired-mockups/${x.reference})` : "No supplied mockup"} |`,
  )
  .join("\n");
writeFileSync(
  resolve(directory, "index.md"),
  `# Final screen gallery\n\nCaptured ${result.recorded_at} from ${baseURL}. Existing scenario ${result.scenario_id}, run ${result.run_id}. ${local ? "Local verification before final hosted measurement." : `Deployed source ${result.deployed_commit}.`}\n\nMaps wait for all six facility markers and 30 stable animation frames after fitting projected geometry. Screenshots are stored here and survive later Playwright runs. Full context and map measurements are in [index.json](index.json).\n\n| Viewport | Screen | Image | Supplied reference |\n|---|---|---|---|\n${rows}\n`,
);
console.log(
  JSON.stringify({
    directory,
    screens: result.screens.length,
    page_errors: result.page_errors,
    overflows: result.screens
      .filter((x) => x.horizontal_overflow)
      .map((x) => x.file),
    maps: result.screens
      .filter((x) => x.map)
      .map((x) => ({
        file: x.file,
        count: x.map.marker_count,
        scale: x.map.scale,
        spread: x.map.projected_spread_px,
      })),
  }),
);
