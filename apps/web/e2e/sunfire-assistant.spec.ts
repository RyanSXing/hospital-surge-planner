import { expect, test, type Page } from "@playwright/test";
import {
  api,
  assertPageHealthy,
  capture,
  open,
  record,
  scenario,
  waitRun,
} from "./helpers";

const minute = 60_000;
const instant = (start: string, minutes: number) =>
  new Date(Date.parse(start) + minutes * minute).toISOString();
const numbers = (value: string | null) => (value || "").split(",").map(Number);
const pending = (status: string) =>
  ["QUEUED", "RUNNING", "CANCEL_REQUESTED"].includes(status);

test.beforeEach(async ({ baseURL }, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "The planning assistant is a desktop workflow.",
  );
  expect(["localhost", "127.0.0.1", "[::1]"]).toContain(
    new URL(baseURL!).hostname,
  );
});

async function ready(page: Page, id: string) {
  await open(page, id);
  const status = await api(page.request, "/sunfire/status");
  expect(
    status.available,
    status.reason ||
      "A real OCI model must be available; no stub or fallback is accepted.",
  ).toBe(true);
  await page
    .getByRole("button", { name: "Open Sunfire planning assistant" })
    .click();
  await expect(
    page.getByRole("complementary", { name: "Sunfire planning assistant" }),
  ).toBeVisible();
  await expect(page.locator(".sunfire-connection")).toContainText(
    "Uses the current draft",
  );
  return status;
}

async function send(page: Page, message: string) {
  const submitted = page.waitForResponse(
    (response) =>
      /\/api\/sunfire\/chats\/[^/]+\/turns$/.test(response.url()) &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("textbox", { name: "Message Sunfire", exact: true })
    .fill(message);
  await page.getByRole("button", { name: "Send Sunfire message" }).click();
  const response = await submitted;
  expect(response.ok(), await response.text()).toBe(true);
  const turn = await response.json();
  let completed: any;
  await expect
    .poll(
      async () => {
        completed = await api(page.request, `/sunfire/turns/${turn.id}`);
        return pending(completed.status);
      },
      { timeout: 150_000, intervals: [700, 1200, 2000] },
    )
    .toBe(false);
  expect(completed.status, JSON.stringify(completed.error)).toBe("SUCCEEDED");
  return completed;
}

async function applied(page: Page, actionId: string) {
  let result: any;
  await expect
    .poll(
      async () => {
        result = await api(page.request, `/sunfire/actions/${actionId}`);
        return result.action.status;
      },
      { timeout: 30_000, intervals: [250, 700] },
    )
    .toBe("APPLIED");
  await expect(
    page.locator(
      `[data-testid="sunfire-action"][data-action-id="${actionId}"]`,
    ),
  ).toHaveAttribute("data-status", "APPLIED");
  return result;
}

async function expectSplitLayout(page: Page) {
  let layout: any;
  await expect
    .poll(
      async () => {
        layout = await page.evaluate(() => {
          const rect = (selector: string) => {
            const node = document.querySelector(selector)!;
            const box = node.getBoundingClientRect();
            return { x: box.x, right: box.right, width: box.width };
          };
          const main = document.querySelector("main")!;
          const panel = rect(".sunfire-assistant");
          const chart = rect(".arrival-preview");
          const controls = rect(".simulation-main-controls");
          const workspace = rect(".workspace");
          return {
            panel,
            chart,
            controls,
            workspace,
            viewport: innerWidth,
            horizontalOverflow: main.scrollWidth - main.clientWidth,
          };
        });
        return (
          layout.horizontalOverflow <= 1 &&
          layout.workspace.right <= layout.panel.x + 1 &&
          layout.chart.right <= layout.panel.x + 1 &&
          layout.chart.width >= 280 &&
          layout.controls.width >= 170
        );
      },
      { timeout: 10_000, intervals: [100, 250] },
    )
    .toBe(true);
  return layout;
}

test("real Sunfire clarifies an incident, edits the shared draft, undoes it, then saves and runs with measured outcomes", async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  const created = await scenario(page, "Sunfire real incident planning", {
    horizon_calendar_days: 3,
    replications: 2,
    conditions: [],
    interventions: [],
    updates: [],
  });
  const source = await api(page.request, `/scenarios/${created.scenario.id}`);
  const dataset = await api(
    page.request,
    `/datasets/${source.dataset_version_id}`,
  );
  const model = await ready(page, source.id);
  const chart = page.getByTestId("arrival-preview-chart");
  const usual = await chart.getAttribute("data-usual-arrivals");
  const initial = numbers(await chart.getAttribute("data-planned-arrivals"));
  const compact = await expectSplitLayout(page);
  await capture(page, "sunfire-compact-real-provider", testInfo);

  // Material dates/unit/duration are intentionally absent. A real model must ask,
  // rather than silently inventing an accident or closure timetable.
  const question = await send(
    page,
    "An accident brings 100 extra patients and 10 beds are unavailable. Please set this up.",
  );
  expect(question.actions).toEqual([]);
  expect(question.text).toMatch(/\?|when|which|date|duration|time/i);
  expect(await api(page.request, `/scenarios/${source.id}`)).toEqual(source);
  await expect(chart).toHaveAttribute(
    "data-planned-arrivals",
    initial.map((value) => value.toFixed(2)).join(","),
  );

  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: dataset.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant(source.start_at, 24 * 60)));
  const nextDay = new Intl.DateTimeFormat("en-CA", {
    timeZone: dataset.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant(source.start_at, 48 * 60)));
  const receiptRequests: { url: string; body: any }[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/sunfire\/actions\/[^/]+\/(ack|apply)$/.test(
        new URL(request.url()).pathname,
      )
    )
      receiptRequests.push({
        url: request.url(),
        body: request.postDataJSON(),
      });
  });
  const incident = await send(
    page,
    `Apply this to the current draft without saving or running: exactly 100 additional emergency-department patients on ${day} at 10:00 AM America/Chicago, spread over 60 minutes using the emergency stream's usual care mix. Keep the usual arrival curve unchanged. Make exactly 10 currently enabled Ward A beds temporarily unavailable from ${day} at 8:00 AM until ${nextDay} at 8:00 AM America/Chicago, then restore the previous availability. Keep installed beds and staff unchanged.`,
  );
  expect(incident.actions).toHaveLength(1);
  const action = incident.actions[0];
  expect(action.mode).toBe("direct");
  expect(action.kind).toBe("edit");
  const patch = action.validated_draft;
  const batches = patch.conditions.filter(
    (condition: any) => condition.kind === "arrival_batch",
  );
  expect(batches).toHaveLength(1);
  expect(batches[0]).toMatchObject({
    count: 100,
    entry_stream_id: "ED_MAIN",
    spread_minutes: 60,
  });
  expect(Date.parse(batches[0].at)).toBe(
    Date.parse(instant(source.start_at, 34 * 60)),
  );
  expect(
    patch.conditions.filter(
      (condition: any) => condition.kind === "arrival_multiplier",
    ),
  ).toEqual(
    source.conditions.filter(
      (condition: any) => condition.kind === "arrival_multiplier",
    ),
  );
  const windows = patch.updates
    .filter(
      (event: any) =>
        event.type === "capacity_change" &&
        event.payload.unit_id === "UNIT-WARD-A",
    )
    .sort(
      (a: any, b: any) =>
        Date.parse(a.effective_at) - Date.parse(b.effective_at),
    );
  expect(windows).toHaveLength(2);
  const ward = dataset.units.find(
    (unit: any) => unit.unit_id === "UNIT-WARD-A",
  );
  expect(windows.map((event: any) => event.payload.enabled_capacity)).toEqual([
    ward.enabled_capacity - 10,
    ward.enabled_capacity,
  ]);
  expect(windows.map((event: any) => Date.parse(event.effective_at))).toEqual([
    Date.parse(instant(source.start_at, 32 * 60)),
    Date.parse(instant(source.start_at, 56 * 60)),
  ]);
  await applied(page, action.id);
  await expect(page.locator(".sunfire-assistant")).toHaveAttribute(
    "data-mode",
    "expanded",
  );
  const planned = initial.map((value, index) =>
    Number((value + (index === 1 ? 100 : 0)).toFixed(2)),
  );
  await expect
    .poll(async () =>
      numbers(await chart.getAttribute("data-planned-arrivals")),
    )
    .toEqual(planned);
  await expect(chart).toHaveAttribute("data-usual-arrivals", usual!);
  expect(await api(page.request, `/scenarios/${source.id}`)).toEqual(source);
  expect(
    receiptRequests.filter((request) =>
      request.url.endsWith(`/${action.id}/ack`),
    ),
  ).toHaveLength(1);
  const expanded1280 = await expectSplitLayout(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const expanded1440 = await expectSplitLayout(page);
  await page
    .getByRole("button", { name: "Collapse navigation", exact: true })
    .click();
  const collapsedNavigation = await expectSplitLayout(page);
  await page
    .getByRole("button", { name: "Expand navigation", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Collapse planning assistant", exact: true })
    .click();
  await expectSplitLayout(page);
  await page
    .getByRole("button", { name: "Expand planning assistant", exact: true })
    .click();
  await capture(page, "sunfire-expanded-incident-readback", testInfo);

  // One server-guarded Undo restores both changes; the editor's normal Undo and
  // Redo can then reverse that same transaction without a second draft model.
  await page
    .locator(`[data-action-id="${action.id}"]`)
    .getByRole("button", { name: "Undo changes", exact: true })
    .click();
  await expect
    .poll(async () =>
      numbers(await chart.getAttribute("data-planned-arrivals")),
    )
    .toEqual(initial);
  await page
    .locator(".undo-actions")
    .getByRole("button", { name: "Undo", exact: true })
    .click();
  await expect
    .poll(async () =>
      numbers(await chart.getAttribute("data-planned-arrivals")),
    )
    .toEqual(planned);
  await page
    .locator(".undo-actions")
    .getByRole("button", { name: "Redo", exact: true })
    .click();
  await expect
    .poll(async () =>
      numbers(await chart.getAttribute("data-planned-arrivals")),
    )
    .toEqual(initial);
  await page
    .locator(".undo-actions")
    .getByRole("button", { name: "Undo", exact: true })
    .click();
  await expect
    .poll(async () =>
      numbers(await chart.getAttribute("data-planned-arrivals")),
    )
    .toEqual(planned);

  const measuredOutcomes = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      /\/api\/run-groups\/[^/]+\/metrics$/.test(url.pathname) &&
      url.searchParams.get("grain") === "day" &&
      url.searchParams.get("max_points") === "200"
    );
  });
  const runTurn = await send(
    page,
    "Save exactly the current draft shown in Configuration and run its two simulation repetitions now. Do not change any parameters.",
  );
  expect(runTurn.actions).toHaveLength(1);
  expect(runTurn.actions[0].kind).toBe("run");
  const executed = await applied(page, runTurn.actions[0].id);
  expect(executed.receipt.run_group.id).toBeTruthy();
  const run = await waitRun(page, executed.receipt.run_group.id);
  const card = page.locator(
    `[data-testid="sunfire-run-progress"][data-run-id="${run.id}"]`,
  );
  await expect(card).toHaveAttribute("data-status", "SUCCEEDED");
  await expect(card).toContainText("Simulation complete");
  // This is the real card request. The bounded metrics contract requires at
  // least 200 points; a rejected request must not silently mask real results.
  const measuredResponse = await measuredOutcomes;
  expect(new URL(measuredResponse.url()).pathname).toBe(
    `/api/run-groups/${run.id}/metrics`,
  );
  expect(measuredResponse.ok(), await measuredResponse.text()).toBe(true);
  const metrics = await measuredResponse.json();
  const statistic = (value: any) =>
    typeof value === "number" ? value : value?.p50;
  const average = statistic(
    metrics.scalar_metrics.average_wait_per_patient_hours,
  );
  const row = card
    .locator(".sunfire-result-measures > div")
    .filter({ hasText: "Average wait per patient" });
  await expect(row).toContainText(
    average === undefined || average === null
      ? "Unavailable"
      : `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(average)} hours`,
  );
  const saved = await api(page.request, `/scenarios/${source.id}`);
  expect(
    saved.conditions.filter(
      (condition: any) => condition.kind === "arrival_batch",
    ),
  ).toEqual(batches);
  expect(
    saved.updates.filter((event: any) => event.type === "capacity_change"),
  ).toEqual(windows);
  const events = await api(
    page.request,
    `/runs/${run.selected_replication_id}/events?event_type=arrival&start_at=${encodeURIComponent(batches[0].at)}&end_at=${encodeURIComponent(instant(batches[0].at, 60))}&limit=200`,
  );
  const incidentArrivals = events.items.filter((event: any) =>
    event.patient_id?.startsWith(`PAT-REPORT-${batches[0].id}-`),
  );
  expect(incidentArrivals).toHaveLength(100);
  const enabledCounts = [];
  for (const hours of [31.99, 32.01, 56.01]) {
    const state = await api(
      page.request,
      `/runs/${run.selected_replication_id}/state?at=${encodeURIComponent(instant(source.start_at, hours * 60))}`,
    );
    const unit = state.units.find((item: any) => item.unit_id === ward.unit_id);
    expect(unit.physical).toBe(ward.physical_capacity);
    enabledCounts.push(unit.enabled);
  }
  expect(enabledCounts).toEqual([
    ward.enabled_capacity,
    ward.enabled_capacity - 10,
    ward.enabled_capacity,
  ]);
  await capture(page, "sunfire-measured-completed-results", testInfo);

  // Evidence controls must open the actual saved run, including a retained or
  // reconstructed example at its recorded shortage time, without resetting chat.
  const bottlenecks = await api(
    page.request,
    `/run-groups/${run.id}/bottlenecks`,
  );
  await card.getByRole("button", { name: "View summary", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Results summary", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("run"))
    .toBe(run.id);
  await expect
    .poll(() => new URL(page.url()).searchParams.get("analysis"))
    .toBe("summary");
  await expect(page.locator(".sunfire-assistant")).toBeVisible();
  const decision = page.getByTestId("decision-summary");
  await expect(decision).toBeVisible();
  if (bottlenecks.evidence_available) {
    await decision.getByText("Why this conclusion?", { exact: true }).click();
    await expect(decision).toContainText(
      "Constraint evidence: completed simulations",
    );
    await decision.getByText("Why this conclusion?", { exact: true }).click();
  }
  let replayNavigation: any = null;
  const bottleneckButton = card.getByRole("button", {
    name: "View bottleneck",
    exact: true,
  });
  if (await bottleneckButton.count()) {
    const recordedSources = [
      ...(bottlenecks.categories || []),
      ...(bottlenecks.units || []),
      ...(bottlenecks.resources || []),
    ].filter((record) => record.first_at && record.first_replication_id);
    const actualReplayResponse = page.waitForResponse((response) => {
      const target = new URL(response.url());
      return recordedSources.some(
        (record) =>
          target.pathname ===
            `/api/runs/${record.first_replication_id}/state` &&
          Date.parse(target.searchParams.get("at") || "") ===
            Date.parse(record.first_at),
      );
    });
    await bottleneckButton.click();
    await expect(
      page.getByRole("heading", { name: "Patient flow replay", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("analysis"))
      .toBe("replay");
    const selected = new URL(page.url());
    const replication = selected.searchParams.get("replication");
    const at = selected.searchParams.get("at");
    expect(
      recordedSources.some(
        (record) =>
          record.first_replication_id === replication &&
          Date.parse(record.first_at) === Date.parse(at || ""),
      ),
    ).toBe(true);
    const exactResponse = await actualReplayResponse;
    expect(exactResponse.ok(), await exactResponse.text()).toBe(true);
    const exact = await exactResponse.json();
    expect(exact.context.run_group_id).toBe(run.id);
    expect(exact.context.replication_id).toBe(replication);
    const floor = page.getByTestId("replay-floor-plan");
    await expect(floor).toHaveAttribute("data-replication-id", replication!);
    await expect
      .poll(async () =>
        Date.parse((await floor.getAttribute("data-recorded-at")) || ""),
      )
      .toBe(Date.parse(at!));
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const viewport = document
            .querySelector('[data-testid="floor-plan-fit-viewport"]')!
            .getBoundingClientRect();
          const assistant = document
            .querySelector(".sunfire-assistant")!
            .getBoundingClientRect();
          const shapes = Array.from(
            document.querySelectorAll(
              ".floor-plan-building, .floor-plan-unit, .floor-plan-entrance, .floor-plan-exit",
            ),
          );
          return (
            viewport.right <= assistant.left + 1 &&
            shapes.every((element) => {
              const shape = element.getBoundingClientRect();
              return (
                shape.left >= viewport.left - 1 &&
                shape.right <= viewport.right + 1 &&
                shape.top >= viewport.top - 1 &&
                shape.bottom <= viewport.bottom + 1
              );
            })
          );
        }),
      )
      .toBe(true);
    replayNavigation = {
      replication_id: replication,
      at,
      trace_ready: (await api(page.request, `/runs/${replication}/trace`))
        .ready,
    };
    expect(replayNavigation.trace_ready).toBe(true);
    await capture(page, "sunfire-recorded-bottleneck-navigation", testInfo);
  } else {
    // A result without a supported shortage source has no Replay destination;
    // do not invent a timestamp merely to force this optional navigation path.
    replayNavigation = {
      state: "No supported bottleneck destination",
      evidence_available: bottlenecks.evidence_available,
    };
  }
  await page
    .getByRole("button", { name: "Configuration", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Configuration", exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () =>
      numbers(await chart.getAttribute("data-planned-arrivals")),
    )
    .toEqual(planned);
  await expect(card).toContainText("Simulation complete");
  await expect(page.locator(".sunfire-transcript")).toContainText(
    "100 additional emergency-department patients",
  );
  await expectSplitLayout(page);

  await page
    .getByRole("textbox", { name: "Message Sunfire", exact: true })
    .fill("Keep this unsent note");
  await page
    .getByRole("textbox", { name: "Message Sunfire", exact: true })
    .press("Escape");
  await expect(
    page.getByRole("button", { name: "Open Sunfire planning assistant" }),
  ).toBeFocused();
  await page
    .getByRole("button", { name: "Open Sunfire planning assistant" })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Message Sunfire", exact: true }),
  ).toHaveValue("Keep this unsent note");
  const writesBeforeReload = receiptRequests.length;
  await page.reload();
  await page
    .getByRole("button", { name: "Open Sunfire planning assistant" })
    .click();
  await expect(page.locator(".sunfire-transcript")).toContainText(
    "100 additional emergency-department patients",
  );
  await expect(
    page.locator(
      `[data-testid="sunfire-run-progress"][data-run-id="${run.id}"]`,
    ),
  ).toContainText("Simulation complete");
  expect(receiptRequests.length).toBe(writesBeforeReload);
  expect((await api(page.request, `/scenarios/${source.id}`)).revision).toBe(
    saved.revision,
  );
  await assertPageHealthy(page);
  record("sunfire-real-provider", {
    model: model.model,
    scenario_id: source.id,
    clarification_turn_id: question.id,
    incident_turn_id: incident.id,
    run_turn_id: runTurn.id,
    run_id: run.id,
    incident_patients: incidentArrivals.length,
    enabled_counts: enabledCounts,
    replay_navigation: replayNavigation,
    saved_revision: saved.revision,
    layout: { compact, expanded1280, expanded1440, collapsedNavigation },
    actual_metrics: metrics.scalar_metrics,
    action_request_counts: receiptRequests.map(
      (request) => request.url.split("/api/")[1],
    ),
  });
});

test("a delayed real model response cannot overwrite manual edits and a fresh request can recover", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const created = await scenario(page, "Sunfire stale draft protection", {
    horizon_calendar_days: 3,
    replications: 2,
  });
  await ready(page, created.scenario.id);
  const controls = page.locator("#hospital-capacity-parameters");
  await controls.getByRole("radio", { name: "Ward A", exact: true }).check();
  const nurses = controls.getByRole("textbox", {
    name: "Ward A registered nurses",
    exact: true,
  });
  const before = Number(await nurses.inputValue());
  const target = before + 2;
  const manual = before + 1;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let capturedResponses = 0;
  const pattern = /\/api\/sunfire\/turns\/[^/?]+$/;
  const handler = async (route: any) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    if (body.status === "SUCCEEDED" && body.actions?.length) {
      capturedResponses++;
      await held;
    }
    await route.fulfill({ response });
  };
  await page.route(pattern, handler);
  try {
    const original = await send(
      page,
      `Set Ward A registered nurses to ${target} per shift throughout this simulation and update the linked staffed-bed target as the normal nurse control does. Apply it to the draft now without saving or running. Leave other parameters unchanged.`,
    );
    expect(original.actions).toHaveLength(1);
    await expect
      .poll(() => capturedResponses, { timeout: 20_000 })
      .toBeGreaterThan(0);
    await nurses.fill(String(manual));
    await nurses.blur();
    await expect(nurses).toHaveValue(String(manual));
    release();
    const action = page.locator(
      `[data-testid="sunfire-action"][data-action-id="${original.actions[0].id}"]`,
    );
    await expect(action).toHaveAttribute("data-status", "stale");
    await expect(action).toContainText("configuration changed");
    await expect(nurses).toHaveValue(String(manual));
    expect(
      (await api(page.request, `/sunfire/actions/${original.actions[0].id}`))
        .action.status,
    ).toBe("READY");
    expect(
      (await api(page.request, `/scenarios/${created.scenario.id}`)).revision,
    ).toBe(created.scenario.revision);
    await page.unroute(pattern, handler);
    const fresh = await send(
      page,
      `Using the current manually edited draft, set Ward A registered nurses to ${target} per shift now, keep the normal linked staffed-bed relationship, and leave everything else unchanged. Do not save or run.`,
    );
    expect(fresh.actions).toHaveLength(1);
    expect(fresh.actions[0].expected.draft_fingerprint).not.toBe(
      original.actions[0].expected.draft_fingerprint,
    );
    await applied(page, fresh.actions[0].id);
    await expect(nurses).toHaveValue(String(target));
    await assertPageHealthy(page);
    record("sunfire-real-delayed-response-cas", {
      scenario_id: created.scenario.id,
      original_turn_id: original.id,
      fresh_turn_id: fresh.id,
      held_actual_provider_responses: capturedResponses,
      manual_nurses_preserved: manual,
      recovered_nurses: target,
      scenario_revision_unchanged: (
        await api(page.request, `/scenarios/${created.scenario.id}`)
      ).revision,
    });
  } finally {
    release();
    await page.unroute(pattern, handler);
  }
});
