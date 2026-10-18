import { describe, expect, it } from "vitest";
import { readNavigation, resolvePage, writeNavigation } from "./navigation";

describe("workspace navigation", () => {
  it.each([
    ["scenarios", "overview", "outcomes"],
    ["patients", "analytics", "patients"],
    ["resources", "analytics", "patients"],
    ["compare", "comparison", "outcomes"],
    ["replay", "replay", "outcomes"],
    ["bad-link", "overview", "outcomes"],
  ])("restores the %s shared link", (legacy, page, section) => {
    expect(readNavigation(new URLSearchParams({ view: legacy }))).toEqual({
      page,
      section,
    });
  });

  it("validates the Analysis child and analytics section", () => {
    expect(
      readNavigation(
        new URLSearchParams("view=analysis&analysis=unknown&section=unknown"),
      ),
    ).toEqual({ page: "summary", section: "outcomes" });
    expect(
      readNavigation(
        new URLSearchParams(
          "view=analysis&analysis=analytics&section=resources",
        ),
      ),
    ).toEqual({ page: "analytics", section: "patients" });
  });

  it("changes only navigation keys and roundtrips each destination", () => {
    const source = new URL(
      "https://planner.test/?view=compare&scenario=s1&run=r1&at=2026-10-17T01%3A00%3A00Z&facility=f1&replication=rep1&patient=p1&unit=u1&resource=e1&resource_type=equipment_pool&comparison=c1&grain=week",
    );
    for (const page of [
      "overview",
      "summary",
      "replay",
      "analytics",
      "comparison",
      "data",
    ]) {
      const route = resolvePage(page, "resources");
      const next = writeNavigation(source, route);
      expect(readNavigation(next.searchParams)).toEqual({
        ...route,
        section: page === "analytics" ? "patients" : "outcomes",
      });
      for (const [key, value] of source.searchParams)
        if (key !== "view") expect(next.searchParams.get(key)).toBe(value);
      expect(source.searchParams.get("view")).toBe("compare");
    }
  });
});
