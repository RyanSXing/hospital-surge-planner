import { useEffect, useState } from "react";
import { Bell, Check, Edit3, Plus, Save, ShieldCheck } from "lucide-react";
import type { Entity, PlanningContext } from "../types";
import { api, fmt, items, localDate, patch, post } from "../api";
import { Badge, Button, Busy, ErrorBox, Modal } from "./ui";
const metrics: Record<string, [string, string]> = {
  peak_inpatient_queue: ["Peak inpatient queue", "patients"],
  inpatient_waiting_patient_hours: [
    "Inpatient waiting burden",
    "patient-hours",
  ],
  ed_waiting_patient_hours: ["ED assessment waiting", "patient-hours"],
  ward_utilization: ["Average ward utilization", "ratio"],
  icu_utilization: ["Average ICU utilization", "ratio"],
  peak_staffed_utilization: ["Peak staffing-supported utilization", "ratio"],
  capacity_shortfall_hours: ["Capacity shortfall duration", "hours"],
  arrivals: ["Arrivals", "patients"],
  discharges: ["Discharges", "patients"],
};
const defaults = {
  name: "Inpatient queue threshold",
  metric: "peak_inpatient_queue",
  scope_filters: { facility_id: "FAC-MAIN" },
  statistic: "p50",
  grain: "day",
  operator: "gt",
  threshold: 0,
  unit: "patients",
  consecutive_buckets: 1,
  severity: "warning",
  enabled: true,
};
export default function AlertsDialog({
  ctx,
  onClose,
}: {
  ctx: PlanningContext;
  onClose: () => void;
}) {
  const [tab, setTab] = useState("alerts"),
    [alerts, setAlerts] = useState<Entity[]>([]),
    [rules, setRules] = useState<Entity[]>([]),
    [edit, setEdit] = useState<Entity | null>(null),
    [form, setForm] = useState<Entity>(defaults),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  async function load() {
    setLoading(true);
    setError("");
    try {
      const [a, r] = await Promise.all([
        api(
          `/alerts${ctx.run ? `?run_group_id=${ctx.run.id}&replication_id=${ctx.activeReplicationId || ctx.run.selected_replication_id || ""}` : ""}`,
        ),
        api("/alert-rules"),
      ]);
      setAlerts(items(a));
      setRules(items(r));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, [ctx.run?.id, ctx.activeReplicationId]);
  function update(field: string, value: any) {
    setForm((v) => ({ ...v, [field]: value }));
  }
  async function save() {
    setError("");
    await ctx.action("Saving planning alert rule", async () => {
      try {
        const value = { ...form, unit: metrics[form.metric]?.[1] };
        if (edit) await patch(`/alert-rules/${edit.id}`, value, edit.revision);
        else await post("/alert-rules", value);
        setEdit(null);
        setTab("rules");
        await load();
        ctx.notify("Planning rule saved with its revision history.");
      } catch (e) {
        setError((e as Error).message);
        throw e;
      }
    });
  }
  return (
    <Modal title="Planning alerts & rules" wide onClose={onClose}>
      <div className="form-stack">
        <div className="segmented">
          <button
            className={tab === "alerts" ? "active" : ""}
            onClick={() => setTab("alerts")}
          >
            Threshold crossings
          </button>
          <button
            className={tab === "rules" ? "active" : ""}
            onClick={() => setTab("rules")}
          >
            Manage rules
          </button>
          <button
            className={tab === "edit" ? "active" : ""}
            disabled={ctx.canWrite === false}
            onClick={() => {
              setEdit(null);
              setForm(defaults);
              setTab("edit");
            }}
          >
            <Plus size={12} />
            New rule
          </button>
        </div>
        {error ? <ErrorBox error={error} /> : null}
        {loading ? (
          <Busy label="Evaluating result context" />
        ) : tab === "alerts" ? (
          <>
            <p className="muted small-copy">
              Alerts describe computed conditions in a completed result context.
              Acknowledging an alert records review and preserves the forecast.
            </p>
            {alerts.length ? (
              alerts.map((a) => (
                <div className="alert-row" key={a.id}>
                  <Badge
                    tone={
                      a.severity === "critical"
                        ? "danger"
                        : a.severity === "info"
                          ? "neutral"
                          : "warning"
                    }
                  >
                    {a.severity}
                  </Badge>
                  <div>
                    <strong>{metrics[a.metric]?.[0] || a.metric}</strong>
                    <span>
                      {a.local_date || localDate(a.bucket_start)} ·{" "}
                      {fmt(a.value, 2)} {a.unit} · {a.statistic || "p50"}
                    </span>
                    <small className="muted">
                      Threshold {a.operator || ">"} {a.threshold} ·{" "}
                      {a.rule_revision_id || a.rule_id}
                    </small>
                  </div>
                  <Button
                    small
                    onClick={() => {
                      if (a.bucket_start) ctx.setTime(a.bucket_start);
                      ctx.setFacility(
                        a.scope_filters?.facility_id || "FAC-MAIN",
                      );
                      ctx.setPage("summary");
                      onClose();
                    }}
                  >
                    Inspect
                  </Button>
                  <Button
                    small
                    disabled={
                      ctx.canWrite === false ||
                      a.acknowledged ||
                      !!a.acknowledged_at
                    }
                    onClick={() =>
                      ctx.action("Acknowledging planning alert", async () => {
                        await post(`/alerts/${a.id}/acknowledge`);
                        setAlerts((v) =>
                          v.map((x) =>
                            x.id === a.id ? { ...x, acknowledged: true } : x,
                          ),
                        );
                      })
                    }
                  >
                    {a.acknowledged || a.acknowledged_at
                      ? "Reviewed"
                      : "Acknowledge"}
                  </Button>
                </div>
              ))
            ) : (
              <div className="empty-alerts">
                <ShieldCheck size={30} />
                <h3>No threshold crossings in this result context</h3>
                <p>Review configured rules or complete a simulation.</p>
              </div>
            )}
          </>
        ) : tab === "rules" ? (
          <>
            <p className="muted small-copy">
              Rules retain the revision used to generate each alert. Display
              colors are separate settings.
            </p>
            {rules.map((r) => (
              <div className="alert-row" key={r.id}>
                <Badge tone={r.enabled ? "success" : "neutral"}>
                  {r.enabled ? "Enabled" : "Disabled"}
                </Badge>
                <div>
                  <strong>{r.name}</strong>
                  <span>
                    {metrics[r.metric]?.[0] || r.metric} · {r.statistic} ·{" "}
                    {r.grain} · {r.operator} {r.threshold} {r.unit}
                  </span>
                  <small className="muted">
                    {r.consecutive_buckets} consecutive intervals · Revision{" "}
                    {r.revision}
                  </small>
                </div>
                <Button
                  small
                  disabled={ctx.canWrite === false}
                  onClick={() => {
                    setEdit(r);
                    setForm({ ...defaults, ...r });
                    setTab("edit");
                  }}
                >
                  <Edit3 size={13} />
                  Edit
                </Button>
                <Button
                  small
                  disabled={ctx.canWrite === false}
                  onClick={() =>
                    ctx.action("Revising alert rule", async () => {
                      await patch(
                        `/alert-rules/${r.id}`,
                        { enabled: !r.enabled },
                        r.revision,
                      );
                      await load();
                    })
                  }
                >
                  {r.enabled ? "Disable" : "Enable"}
                </Button>
              </div>
            ))}
          </>
        ) : (
          <>
            <label>
              Rule name
              <input
                value={form.name}
                onChange={(e) => update("name", e.target.value)}
              />
            </label>
            <div className="two-fields">
              <label>
                Metric
                <select
                  value={form.metric}
                  onChange={(e) => update("metric", e.target.value)}
                >
                  {Object.entries(metrics).map(([id, [name]]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Statistic
                <select
                  value={form.statistic}
                  onChange={(e) => update("statistic", e.target.value)}
                >
                  <option value="p50">Median across runs · P50</option>
                  <option value="p10">P10 across runs</option>
                  <option value="p90">P90 across runs</option>
                  <option value="mean">Mean across runs</option>
                  <option value="selected_replication">
                    Selected simulation run
                  </option>
                </select>
              </label>
              <label>
                Interval
                <select
                  value={form.grain}
                  onChange={(e) => update("grain", e.target.value)}
                >
                  {["day", "week", "month"].map((g) => (
                    <option key={g} value={g}>
                      {g}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Operator
                <select
                  value={form.operator}
                  onChange={(e) => update("operator", e.target.value)}
                >
                  <option value="gt">Greater than</option>
                  <option value="gte">Greater than or equal</option>
                  <option value="lt">Less than</option>
                  <option value="lte">Less than or equal</option>
                </select>
              </label>
              <label>
                Threshold ({metrics[form.metric]?.[1]})
                <input
                  type="number"
                  step="any"
                  value={form.threshold}
                  onChange={(e) => update("threshold", +e.target.value)}
                />
              </label>
              <label>
                Consecutive intervals
                <input
                  type="number"
                  min="1"
                  max="365"
                  value={form.consecutive_buckets}
                  onChange={(e) =>
                    update("consecutive_buckets", +e.target.value)
                  }
                />
              </label>
              <label>
                Severity
                <select
                  value={form.severity}
                  onChange={(e) => update("severity", e.target.value)}
                >
                  <option value="info">Information</option>
                  <option value="warning">Warning</option>
                  <option value="critical">Critical</option>
                </select>
              </label>
              <label>
                Supported scope
                <select value="FAC-MAIN" disabled>
                  <option value="FAC-MAIN">Main hospital</option>
                </select>
              </label>
            </div>
            <div className="info-note">
              Utilization uses a ratio: 1.0 = 100%. Thresholds are editable
              planning settings, rather than validated operational standards.
            </div>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => update("enabled", e.target.checked)}
              />
              Rule enabled
            </label>
            <Button
              primary
              disabled={ctx.canWrite === false || !!ctx.busy}
              onClick={save}
            >
              <Save size={14} />
              {edit ? "Save rule revision" : "Create planning rule"}
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}
