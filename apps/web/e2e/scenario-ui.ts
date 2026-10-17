import { expect, type Page } from "@playwright/test";

export const scenarioSectionNames = {
  demand: "Arrival timing & patient mix",
  resources: "Staff, beds, equipment & response plans",
  timeline: "Visual planning timeline",
  calculation: "Calculation details",
} as const;

export async function expandScenarioSection(
  page: Page,
  section: keyof typeof scenarioSectionNames,
) {
  const name = scenarioSectionNames[section];
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
