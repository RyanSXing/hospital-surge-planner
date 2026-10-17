import { test, expect } from "@playwright/test";
import { api, capture, open, record, scenario, waitRun } from "./helpers";
import { utcToWall } from "../src/zonedTime";

test("replay exposes complete filtered events, patient history and recorded resources", async ({
  page,
}, info) => {
  const context = await scenario(
    page,
    "complete replay evidence",
    {
      horizon_calendar_days: 2,
      replications: 1,
      conditions: [
        { id: "replay-surge", kind: "arrival_multiplier", surge_percent: 70 },
      ],
      interventions: [
        { id: "clinic-readiness", kind: "clinic", activation_minutes: 60 },
      ],
    },
    "stress_snapshot",
  );
  const run = await waitRun(
    page,
    (
      await api(page.request, "/run-groups", "POST", {
        scenario_id: context.scenario.id,
      })
    ).id,
  );
  const rep = run.selected_replication_id;
  const at = new Date(Date.parse(run.start_at) + 6 * 3600000).toISOString();
  const annotations = await api(page.request, `/runs/${rep}/annotations`);
  expect(annotations.conditions).toHaveLength(1);
  expect(annotations.shortage_periods.length).toBeGreaterThan(0);
  await open(page, context.scenario.id, "replay", run.id);
  const url = new URL(page.url());
  url.searchParams.set("at", at);
  await page.goto(url.toString());
  if (info.project.name === "mobile") {
    const viewport = page.locator(".replay-canvas-viewport");
    await expect(page.getByLabel("Focus care zone")).toBeVisible();
    await expect
      .poll(() =>
        viewport.evaluate(
          (element) => element.scrollWidth - element.clientWidth,
        ),
      )
      .toBeGreaterThan(500);
    await page.getByLabel("Focus care zone").selectOption("ward");
    await expect
      .poll(() => viewport.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(400);
    const geometry = await page
      .locator(".replay-canvas")
      .evaluate((element) => element.getBoundingClientRect().toJSON());
    expect(geometry.width).toBeGreaterThanOrEqual(900);
    expect(geometry.height / geometry.width).toBeCloseTo(620 / 1000, 2);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    await capture(page, "replay-mobile-readable-zones", info);
  }
  await page
    .getByRole("button", { name: "Inspect replay", exact: true })
    .click();
  await page.getByRole("tab", { name: "Events", exact: true }).click();
  const feed = page.locator(".event-feed");
  const events = await api(
    page.request,
    `/runs/${rep}/events?at=${encodeURIComponent(at)}&limit=20`,
  );
  await expect(feed.getByLabel("Replay event type filter")).toBeVisible();
  await expect(feed.locator(".replay-event-list > button")).toHaveCount(
    Math.min(20, events.total),
  );
  const firstPage = await feed
    .locator(".replay-event-list > button")
    .allTextContents();
  if (events.total > 20) {
    await feed.getByLabel("Next replay event page").click();
    await expect(
      feed.locator(".replay-event-list > button").first(),
    ).not.toHaveText(firstPage[0]);
    await feed.getByLabel("Previous replay event page").click();
    await expect(
      feed.locator(".replay-event-list > button").first(),
    ).toHaveText(firstPage[0]);
  }
  const type = events.event_types.find(
    (value: string) => events.event_type_counts[value] > 0,
  );
  await feed.getByLabel("Replay event type filter").selectOption(type);
  await expect(feed.locator(".replay-event-list > button")).toHaveCount(
    Math.min(20, events.event_type_counts[type]),
  );
  for (const value of await feed
    .locator(".replay-event-list strong")
    .allTextContents())
    expect(value).toBe(type.replaceAll("_", " "));

  const state = await api(
    page.request,
    `/runs/${rep}/state?at=${encodeURIComponent(at)}`,
  );
  const patient = state.patients.find(
    (value: any) => value.state === "ed_assessment",
  );
  expect(patient).toBeTruthy();
  await page.getByRole("tab", { name: "Capacity", exact: true }).click();
  const resources = page.locator(".replay-recorded-capacity");
  await resources
    .getByLabel("Replay resource unit")
    .selectOption(patient.unit_id);
  const unit = state.units.find(
    (value: any) => value.unit_id === patient.unit_id,
  );
  const slotCount = state.slots.filter(
    (value: any) =>
      value.unit_id === patient.unit_id &&
      value.installation_status === "installed",
  ).length;
  await expect(resources.locator(".bed-grid .bed")).toHaveCount(slotCount);
  await expect(resources).toContainText(
    `${unit.occupied} / ${unit.staffed} / ${unit.physical}`,
  );
  await resources
    .getByRole("button", {
      name: new RegExp(", patient " + patient.patient_id),
    })
    .click();
  const detail = await api(
    page.request,
    `/runs/${rep}/patients/${patient.patient_id}?at=${encodeURIComponent(at)}`,
  );
  await page.getByRole("tab", { name: "Patient", exact: true }).click();
  const history = page.locator(".replay-patient-history");
  await expect(history.locator("summary")).toHaveText(
    `${detail.events.length} recorded patient events`,
  );
  await history.locator("summary").click();
  await expect(history.locator(".replay-care-path li")).toHaveCount(
    detail.events.length,
  );
  const next = detail.events.find(
    (event: any) => Date.parse(event.occurred_at) > Date.parse(at),
  );
  expect(next).toBeTruthy();
  await history
    .locator(".replay-neighbor-events > div")
    .nth(1)
    .getByRole("button")
    .click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("at"))
    .toBe(next.occurred_at);
  await expect(feed.locator(".info-note")).toContainText(
    `Event ${next.sequence_number}`,
  );

  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Advanced replay tools", exact: true })
    .click();
  const bands = page.getByRole("region", {
    name: "Recorded replay timeline annotations",
  });
  await expect(bands.locator(".arrival button")).toHaveCount(1);
  await expect(bands.locator(".shortage button")).toHaveCount(
    annotations.shortage_periods.length,
  );
  await expect(bands.locator(".intervention button.recorded")).toHaveCount(
    annotations.intervention_results.filter(
      (value: any) => value.ready_at || value.at,
    ).length,
  );
  await bands.locator(".shortage button").first().click();
  await expect
    .poll(() => Date.parse(new URL(page.url()).searchParams.get("at") || ""))
    .toBe(Date.parse(annotations.shortage_periods[0].start_at));
  await expect
    .poll(async () =>
      Date.parse(
        (await page
          .locator(".replay-canvas")
          .getAttribute("data-recorded-at")) || "",
      ),
    )
    .toBe(Date.parse(annotations.shortage_periods[0].start_at));
  await expect(page.getByText("Loading this census page…")).toHaveCount(0);
  await expect(page.locator(".replay-canvas")).toHaveAttribute(
    "data-animating",
    "false",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.locator("main").evaluate((node) => {
    node.scrollTop = 0;
  });
  if (info.project.name === "desktop") {
    await page.setViewportSize({ width: 1600, height: 900 });
    const geometry = await page
      .locator(".replay-canvas")
      .evaluate((node: HTMLCanvasElement) => {
        const bounds = node.getBoundingClientRect();
        return {
          width: bounds.width,
          height: bounds.height,
          rasterRatio: node.height / node.width,
        };
      });
    expect(geometry.width).toBeGreaterThan(700);
    expect(geometry.height / geometry.width).toBeCloseTo(
      geometry.rasterRatio,
      3,
    );
    // Complete annotations remain reachable through ordinary page scrolling.
    await page
      .getByRole("region", { name: "Recorded replay timeline annotations" })
      .scrollIntoViewIfNeeded();
    await expect(page.locator(".replay-annotations")).toBeVisible();
  }
  await capture(page, "replay-complete-evidence", info);
  const later = new Date(Date.parse(run.start_at) + 24 * 3600000).toISOString();
  const arrivals = await api(
    page.request,
    `/runs/${rep}/events?start_at=${encodeURIComponent(later)}&event_type=arrival&limit=30`,
  );
  const laterPatients = await Promise.all(
    arrivals.items.map((event: any) =>
      api(
        page.request,
        `/runs/${rep}/patients/${event.patient_id}?at=${encodeURIComponent(run.start_at)}`,
      ),
    ),
  );
  const future = laterPatients.find(
    (value: any) =>
      value.censored && Date.parse(value.arrival_at) > Date.parse(run.start_at),
  );
  expect(future).toBeTruthy();
  const futureURL = new URL(page.url());
  futureURL.searchParams.set("patient", future.patient_id);
  futureURL.searchParams.set("at", run.start_at);
  await page.goto(futureURL.toString());
  await page
    .getByRole("button", { name: "Inspect replay", exact: true })
    .click();
  await expect(
    page.locator(".replay-patient-history .info-note"),
  ).toContainText("Not yet arrived");
  const initial = await api(
    page.request,
    `/runs/${rep}/state?at=${encodeURIComponent(run.start_at)}`,
  );
  await expect(page.locator(".replay-canvas")).toHaveAttribute(
    "data-visible-markers",
    String(initial.patients.length),
  );
  const departed = laterPatients.find(
    (value: any) =>
      value.departure_at &&
      Date.parse(value.departure_at) <= Date.parse(run.end_at),
  );
  expect(departed).toBeTruthy();
  futureURL.searchParams.set("patient", departed.patient_id);
  futureURL.searchParams.set("at", run.end_at);
  await page.goto(futureURL.toString());
  await page
    .getByRole("button", { name: "Inspect replay", exact: true })
    .click();
  await expect(
    page.locator(".replay-patient-history .info-note"),
  ).toContainText("Discharged at");
  const last = await api(
    page.request,
    `/runs/${rep}/state?at=${encodeURIComponent(run.end_at)}`,
  );
  await expect(page.locator(".replay-canvas")).toHaveAttribute(
    "data-visible-markers",
    String(last.patients.length),
  );
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Advanced replay tools", exact: true })
    .click();
  const jumped = new Date(Date.parse(run.start_at) + 3 * 3600000).toISOString();
  await page
    .getByLabel("Jump replay date and time", { exact: false })
    .fill(utcToWall(jumped, "America/Chicago"));
  await page
    .locator(".replay-jump")
    .getByRole("button", { name: "Go", exact: true })
    .click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("at"))
    .toBe(jumped);
  await expect(page.locator(".replay-canvas")).toHaveAttribute(
    "data-recorded-at",
    jumped,
  );
  record("replay-complete-evidence", {
    run_id: run.id,
    replication_id: rep,
    paginated_window_total: events.total,
    type_filter: type,
    selected_patient: patient.patient_id,
    exact_slot_count: slotCount,
    patient_history_events: detail.events.length,
    exact_shortage_periods: annotations.shortage_periods.length,
    viewport: info.project.name,
    future_censored_selection_does_not_add_marker: true,
    departed_selection_does_not_add_marker: true,
    utc_jump_reconstructs_requested_time: true,
  });
});
