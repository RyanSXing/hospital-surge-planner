import { test, expect } from "@playwright/test";
import { scenario, open, assertPageHealthy, capture, record } from "./helpers";

test("light hospital navigation is compact, collapsible, and retains its preference", async ({
  page,
}, info) => {
  const context = await scenario(
    page,
    "light hospital navigation",
    {
      horizon_calendar_days: 1,
      replications: 2,
    },
    "hospital_baseline",
  );
  await open(page, context.scenario.id, "overview");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(page.locator("html")).toHaveAttribute(
    "data-mantine-color-scheme",
    "light",
  );
  await expect(
    page.getByRole("heading", { name: "Hospital overview", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Run simulation", exact: true }),
  ).toHaveCount(1);
  await expect(page.locator(".more-simulation-parameters")).not.toHaveAttribute(
    "open",
  );
  await expect(
    page.getByRole("region", { name: "Main simulation parameters" }),
  ).toBeVisible();
  await expect(page.locator(".arrival-preview")).toBeVisible();
  await expect(
    page.getByText("Synthetic planning data", { exact: true }),
  ).toHaveCount(0);
  if (info.project.name === "desktop") {
    expect(
      await page
        .locator(".sidebar")
        .evaluate((el) => el.getBoundingClientRect().width),
    ).toBeGreaterThanOrEqual(190);
    await page
      .getByRole("button", { name: "Collapse navigation", exact: true })
      .click();
    await expect(page.locator(".app-shell")).toHaveClass(
      /navigation-collapsed/,
    );
    await expect
      .poll(() =>
        page
          .locator(".sidebar")
          .evaluate((el) => el.getBoundingClientRect().width),
      )
      .toBeLessThanOrEqual(70);
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Expand navigation", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Expand navigation", exact: true })
      .click();
    await expect(
      page
        .getByRole("navigation", { name: "Main navigation" })
        .getByRole("button", { name: "Overview", exact: true }),
    ).toBeVisible();
  } else {
    await page
      .getByRole("button", { name: "Toggle navigation", exact: true })
      .tap();
    await page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("button", { name: "Analysis", exact: true })
      .tap();
    await expect(page.locator(".sidebar")).not.toHaveClass(/open/);
    await expect(
      page.getByRole("navigation", { name: "Analysis navigation" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Go to Overview", exact: true })
      .tap();
  }
  await page
    .getByRole("button", { name: "Workspace options", exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Data & setup", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Planning alerts", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Planning alerts", exact: true }),
  ).toBeFocused();
  await assertPageHealthy(page);
  expect(errors).toEqual([]);
  await capture(page, "hospital-shell", info);
  record(`hospital-shell-${info.project.name}`, {
    scenario_id: context.scenario.id,
    light_theme: true,
    navigation_preference_verified: info.project.name === "desktop",
    dialog_focus_restored: true,
    page_errors: errors,
  });
});

test("completed result loading failures explain the error and retry without rerunning the model", async ({
  page,
}, info) => {
  test.skip(
    info.project.name === "mobile",
    "Network recovery state is exercised once.",
  );
  const { api, waitRun } = await import("./helpers");
  const context = await scenario(
    page,
    "forecast read recovery",
    {
      horizon_calendar_days: 1,
      replications: 1,
    },
    "hospital_baseline",
  );
  const run = await waitRun(
    page,
    (
      await api(page.request, "/run-groups", "POST", {
        scenario_id: context.scenario.id,
      })
    ).id,
  );
  const pattern = `**/api/run-groups/${run.id}/metrics?**`;
  await page.route(pattern, (route) =>
    route.fulfill({
      status: 503,
      json: {
        detail: "Synthetic verification of temporary metrics read failure",
      },
    }),
  );
  await open(page, context.scenario.id, "summary", run.id);
  await expect(
    page.getByRole("heading", {
      name: "Forecast results unavailable",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry results", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Current operations are ready for review", { exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".summary-metrics")).toHaveCount(0);
  await page.unroute(pattern);
  const submissions: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/api/run-groups")
    )
      submissions.push(request.url());
  });
  await page
    .getByRole("button", { name: "Retry results", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Results summary", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".summary-metrics")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("run")).toBe(run.id);
  expect(submissions).toEqual([]);
  record("forecast-read-recovery", {
    run_id: run.id,
    recovered_actual_metrics: true,
    no_new_simulation: true,
  });
});
