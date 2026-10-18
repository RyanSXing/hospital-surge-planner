import type { PageId } from "./types";

export type AnalysisPage = "summary" | "replay" | "analytics" | "comparison";
export type WorkspacePage = "overview" | AnalysisPage | "data";
export type AnalyticsSection = "outcomes" | "patients";
export type WorkspaceRoute = {
  page: WorkspacePage;
  section: AnalyticsSection;
};

export const analysisPages: AnalysisPage[] = [
  "summary",
  "replay",
  "analytics",
  "comparison",
];

export function isAnalysisPage(page: string): page is AnalysisPage {
  return analysisPages.includes(page as AnalysisPage);
}

/** Keep shared links and entity drilldowns from earlier releases usable. */
export function resolvePage(
  page: string | null,
  section?: string | null,
): WorkspaceRoute {
  const selectedSection =
    section === "resources" || section === "patients" ? "patients" : "outcomes";
  switch (page) {
    case "patients":
      return { page: "analytics", section: "patients" };
    case "resources":
      return { page: "analytics", section: "patients" };
    case "compare":
      return { page: "comparison", section: selectedSection };
    case "configuration":
    case "parameters":
    case "scenarios":
      return { page: "overview", section: selectedSection };
    case "summary":
    case "replay":
    case "analytics":
    case "comparison":
    case "data":
      return { page, section: selectedSection };
    default:
      return { page: "overview", section: selectedSection };
  }
}

export function readNavigation(params: URLSearchParams): WorkspaceRoute {
  if (params.get("view") === "analysis") {
    const child = params.get("analysis");
    return resolvePage(
      isAnalysisPage(child || "") ? child : "summary",
      params.get("section"),
    );
  }
  return resolvePage(params.get("view"), params.get("section"));
}

/** Change only navigation keys; scenario, run, time and entity keys are retained. */
export function writeNavigation(url: URL, route: WorkspaceRoute): URL {
  const next = new URL(url);
  if (isAnalysisPage(route.page)) {
    next.searchParams.set("view", "analysis");
    next.searchParams.set("analysis", route.page);
  } else {
    next.searchParams.set("view", route.page);
    next.searchParams.delete("analysis");
  }
  if (route.page === "analytics")
    next.searchParams.set("section", route.section);
  else next.searchParams.delete("section");
  return next;
}

export function destination(
  page: PageId,
  section: AnalyticsSection,
): WorkspaceRoute {
  return resolvePage(page, section);
}
