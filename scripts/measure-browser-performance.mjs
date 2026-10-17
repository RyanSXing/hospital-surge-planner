/** Read-only hosted UI measurements. Requires an existing completed benchmark and private auth env. */
import { chromium } from "../apps/web/node_modules/playwright/index.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

const root = resolve(import.meta.dirname, "..");
const benchmarkPath =
  process.env.BROWSER_BENCHMARK_FILE ||
  "evidence/cloud-benchmark-30d-100r.json";
const benchmark = JSON.parse(
  readFileSync(resolve(root, benchmarkPath), "utf8"),
);
const baseURL = process.env.E2E_BASE_URL || benchmark.base_url;
const local = ["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname);
const outputPrefix =
  process.env.BROWSER_OUTPUT_PREFIX ||
  resolve(root, "evidence/browser-hosted-performance");
const playbackSpeed = Number(process.env.BROWSER_REPLAY_SPEED || 1);
const replayLeadHours = Number(
  process.env.BROWSER_REPLAY_LEAD_HOURS || (playbackSpeed === 16 ? 120 : 24),
);
if (
  ![1, 4, 16].includes(playbackSpeed) ||
  !Number.isFinite(replayLeadHours) ||
  replayLeadHours <= 0
)
  throw Error("Replay speed must be 1,4,16 and lead hours must be positive");
const env = local
  ? ""
  : readFileSync(
      process.env.E2E_AUTH_ENV_FILE ||
        resolve(root, "data/deployment/production.env"),
      "utf8",
    );
const password = env
  .match(/^ADMIN_PASSWORD=(.*)$/m)?.[1]
  ?.trim()
  .replace(/^(["'])(.*)\1$/, "$2");
if (!baseURL || (!local && !password))
  throw Error("Hosted URL and private admin credential are required");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
  baseURL,
  viewport: { width: 1600, height: 1000 },
  reducedMotion: "no-preference",
});
const page = await context.newPage();
page.setDefaultTimeout(60000);
const pageErrors = [],
  mutations = [];
const localRendererHashes = () =>
  Object.fromEntries(
    [
      "apps/web/src/pages/Replay.tsx",
      "apps/web/src/pages/ReplayEvidence.tsx",
      "apps/web/src/pages/replayBackdrop.ts",
      "apps/web/src/pages/patientProjection.ts",
      "apps/web/src/pages/replayAnnotations.ts",
      "apps/web/src/pages/replay.css",
      "apps/web/src/App.tsx",
    ].map((path) => [
      path,
      createHash("sha256")
        .update(readFileSync(resolve(root, path)))
        .digest("hex"),
    ]),
  );
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("request", (request) => {
  if (
    ["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) &&
    !request.url().includes("/auth/")
  )
    mutations.push(new URL(request.url()).pathname);
});
const evidence = {
  recorded_at: new Date().toISOString(),
  base_url: baseURL,
  scope: `Read-only desktop Chrome measurements over ${local ? "local HTTP (harness check)" : "actual public HTTPS"}; existing completed run; first asset download and login excluded`,
  benchmark_evidence: benchmarkPath,
  run_group_id: benchmark.run_group_id,
  run_code_commit: benchmark.manifest?.code_commit,
  deployed_code_commit: local
    ? null
    : JSON.parse(
        readFileSync(resolve(root, "evidence/deployment.json"), "utf8"),
      ).code_commit,
  deployment_identity_source: local
    ? "Local working tree, identified by renderer/App source hashes"
    : "evidence/deployment.json (authenticated deployment record)",
  local_source_sha256: local ? localRendererHashes() : undefined,
  viewport: { width: 1600, height: 1000 },
};
const summary = (values) => {
  if (!values.length)
    return { samples: [], median_ms: null, p95_ms: null, max_ms: null };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: values,
    median_ms: sorted[Math.floor(sorted.length / 2)],
    p95_ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max_ms: sorted.at(-1),
  };
};
try {
  const login = await context.request.post("/api/auth/login", {
    data: local ? { demo_role: "admin" } : { username: "admin", password },
  });
  if (!login.ok()) throw Error("Hosted login failed");
  const get = async (path) => {
    const response = await context.request.get("/api" + path);
    if (!response.ok()) throw Error(`${path}: HTTP ${response.status()}`);
    return response.json();
  };
  const run = await get("/run-groups/" + benchmark.run_group_id);
  const rep = run.selected_replication_id;
  let playbackStateResponses = [];
  page.on("response", (response) => {
    const parsed = new URL(response.url());
    if (
      parsed.pathname === `/api/runs/${rep}/state` &&
      response.status() === 200
    )
      playbackStateResponses.push({
        at: parsed.searchParams.get("at"),
        received_at: new Date().toISOString(),
      });
  });
  const metrics = await get("/run-groups/" + run.id + "/metrics");
  const start =
    run.start_at || metrics.start_at || benchmark.manifest?.start_at;
  const end = run.end_at || metrics.end_at || benchmark.manifest?.end_at;
  const scenario = benchmark.scenario_id || run.scenario_id;
  const url = (view) =>
    `/?scenario=${scenario}&run=${run.id}&replication=${rep}&view=${view}`;
  await page.addInitScript(() => {
    window.__canvasDraws = [];
    window.__displayFrame = { ordinal: 0, at: performance.now() };
    const tick = (at) => {
      window.__displayFrame = {
        ordinal: window.__displayFrame.ordinal + 1,
        at,
      };
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const originalFill = CanvasRenderingContext2D.prototype.fillRect;
    const originalImage = CanvasRenderingContext2D.prototype.drawImage;
    const originalText = CanvasRenderingContext2D.prototype.fillText;
    const originalArc = CanvasRenderingContext2D.prototype.arc;
    function beginPaint(context, width, height) {
      context.__draw = {
        start: performance.now(),
        logical_width: width,
        logical_height: height,
        display_frame: window.__displayFrame.ordinal,
        display_frame_at: window.__displayFrame.at,
        patient_arcs: 0,
        animating: context.canvas.dataset.animating === "true",
        moved_markers: context.canvas.dataset.movedMarkers,
        previous_markers: context.canvas.dataset.previousMarkers,
        recorded_at: context.canvas.dataset.recordedAt,
        selected_time: document.querySelector(".replay-time strong")
          ?.textContent,
      };
    }
    CanvasRenderingContext2D.prototype.fillRect = function (...args) {
      if (
        this.canvas.classList.contains("replay-canvas") &&
        args[0] === 0 &&
        args[1] === 0 &&
        args[2] === 1000 &&
        args[3] > 100
      )
        beginPaint(this, args[2], args[3]);
      return originalFill.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      if (
        this.canvas.classList.contains("replay-canvas") &&
        args.length === 5 &&
        args[1] === 0 &&
        args[2] === 0 &&
        args[3] === 1000
      )
        beginPaint(this, args[3], args[4]);
      return originalImage.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.arc = function (...args) {
      // Exact patient radii exclude 2.4px staff heads and the 10px selection ring.
      if (this.__draw && (args[2] === 3.6 || args[2] === 6))
        this.__draw.patient_arcs++;
      return originalArc.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.fillText = function (...args) {
      const result = originalText.apply(this, args);
      if (this.__draw && String(args[0]).startsWith("STATE SCHEMATIC")) {
        window.__canvasDraws.push({
          ...this.__draw,
          end: performance.now(),
          duration_ms: performance.now() - this.__draw.start,
        });
        this.__draw = null;
      }
      return result;
    };
  });
  const useful = async () => {
    await page.locator(".overview-page").waitFor();
    await page.waitForFunction(
      () =>
        document
          .querySelector(".map-caption")
          ?.textContent.includes("selected simulation run") &&
        [...document.querySelectorAll(".kpi-strip .stat-value")].length === 4 &&
        [...document.querySelectorAll(".kpi-strip .stat-value")].every(
          (e) => !e.textContent.includes("—"),
        ),
    );
    await page.evaluate(() => document.fonts.ready);
  };
  await page.goto(url("overview"));
  await useful();
  const navigation = [];
  for (let i = 0; i < 5; i++) {
    await page.reload();
    await useful();
    navigation.push(await page.evaluate(() => performance.now()));
  }
  evidence.warm_authenticated_navigation = {
    ...summary(navigation),
    target_ms: 3000,
    all_within_target: navigation.every((x) => x < 3000),
    endpoint:
      "Useful selected-run Overview with populated metrics and exact state",
  };
  const panels = [];
  for (let i = 0; i < 12; i++) {
    panels.push(
      await page.evaluate(
        () =>
          new Promise((resolve) => {
            const button = document.querySelector(
              '[aria-controls="overview-facility-inspector"]',
            );
            const prior = button.getAttribute("aria-expanded");
            const start = performance.now();
            const observer = new MutationObserver(() => {
              if (button.getAttribute("aria-expanded") !== prior) {
                observer.disconnect();
                resolve(performance.now() - start);
              }
            });
            observer.observe(button, {
              attributes: true,
              attributeFilter: ["aria-expanded"],
            });
            button.click();
          }),
      ),
    );
  }
  evidence.local_panel_update = {
    ...summary(panels),
    target_ms: 100,
    all_within_target: panels.every((x) => x < 100),
    endpoint:
      "Browser click dispatch to committed aria-expanded mutation; excludes Playwright driver latency",
  };
  await page.goto(url("replay"));
  await page.locator(".replay-canvas").waitFor();
  await page
    .getByText("Loading the exact state at this timestamp…", { exact: true })
    .waitFor({ state: "hidden" });
  const stateStart = await get(
    `/runs/${rep}/state?at=${encodeURIComponent(start)}`,
  );
  const stateEnd = await get(
    `/runs/${rep}/state?at=${encodeURIComponent(end)}`,
  );
  async function seek(label, total) {
    return page.evaluate(
      ({ label, total }) =>
        new Promise((resolve, reject) => {
          const button = document.querySelector(`[aria-label="${label}"]`);
          const begin = performance.now();
          const previousDraws = window.__canvasDraws.length;
          const check = () => {
            const canvas = document.querySelector(".replay-canvas");
            const loading = [
              ...document.querySelectorAll('[role="status"]'),
            ].some((e) => e.textContent.includes("Loading the exact state"));
            if (
              window.__canvasDraws.length > previousDraws &&
              canvas
                ?.getAttribute("aria-label")
                .includes(`${total} active patients;`) &&
              !loading
            )
              return resolve(performance.now() - begin);
            if (performance.now() - begin > 15000)
              return reject(Error("Seek state did not render"));
            requestAnimationFrame(check);
          };
          button.click();
          requestAnimationFrame(check);
        }),
      { label, total },
    );
  }
  // Warm both selected timestamps and their exact state/query caches before recording.
  await seek("Go to run horizon", stateEnd.patient_total);
  await seek("Return to run start", stateStart.patient_total);
  const seeks = [];
  for (let i = 0; i < 6; i++)
    seeks.push(
      await seek(
        i % 2 ? "Return to run start" : "Go to run horizon",
        i % 2 ? stateStart.patient_total : stateEnd.patient_total,
      ),
    );
  evidence.cached_timeline_seek = {
    ...summary(seeks),
    target_ms: 500,
    all_within_target: seeks.every((x) => x < 500),
    endpoint:
      "Browser click to exact timestamp canvas redraw, expected full patient count, and cleared loading indicator",
  };
  // Measure a late state, where a sustained surge can exercise the full token
  // budget. Keep enough simulated time available for the playback sample.
  const lateAt = new Date(
    Math.max(
      Date.parse(start),
      Date.parse(end) - replayLeadHours * 60 * 60 * 1000,
    ),
  ).toISOString();
  const lateState = await get(
    `/runs/${rep}/state?at=${encodeURIComponent(lateAt)}`,
  );
  await page.goto(url("replay") + "&at=" + encodeURIComponent(lateAt));
  await page.locator(".replay-canvas").waitFor();
  await page.waitForFunction(
    (total) =>
      window.__canvasDraws.length > 0 &&
      document
        .querySelector(".replay-canvas")
        ?.getAttribute("aria-label")
        .includes(`${total} active patients;`) &&
      ![...document.querySelectorAll('[role="status"]')].some((e) =>
        e.textContent.includes("Loading the exact state"),
      ),
    lateState.patient_total,
  );
  await page
    .getByRole("button", { name: `${playbackSpeed}×`, exact: true })
    .click();
  playbackStateResponses = [];
  const replayStart = await page.evaluate(() => ({
    label: document.querySelector(".replay-canvas").getAttribute("aria-label"),
  }));
  const cadence = await page.evaluate(
    () =>
      new Promise((resolve) => {
        window.__canvasDraws = [];
        const stamps = [],
          begin = performance.now();
        document.querySelector('[aria-label="Play replay"]').click();
        const frame = (now) => {
          stamps.push(now);
          if (now - begin < 8000) requestAnimationFrame(frame);
          else
            resolve({
              elapsed_ms: now - begin,
              intervals: stamps.slice(1).map((x, i) => x - stamps[i]),
              frames: stamps.length - 1,
              draws: window.__canvasDraws.filter(
                (x) => x.start >= begin && x.end <= now,
              ),
            });
        };
        requestAnimationFrame(frame);
      }),
  );
  await page.getByRole("button", { name: "Pause replay", exact: true }).click();
  const replayEnd = await page.evaluate(() => ({
    draws: window.__canvasDraws,
    label: document.querySelector(".replay-canvas").getAttribute("aria-label"),
    selected_time: document.querySelector(".replay-time strong").textContent,
  }));
  const animationWindows = [];
  let activeWindow = null;
  for (const draw of cadence.draws) {
    if (draw.animating) {
      if (!activeWindow) activeWindow = [];
      activeWindow.push(draw);
    } else if (activeWindow) {
      activeWindow.push(draw);
      animationWindows.push(activeWindow);
      activeWindow = null;
    }
  }
  if (activeWindow) animationWindows.push(activeWindow);
  const animationFrames = animationWindows.map((draws) => [
    ...new Map(
      draws.map((draw) => [draw.display_frame, draw.display_frame_at]),
    ).values(),
  ]);
  const activeIntervals = animationFrames.flatMap((frames) =>
    frames.slice(1).map((at, index) => at - frames[index]),
  );
  const activePaints = cadence.draws.filter((draw) => draw.animating);
  evidence.interactive_replay = {
    observed_seconds: cadence.elapsed_ms / 1000,
    raf_frames_per_second: cadence.frames / (cadence.elapsed_ms / 1000),
    raf_interval: summary(cadence.intervals),
    canvas_redraws_per_second:
      cadence.draws.length / (cadence.elapsed_ms / 1000),
    canvas_redraw_count: cadence.draws.length,
    canvas_redraws: cadence.draws,
    canvas_paint_duration: summary(
      cadence.draws.map((draw) => draw.duration_ms),
    ),
    active_animation_paint_duration: summary(
      activePaints.map((draw) => draw.duration_ms),
    ),
    active_animation_frame_interval: summary(activeIntervals),
    active_animation_windows: animationWindows.map((draws, index) => ({
      draw_count: draws.length,
      elapsed_ms: draws.at(-1).start - draws[0].start,
      canvas_redraws_per_second:
        draws.length > 1
          ? ((draws.length - 1) * 1000) / (draws.at(-1).start - draws[0].start)
          : null,
      unique_display_frames: animationFrames[index].length,
      display_frame_intervals_ms: animationFrames[index]
        .slice(1)
        .map((at, i) => at - animationFrames[index][i]),
      display_frames_per_second:
        animationFrames[index].length > 1
          ? ((animationFrames[index].length - 1) * 1000) /
            (animationFrames[index].at(-1) - animationFrames[index][0])
          : null,
      max_visible_patient_arcs: Math.max(
        ...draws.map((draw) => draw.patient_arcs),
      ),
    })),
    active_animation_measured: activePaints.length > 0,
    completed_state_responses: playbackStateResponses,
    distinct_state_responses: new Set(
      playbackStateResponses.map((item) => item.at),
    ).size,
    recorded_states_rendered: [
      ...new Set(cadence.draws.map((draw) => draw.recorded_at).filter(Boolean)),
    ],
    requested_late_timestamp: lateAt,
    playback_speed: playbackSpeed,
    requested_horizon_lead_hours: replayLeadHours,
    initial_full_patient_total: lateState.patient_total,
    initial_bounded_state_patients: lateState.patients.length,
    max_visible_patient_arcs: Math.max(
      0,
      ...cadence.draws.map((x) => x.patient_arcs),
    ),
    visible_patient_budget: 500,
    reached_visible_patient_budget: cadence.draws.some(
      (x) => x.patient_arcs >= 500,
    ),
    stayed_within_visible_patient_budget: cadence.draws.every(
      (x) => x.patient_arcs <= 500,
    ),
    start_state: replayStart.label,
    end_state: replayEnd.label,
    selected_time: replayEnd.selected_time,
    interpretation: `rAF cadence measures browser responsiveness, not canvas rendering FPS. Overall canvas redraw rate includes static intervals. Active animation windows use the renderer data-animating marker and count actual paints during its 180ms presentation tween. Display-frame intervals deduplicate paints carrying the same browser rAF frame token; paint calls and paint duration remain separate. Clinical state changes remain exact recorded states. Playback is explicitly ${playbackSpeed}× and pauses advancement while remote state loads. Patient counts use exactly the 3.6/6px dot radii, excluding staff icons and selection rings. This is the actual rendered marker count, not an assumption of 500; dense dots may overlap. The complete census remains server-paginated with exact aggregate counts.`,
  };
  await page.locator("main").evaluate(async (main) => {
    main.scrollTop = 0;
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
  await page.screenshot({ path: outputPrefix + ".png", fullPage: true });
  evidence.page_errors = pageErrors;
  evidence.model_mutations = mutations;
  evidence.browser_version = browser.version();
} finally {
  if (local) {
    evidence.local_source_sha256_after = localRendererHashes();
    evidence.local_source_unchanged =
      JSON.stringify(evidence.local_source_sha256) ===
      JSON.stringify(evidence.local_source_sha256_after);
  }
  await browser.close();
  writeFileSync(
    outputPrefix + ".json",
    JSON.stringify(evidence, null, 2) + "\n",
  );
}
console.log(
  JSON.stringify({
    navigation: evidence.warm_authenticated_navigation,
    panel: evidence.local_panel_update,
    seek: evidence.cached_timeline_seek,
    raf_fps: evidence.interactive_replay?.raf_frames_per_second,
    active_window_fps:
      evidence.interactive_replay?.active_animation_windows.map(
        (window) => window.display_frames_per_second,
      ),
    visible_patient_markers:
      evidence.interactive_replay?.max_visible_patient_arcs,
    page_errors: pageErrors,
    model_mutations: mutations,
  }),
);
