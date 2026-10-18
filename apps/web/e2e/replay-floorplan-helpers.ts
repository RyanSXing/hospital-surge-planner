import { expect, type Page } from "@playwright/test";
import { api } from "./helpers";

/** Verify the architectural routes against rendered rooms, including resized run inventories. */
export async function expectHospitalFlowGeometry(page: Page) {
  await expect(page.getByTestId("hospital-footprint-outline")).toHaveAttribute(
    "d",
    /^M/,
  );
  const geometry = await page
    .locator(".floor-plan-building")
    .evaluate((node) => {
      const bounds = node.getBoundingClientRect(),
        scale = bounds.width / (node as HTMLElement).offsetWidth;
      const box = (element: Element) => {
        const r = element.getBoundingClientRect();
        return {
          x: (r.left - bounds.left) / scale,
          y: (r.top - bounds.top) / scale,
          width: r.width / scale,
          height: r.height / scale,
        };
      };
      const footprint = [...node.querySelectorAll("[data-footprint]")].map(box);
      const rooms = [
        ...node.querySelectorAll<HTMLElement>(".floor-plan-unit"),
      ].map((room) => ({
        ...box(room),
        id: room.dataset.unitId,
        kind: room.dataset.unitKind,
      }));
      const svg = node.querySelector<SVGElement>(
        '[data-testid="hospital-footprint"]',
      )!;
      const nodes = JSON.parse(svg.dataset.corridorNodes || "{}") as Record<
        string,
        { x: number; y: number }
      >;
      const edges = [
        ...svg.querySelectorAll<SVGElement>("[data-corridor-edge]"),
      ].map((edge) => edge.dataset.corridorEdge!.split("|"));
      const route = (from: string, to: string) => {
        const queue = [[from]],
          seen = new Set<string>();
        while (queue.length) {
          const path = queue.shift()!,
            current = path.at(-1)!;
          if (current === to) return path;
          if (seen.has(current)) continue;
          seen.add(current);
          for (const [a, b] of edges) {
            const next = a === current ? b : b === current ? a : null;
            if (next && !seen.has(next)) queue.push([...path, next]);
          }
        }
        return [];
      };
      const violations: string[] = [];
      for (const [from, to] of edges) {
        const a = nodes[from],
          b = nodes[to];
        if (Math.abs(a.x - b.x) > 0.02 && Math.abs(a.y - b.y) > 0.02)
          violations.push(`diagonal:${from}|${to}`);
        for (let i = 0; i <= 30; i++) {
          const x = a.x + ((b.x - a.x) * i) / 30,
            y = a.y + ((b.y - a.y) * i) / 30;
          if (
            !footprint.some(
              (r) =>
                x >= r.x - 0.03 &&
                x <= r.x + r.width + 0.03 &&
                y >= r.y - 0.03 &&
                y <= r.y + r.height + 0.03,
            )
          )
            violations.push(`outside:${from}|${to}`);
          if (
            rooms.some(
              (r) =>
                x > r.x + 0.03 &&
                x < r.x + r.width - 0.03 &&
                y > r.y + 0.03 &&
                y < r.y + r.height - 0.03,
            )
          )
            violations.push(`wall:${from}|${to}`);
        }
      }
      const outline = svg
        .querySelector(".floor-plan-outline")!
        .getAttribute("d")!;
      return {
        nodes,
        edges,
        rooms,
        violations,
        wardRoute: route(
          "entrance",
          rooms.find((room) => room.kind === "ward")!.id!,
        ),
        edRoute: route(
          "entrance",
          rooms.find((room) => room.kind === "ed")!.id!,
        ),
        criticalRoute: route(
          rooms.find((room) => room.kind === "ed")!.id!,
          rooms.find((room) => room.kind === "icu")!.id!,
        ),
        dischargeRoute: route(
          rooms.find((room) => room.kind === "ed")!.id!,
          "discharge",
        ),
        outlinePaths: (outline.match(/M/g) || []).length,
        outlineXCoordinates: new Set(
          [...outline.matchAll(/[ML]([\d.]+),([\d.]+)/g)].map(
            (point) => point[1],
          ),
        ).size,
        mapHeight: bounds.height,
      };
    });
  expect(geometry.violations).toEqual([]);
  expect(geometry.outlinePaths).toBe(1);
  expect(geometry.outlineXCoordinates).toBeGreaterThan(4);
  const { nodes, wardRoute, edRoute, criticalRoute, dischargeRoute } = geometry;
  expect(nodes.entrance.y).toBeGreaterThan(nodes["ed-waiting"].y);
  expect(nodes["ed-waiting"].y).toBeGreaterThan(nodes["bed-waiting"].y);
  expect(nodes["bed-waiting"].y).toBeGreaterThan(nodes["junction:wards"].y);
  expect(wardRoute.indexOf("ed-waiting")).toBeLessThan(
    wardRoute.indexOf("bed-waiting"),
  );
  expect(wardRoute.indexOf("bed-waiting")).toBeLessThan(
    wardRoute.indexOf("junction:wards"),
  );
  expect(edRoute).toContain("ed-waiting");
  expect(edRoute).not.toContain("bed-waiting");
  expect(criticalRoute).toContain("bed-waiting");
  expect(dischargeRoute).toContain("junction:exit");
  expect(dischargeRoute).not.toContain("entrance");
  expect(dischargeRoute).not.toContain("bed-waiting");
  expect(nodes.discharge.x).toBeGreaterThan(nodes["ed-waiting"].x);
  return geometry;
}

export async function seekFloorPlan(page: Page, run: any, minutes: number) {
  const at = new Date(Date.parse(run.start_at) + minutes * 60000).toISOString();
  await page
    .getByLabel("Replay timestamp across actual elapsed horizon")
    .evaluate((node, value) => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(node, String(value));
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
    }, minutes);
  await expect
    .poll(() => Date.parse(new URL(page.url()).searchParams.get("at") || ""))
    .toBe(Date.parse(at));
  await expectFloorPlanAt(page, run.selected_replication_id, at);
  return at;
}

/** Compare the actual DOM against the API's full recorded inventory, not its patient sample. */
export async function expectFloorPlanAt(page: Page, rep: string, at: string) {
  const floor = page.getByTestId("replay-floor-plan");
  await expect
    .poll(async () =>
      Date.parse((await floor.getAttribute("data-recorded-at")) || ""),
    )
    .toBe(Date.parse(at));
  await expect(floor).toHaveAttribute("data-replication-id", rep);
  await expect(floor).toHaveAttribute("data-retaining", "false");
  const state = await api(
    page.request,
    `/runs/${rep}/state?at=${encodeURIComponent(at)}`,
  );
  const actual = await floor.evaluate((element) => ({
    units: [...element.querySelectorAll<HTMLElement>(".floor-plan-unit")].map(
      (unit) => ({
        id: unit.dataset.unitId,
        occupied: unit.dataset.occupied,
        staffed: unit.dataset.staffed,
        available: unit.dataset.available,
        pressure: unit.dataset.pressure,
      }),
    ),
    beds: [...element.querySelectorAll<HTMLElement>(".floor-plan-bed")].map(
      (bed) => ({
        id: bed.dataset.slotId,
        unit: bed.dataset.unitId,
        status: bed.dataset.status,
        patient: bed.dataset.patientId || null,
      }),
    ),
  }));
  const main =
    state.units.find((unit: any) => unit.kind === "ed")?.facility_id ||
    "FAC-MAIN";
  const units = state.units.filter(
    (unit: any) =>
      unit.facility_id === main &&
      ["ward", "icu", "ed", "clinic"].includes(unit.kind),
  );
  expect(actual.units.map((unit) => unit.id).sort()).toEqual(
    units.map((unit: any) => unit.unit_id).sort(),
  );
  for (const unit of units) {
    const shown = actual.units.find((value) => value.id === unit.unit_id)!;
    expect(shown.occupied).toBe(String(unit.occupied ?? "unknown"));
    expect(shown.staffed).toBe(String(unit.staffed ?? "unknown"));
    expect(shown.available).toBe(String(unit.available ?? "unknown"));
    const affected = Object.values(
      state.blocker_counts_by_unit?.[unit.unit_id] || {},
    ).some((count: any) => count > 0);
    if (affected) expect(shown.pressure).toBe("1");
  }
  const ids = new Set(units.map((unit: any) => unit.unit_id));
  const slots = state.slots.filter(
    (slot: any) =>
      ids.has(slot.unit_id) &&
      slot.installation_status !== "removed" &&
      (slot.installation_status !== "planned" ||
        slot.status === "occupied" ||
        slot.patient_id ||
        slot.background_occupied === true),
  );
  expect(actual.beds).toHaveLength(slots.length);
  for (const slot of slots) {
    const bed = actual.beds.find((value) => value.id === slot.slot_id);
    const unit = units.find((value: any) => value.unit_id === slot.unit_id);
    let status = slot.status;
    if (
      slot.status === "occupied" ||
      slot.patient_id ||
      slot.background_occupied
    )
      status = "occupied";
    else if (slot.status === "reserved" || slot.reservation_id)
      status = "reserved";
    else if (slot.status === "cleaning") status = "cleaning";
    else if (slot.installation_status === "planned") status = "planned";
    else if (
      slot.enabled === false ||
      slot.status === "disabled" ||
      unit.active === false ||
      unit.admission_gate === false
    )
      status = "blocked";
    else if (
      slot.staffed === false ||
      (unit.staffed === 0 && unit.qualified_staff_by_role?.rn === 0)
    )
      status = "unstaffed";
    else if (slot.status !== "ready") status = "unknown";
    expect(bed, slot.slot_id).toEqual({
      id: slot.slot_id,
      unit: slot.unit_id,
      status,
      patient: slot.patient_id || null,
    });
  }
  const groups = Array.isArray(state.patient_groups)
    ? state.patient_groups.filter((group: any) => group.facility_id === main)
    : null;
  const edCount =
    state.queue_counts?.[main]?.ed ??
    groups
      ?.filter((group: any) => group.state === "ed_waiting")
      .reduce((sum: number, group: any) => sum + group.count, 0) ??
    "unknown";
  const bedCount =
    state.queue_counts?.[main]?.total ??
    groups
      ?.filter((group: any) => group.admission_pending)
      .reduce((sum: number, group: any) => sum + group.count, 0) ??
    "unknown";
  await expect(page.getByTestId("floor-plan-ed-waiting")).toHaveAttribute(
    "data-count",
    String(edCount),
  );
  await expect(page.getByTestId("floor-plan-bed-waiting")).toHaveAttribute(
    "data-count",
    String(bedCount),
  );
  await expect(page.getByTestId("floor-plan-discharges")).toHaveAttribute(
    "data-count",
    String(state.flow_counts?.[main]?.discharges ?? "unknown"),
  );
  await expect(page.locator("canvas.replay-canvas")).toHaveCount(0);
  return state;
}
