import { expect, type Page } from "@playwright/test";

export const scenarioSectionNames = {
  demand: "Arrival details",
  resources: "Staff, beds & equipment",
  timeline: "Staff, beds & equipment",
  calculation: "Calculation details",
} as const;

export async function expandScenarioSection(
  page: Page,
  section: keyof typeof scenarioSectionNames,
) {
  const name = scenarioSectionNames[section];
  const more = page
    .getByTestId("guided-scenario")
    .locator("details")
    .filter({ hasText: "More parameters" })
    .first();
  if (!(await more.getAttribute("open"))) {
    const isOpen = await more.evaluate(
      (node) => (node as HTMLDetailsElement).open,
    );
    if (!isOpen) await more.locator("summary").first().click();
  }
  const control = page
    .getByTestId("guided-scenario")
    .getByRole("button", { name: new RegExp(`^${name}`) });
  await expect(control).toBeVisible();
  if ((await control.getAttribute("aria-expanded")) !== "true")
    await control.click();
  await expect(control).toHaveAttribute("aria-expanded", "true");
  return control;
}

/** Existing detailed editor regressions deliberately open all optional tools. */
export async function expandScenarioDetails(page: Page) {
  for (const section of Object.keys(scenarioSectionNames) as Array<
    keyof typeof scenarioSectionNames
  >)
    await expandScenarioSection(page, section);
}
