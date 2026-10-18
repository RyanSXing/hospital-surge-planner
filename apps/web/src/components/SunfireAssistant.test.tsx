import { MantineProvider } from "@mantine/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActionCard, EvidenceCard } from "./SunfireAssistant";
import type { SunfireAction, SunfireExecution } from "./sunfireTypes";

const action: SunfireAction = {
  id: "action-1",
  status: "READY",
  mode: "proposal",
  kind: "edit",
  expected: {
    scenario_id: "S",
    saved_revision: 1,
    dataset_version_id: "D",
    draft_revision: 3,
    draft_fingerprint: "hash",
  },
  validated_draft: { replications: 2 },
  before_after: [
    {
      field: "rn",
      label: "Ward A nurses per shift",
      before: 4,
      after: 6,
      unit: "nurses",
    },
  ],
  explanation: "More qualified nurses would support these beds.",
  warnings: [],
};
const renderAction = (
  value = action,
  execution?: SunfireExecution,
  canWrite = true,
) =>
  renderToStaticMarkup(
    <MantineProvider>
      <ActionCard
        action={value}
        execution={execution}
        canWrite={canWrite}
        onApply={() => {}}
        onUndo={() => {}}
        timezone="America/Chicago"
      />
    </MantineProvider>,
  );

describe("truthful conversational planning readbacks", () => {
  it("keeps a suggestion proposed and uses friendly before/after labels", () => {
    const html = renderAction();
    expect(html).toContain("Suggested changes");
    expect(html).toContain("Apply changes");
    expect(html).toContain("Ward A nurses per shift");
    expect(html).toContain("4 nurses");
    expect(html).toContain("6 nurses");
    expect(html).not.toContain("Changes applied");
    expect(html).not.toContain("staff_counts");
    expect(renderAction(action, undefined, false)).toContain("disabled");
  });
  it("does not claim a save or queued simulation before a real receipt", () => {
    const pending = renderAction(
      { ...action, kind: "run", mode: "direct" },
      {
        status: "confirming",
        body: {
          expected: action.expected,
          after: { draft_revision: 4, draft_fingerprint: "next", draft: {} },
        },
      },
    );
    expect(pending).toContain("Draft updated · confirmation pending");
    expect(pending).not.toContain("Simulation submitted");
    const applied = renderAction({ ...action, kind: "run", status: "APPLIED" });
    expect(applied).toContain("Simulation submitted");
  });
  it("offers Undo only for an actual configuration change, never a no-op save or run", () => {
    for (const kind of ["save", "run"] as const) {
      expect(
        renderAction({ ...action, kind, status: "APPLIED", before_after: [] }),
      ).not.toContain("Undo changes");
      // The normalized draft evidence takes precedence over supporting rows.
      expect(
        renderAction({
          ...action,
          kind,
          status: "APPLIED",
          normalized_before_sha256: "same",
          normalized_after_sha256: "same",
        }),
      ).not.toContain("Undo changes");
    }
    expect(renderAction({ ...action, status: "APPLIED" })).toContain(
      "Undo changes",
    );
    expect(
      renderAction({
        ...action,
        status: "APPLIED",
        before_after: [],
        normalized_before_sha256: "before",
        normalized_after_sha256: "after",
      }),
    ).toContain("Undo changes");
    expect(
      renderAction({
        ...action,
        status: "APPLIED",
        before_after: [
          {
            field: "same",
            label: "Same settings",
            before: { a: 1, b: 2 },
            after: { b: 2, a: 1 },
          },
        ],
      }),
    ).not.toContain("Undo changes");
  });
  it("renders missing evidence as unavailable and refuses model-provided arbitrary navigation", () => {
    const html = renderToStaticMarkup(
      <EvidenceCard
        evidence={{
          title: "Recorded results",
          scope: "ensemble",
          context: { matches_current_draft: false },
          values: [{ label: "Admission wait", value: null, unit: "hours" }],
          links: [
            { kind: "run", label: "View summary", run_group_id: "run_1" },
            {
              kind: "url",
              label: "Unsafe external action",
              url: "javascript:alert(1)",
            } as any,
          ],
        }}
        onNavigate={() => {}}
      />,
    );
    expect(html).toContain("Unavailable");
    expect(html).toContain("different configuration");
    expect(html).toContain("View summary");
    expect(html).not.toContain("Unsafe external action");
    expect(html).not.toContain("javascript:");
  });
  it("escapes retrieved content instead of rendering provider HTML", () => {
    const html = renderToStaticMarkup(
      <EvidenceCard
        evidence={{
          title: "Evidence",
          summary: '<img src=x onerror="alert(1)">',
          links: [],
        }}
        onNavigate={() => {}}
      />,
    );
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
  });
});
