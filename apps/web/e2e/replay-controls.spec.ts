import { test, expect } from "@playwright/test";
import { api, capture, open, record, scenario, waitRun } from "./helpers";

test("playback speed, pause, seek and exact event stepping preserve frozen results", async ({
  page,
}, info) => {
  test.skip(
    info.project.name === "mobile",
    "Playback semantics are exercised once; responsive presentation separately.",
  );
  const context = await scenario(page, "playback semantics", {
      horizon_calendar_days: 2,
      replications: 1,
    }),
    run = await waitRun(
      page,
      (
        await api(page.request, "/run-groups", "POST", {
          scenario_id: context.scenario.id,
        })
      ).id,
    );
  await open(page, context.scenario.id, "replay", run.id);
  await expect(page.getByLabel("Play replay", { exact: true })).toBeEnabled();
  const at = () => new URL(page.url()).searchParams.get("at");
  const originalAt = at();
  await page.getByLabel("Replay speed", { exact: true }).selectOption("1");
  await page.getByLabel("Play replay", { exact: true }).click();
  await expect.poll(at).not.toBe(originalAt);
  await page.getByLabel("Pause replay", { exact: true }).click();
  const paused = at();
  await page.waitForTimeout(1300);
  expect(at()).toBe(paused);
  await page.getByLabel("Replay speed", { exact: true }).selectOption("16");
  await expect(page.getByLabel("Replay speed", { exact: true })).toHaveValue(
    "16",
  );
  await page.getByLabel("Go to run horizon", { exact: true }).click();
  await expect.poll(at).toBe(run.end_at);
  await expect(page.getByLabel("Play replay", { exact: true })).toBeDisabled();
  const scrubber = page.getByLabel(
    "Replay timestamp across actual elapsed horizon",
  );
  await scrubber.focus();
  await page.keyboard.press("Home");
  await expect
    .poll(() => Date.parse(at() || ""))
    .toBe(Date.parse(run.start_at));
  await expect(
    page.getByLabel("Next recorded event", { exact: true }),
  ).toBeEnabled();
  await page.getByLabel("Next recorded event", { exact: true }).click();
  await page
    .getByRole("button", { name: "Inspect replay", exact: true })
    .click();
  await page.getByRole("tab", { name: "Events", exact: true }).click();
  await expect(page.locator(".event-feed .info-note")).toContainText("Event");
  const first = (await page.locator(".event-feed .info-note").textContent())!;
  await page.keyboard.press("Escape");
  await page.getByLabel("Next recorded event", { exact: true }).click();
  await expect(page.locator(".event-feed .info-note")).not.toHaveText(first);
  await page.getByLabel("Previous recorded event", { exact: true }).click();
  await expect(page.locator(".event-feed .info-note")).toHaveText(first);
  await page
    .getByRole("button", { name: "Advanced replay tools", exact: true })
    .click();
  await page.getByLabel("Reduced motion", { exact: true }).check();
  await expect(page.getByLabel("Play replay", { exact: true })).toBeEnabled();
  const reducedAt = at();
  await page.getByLabel("Play replay", { exact: true }).click();
  await expect.poll(at).not.toBe(reducedAt);
  await page.getByLabel("Pause replay", { exact: true }).click();
  await expect(page.getByTestId("replay-floor-plan")).toHaveAttribute(
    "data-retaining",
    "false",
  );
  const final = await api(page.request, "/run-groups/" + run.id);
  expect(final.input_sha256).toBe(run.input_sha256);
  expect(final.status).toBe("SUCCEEDED");
  await capture(page, "replay-controls", info);
  record("replay-controls", {
    run_id: run.id,
    input_sha256: run.input_sha256,
    paused_at: paused,
    exclusive_end_at: run.end_at,
    exact_event_cursor: true,
    reduced_motion_plays_without_tweening: true,
  });
});
