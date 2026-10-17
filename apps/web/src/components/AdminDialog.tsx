import { NativeSelect } from "@mantine/core";
import { useEffect, useState } from "react";
import { Plus, Save, ShieldCheck, Users } from "lucide-react";
import type { Entity, PlanningContext } from "../types";
import type { MemberCreate } from "../api-contracts";
import { createMember as createWorkspaceMember } from "../commands";
import { api, ApiError, items, localDate, patch, post } from "../api";
import { Badge, Button, Busy, ErrorBox, Modal } from "./ui";

function message(error: unknown) {
  return error instanceof ApiError
    ? `${error.message}${error.details.length ? ": " + error.details.map((d) => `${d.field || ""} ${d.message || ""}`).join("; ") : ""}`
    : error instanceof Error
      ? error.message
      : String(error);
}

export default function AdminDialog({
  ctx,
  user,
  onClose,
}: {
  ctx: PlanningContext;
  user: Entity | null;
  onClose: () => void;
}) {
  const [members, setMembers] = useState<Entity[]>([]),
    [settings, setSettings] = useState<Entity | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false),
    [tab, setTab] = useState<"members" | "settings" | "audit" | "metrics">(
      "members",
    );
  const [name, setName] = useState(""),
    [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [role, setRole] = useState<NonNullable<MemberCreate["role"]>>("viewer"),
    [queueLimit, setQueueLimit] = useState(20),
    [runBudget, setRunBudget] = useState(40000000),
    [comparisonBudget, setComparisonBudget] = useState(80000000);
  const [auditRows, setAuditRows] = useState<Entity[]>([]),
    [auditCursor, setAuditCursor] = useState<string | null>(null),
    [auditTotal, setAuditTotal] = useState(0),
    [auditLoading, setAuditLoading] = useState(false);
  const [retention, setRetention] = useState({
      unselected_trace_days: 30,
      failed_import_days: 7,
      export_days: 7,
    }),
    [cleanup, setCleanup] = useState<Entity | null>(null),
    [metrics, setMetrics] = useState<Entity | null>(null);
  const workspace = user?.workspace_id || "workspace-main",
    administrator = user?.role === "admin";
  useEffect(() => {
    let ignore = false;
    if (!administrator) {
      setLoading(false);
      return;
    }
    Promise.all([
      api(`/workspaces/${workspace}/members`),
      api(`/workspaces/${workspace}/settings`),
    ])
      .then(([people, config]) => {
        if (ignore) return;
        setMembers(items(people));
        setSettings(config);
        setQueueLimit(config.max_queued_runs);
        setRetention(
          config.retention_policy || {
            unselected_trace_days: 30,
            failed_import_days: 7,
            export_days: 7,
          },
        );
        setRunBudget(config.max_run_trajectories ?? 40000000);
        setComparisonBudget(config.max_comparison_trajectories ?? 80000000);
      })
      .catch((e) => {
        if (!ignore) setError(message(e));
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, [administrator, workspace]);
  useEffect(() => {
    if (tab !== "audit" || !administrator) return;
    let ignore = false;
    setAuditLoading(true);
    api("/audit-events?limit=50")
      .then((result) => {
        if (!ignore) {
          setAuditRows(items(result));
          setAuditCursor(result.next_cursor);
          setAuditTotal(result.total);
        }
      })
      .catch((e) => {
        if (!ignore) setError(message(e));
      })
      .finally(() => {
        if (!ignore) setAuditLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, [tab, administrator]);
  useEffect(() => {
    if (tab !== "metrics" || !administrator) return;
    let ignore = false;
    api(`/workspaces/${workspace}/execution-metrics`)
      .then((value) => {
        if (!ignore) setMetrics(value);
      })
      .catch((e) => {
        if (!ignore) setError(message(e));
      });
    return () => {
      ignore = true;
    };
  }, [tab, administrator, workspace]);
  async function cleanArtifacts(apply = false) {
    setSaving(true);
    setError("");
    try {
      const result = await post(`/workspaces/${workspace}/retention`, {
        apply,
        limit: 100,
      });
      setCleanup(result);
      if (apply)
        ctx.notify(
          "Retention cleanup completed; preserved history remains available.",
        );
    } catch (e) {
      setError(message(e));
    } finally {
      setSaving(false);
    }
  }
  async function loadAudit() {
    if (!auditCursor) return;
    setAuditLoading(true);
    try {
      const result = await api(
        `/audit-events?limit=50&cursor=${encodeURIComponent(auditCursor)}`,
      );
      setAuditRows((rows) => [
        ...rows,
        ...items(result).filter(
          (entry) => !rows.some((row) => row.id === entry.id),
        ),
      ]);
      setAuditCursor(result.next_cursor);
      setAuditTotal(result.total);
    } catch (e) {
      setError(message(e));
    } finally {
      setAuditLoading(false);
    }
  }
  async function createMember() {
    setSaving(true);
    setError("");
    try {
      const member = await createWorkspaceMember(workspace, {
        name,
        username,
        role,
        password,
      });
      setMembers((v) => [...v, member]);
      setName("");
      setUsername("");
      setPassword("");
      ctx.notify(
        "Workspace member created. Credentials are shared through your own secure process.",
      );
    } catch (e) {
      setError(message(e));
    } finally {
      setSaving(false);
    }
  }
  async function changeMember(member: Entity, change: Entity) {
    setSaving(true);
    setError("");
    try {
      const updated = await patch(
        `/workspaces/${workspace}/members/${member.id}`,
        change,
        member.revision,
      );
      setMembers((v) => v.map((x) => (x.id === member.id ? updated : x)));
      ctx.notify("Member access updated; existing sessions were revoked.");
    } catch (e) {
      setError(message(e));
    } finally {
      setSaving(false);
    }
  }
  async function saveSettings() {
    if (!settings) return;
    setSaving(true);
    setError("");
    try {
      const updated = await patch(
        `/workspaces/${workspace}/settings`,
        {
          max_queued_runs: queueLimit,
          retention_policy: retention,
          max_run_trajectories: runBudget,
          max_comparison_trajectories: comparisonBudget,
        },
        settings.revision,
      );
      setSettings(updated);
      ctx.notify("Workspace policy saved.");
    } catch (e) {
      setError(message(e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal title="Workspace administration" wide onClose={onClose}>
      <div className="form-stack">
        <div className="info-note">
          <ShieldCheck size={18} /> Access roles are enforced by the server.
          Changing a member’s role or password ends their existing sessions.
        </div>
        {error ? <ErrorBox error={error} /> : null}
        {!administrator ? (
          <p>
            Your {user?.role || "current"} role can view the workspace. An
            administrator manages membership and workspace policies.
          </p>
        ) : loading ? (
          <Busy label="Loading workspace policies" />
        ) : (
          <>
            <div className="segmented" aria-label="Administration section">
              <button
                onClick={() => setTab("members")}
                className={tab === "members" ? "active" : ""}
              >
                <Users size={14} /> Members
              </button>
              <button
                onClick={() => setTab("settings")}
                className={tab === "settings" ? "active" : ""}
              >
                Execution & retention
              </button>
              <button
                onClick={() => setTab("audit")}
                className={tab === "audit" ? "active" : ""}
              >
                Audit history
              </button>
              <button
                onClick={() => setTab("metrics")}
                className={tab === "metrics" ? "active" : ""}
              >
                Execution metrics
              </button>
            </div>
            {tab === "members" ? (
              <>
                <div className="table-scroll">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Member</th>
                        <th>Role</th>
                        <th>Access</th>
                      </tr>
                    </thead>
                    <tbody>
                      {members.map((member) => (
                        <tr key={member.id}>
                          <td>
                            <strong>{member.name}</strong>
                            <br />
                            <span className="muted">{member.username}</span>
                          </td>
                          <td>
                            {member.environment_managed ? (
                              <Badge>Administrator · deployment</Badge>
                            ) : (
                              <NativeSelect
                                aria-label={`Role for ${member.name}`}
                                value={member.role}
                                disabled={saving}
                                onChange={(e) =>
                                  changeMember(member, { role: e.target.value })
                                }
                              >
                                <option value="viewer">Viewer</option>
                                <option value="planner">Planner</option>
                                <option value="admin">Administrator</option>
                              </NativeSelect>
                            )}
                          </td>
                          <td>
                            {member.environment_managed ? (
                              <span className="muted">
                                Managed in deployment settings
                              </span>
                            ) : (
                              <Button
                                small
                                disabled={saving}
                                onClick={() =>
                                  changeMember(member, {
                                    enabled: !member.enabled,
                                  })
                                }
                              >
                                {member.enabled
                                  ? "Disable access"
                                  : "Enable access"}
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <form
                  className="form-stack"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void createMember();
                  }}
                >
                  <h3>Add a workspace member</h3>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(2,minmax(0,1fr))",
                      gap: 12,
                    }}
                  >
                    <label>
                      Display name
                      <input
                        required
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        autoComplete="off"
                      />
                    </label>
                    <label>
                      Sign-in username
                      <input
                        required
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        autoComplete="off"
                      />
                    </label>
                    <label>
                      Role
                      <NativeSelect aria-label="Role"
                        value={role}
                        onChange={(e) =>
                          setRole(
                            e.target.value as NonNullable<MemberCreate["role"]>,
                          )
                        }
                      >
                        <option value="viewer">
                          Viewer · inspect and export
                        </option>
                        <option value="planner">
                          Planner · edit and simulate
                        </option>
                        <option value="admin">
                          Administrator · manage access
                        </option>
                      </NativeSelect>
                    </label>
                    <label>
                      Initial password
                      <input
                        type="password"
                        minLength={16}
                        required
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete="new-password"
                      />
                      <small className="muted">
                        At least 16 characters. The password is stored as a
                        salted hash.
                      </small>
                    </label>
                  </div>
                  <Button primary type="submit" disabled={saving}>
                    <Plus size={15} />
                    {saving ? "Saving…" : "Create member"}
                  </Button>
                </form>
              </>
            ) : tab === "audit" ? (
              <>
                <p className="muted">
                  {auditTotal} workspace events. Changes, runs, exports and
                  access administration retain their actor and source entity.
                </p>
                <div className="table-scroll">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Actor</th>
                        <th>Action / entity</th>
                      </tr>
                    </thead>
                    <tbody>
                      {auditRows.map((entry) => (
                        <tr key={entry.id}>
                          <td>
                            {localDate(entry.created_at, {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                              second: "2-digit",
                            })}
                          </td>
                          <td className="mono">{entry.user_id}</td>
                          <td>
                            <strong>{entry.action}</strong>
                            <br />
                            <span className="mono muted">
                              {entry.entity_id}
                            </span>
                            {Object.keys(entry.details || {}).length ? (
                              <details>
                                <summary>Details</summary>
                                <pre style={{ whiteSpace: "pre-wrap" }}>
                                  {JSON.stringify(entry.details, null, 2)}
                                </pre>
                              </details>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {auditLoading ? (
                  <Busy label="Loading audit records" />
                ) : auditCursor ? (
                  <Button onClick={loadAudit}>Load next 50 events</Button>
                ) : (
                  <p className="muted">All available events loaded.</p>
                )}
              </>
            ) : tab === "metrics" ? (
              <>
                {metrics ? (
                  <>
                    <p className="small-copy muted">{metrics.scope}</p>
                    <div className="table-scroll">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>Job kind</th>
                            <th>Status</th>
                            <th>Count</th>
                          </tr>
                        </thead>
                        <tbody>
                          {metrics.jobs.map((row: Entity) => (
                            <tr key={`${row.kind}-${row.status}`}>
                              <td>{row.kind}</td>
                              <td>{row.status}</td>
                              <td>{row.count}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <h3>HTTP requests in this API process</h3>
                    <div className="table-scroll">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>Route</th>
                            <th>Status / requests</th>
                            <th>Mean / maximum ms</th>
                          </tr>
                        </thead>
                        <tbody>
                          {metrics.request_process.requests.map(
                            (row: Entity, i: number) => (
                              <tr key={i}>
                                <td>
                                  {row.method} {row.route_template}
                                </td>
                                <td>
                                  {row.status_code} · {row.request_count}
                                </td>
                                <td>
                                  {row.duration_ms_mean} / {row.duration_ms_max}
                                </td>
                              </tr>
                            ),
                          )}
                        </tbody>
                      </table>
                    </div>
                    <h3>Recent execution timings</h3>
                    {metrics.recent_jobs.slice(0, 20).map((row: Entity) => (
                      <details key={row.id}>
                        <summary>
                          {row.kind} · {row.status} · {row.id}
                        </summary>
                        <pre style={{ whiteSpace: "pre-wrap" }}>
                          {JSON.stringify(
                            row.execution_metrics || {
                              status:
                                "Execution timing not recorded for this older job",
                            },
                            null,
                            2,
                          )}
                        </pre>
                      </details>
                    ))}
                  </>
                ) : (
                  <Busy label="Loading execution metrics" />
                )}
              </>
            ) : (
              <form
                className="form-stack"
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveSettings();
                }}
              >
                <h3>Execution limits</h3>
                <label>
                  Maximum active workspace jobs
                  <input
                    type="number"
                    min={1}
                    max={3650}
                    value={queueLimit}
                    onChange={(e) => setQueueLimit(+e.target.value)}
                    required
                  />
                </label>
                <p className="muted">
                  New simulations are rejected when this limit is reached.
                  Completed history remains available.
                </p>
                <div className="two-fields">
                  <label>
                    Expected trajectories per run
                    <input
                      type="number"
                      min={1}
                      max={1000000000}
                      value={runBudget}
                      onChange={(e) => setRunBudget(+e.target.value)}
                      required
                    />
                  </label>
                  <label>
                    Expected trajectories per comparison
                    <input
                      type="number"
                      min={1}
                      max={1000000000}
                      value={comparisonBudget}
                      onChange={(e) => setComparisonBudget(+e.target.value)}
                      required
                    />
                  </label>
                </div>
                <p className="muted">
                  The server integrates the declared demand schedule and
                  reports, including current census, before accepting a job.
                  Over-budget work is rejected with its estimate.
                </p>
                <h3>Regenerable artifact retention</h3>
                <div className="three-fields">
                  {[
                    ["unselected_trace_days", "Unselected traces"],
                    ["failed_import_days", "Failed upload files"],
                    ["export_days", "Export downloads"],
                  ].map(([field, label]) => (
                    <label key={field}>
                      {label} (days)
                      <input
                        required
                        type="number"
                        min={1}
                        max={3650}
                        value={retention[field as keyof typeof retention]}
                        onChange={(e) =>
                          setRetention((current) => ({
                            ...current,
                            [field]: +e.target.value,
                          }))
                        }
                      />
                    </label>
                  ))}
                </div>
                <p className="muted">
                  Daily bounded cleanup expires these artifacts. Original
                  datasets, saved scenario revisions, run inputs, aggregate
                  results and representative traces remain preserved. Expired
                  exports and other traces can be regenerated.
                </p>
                <Button primary type="submit" disabled={saving}>
                  <Save size={15} />
                  Save workspace policy
                </Button>
                <div className="constraint-callout">
                  <h3>Inspect eligible cleanup</h3>
                  <p className="small-copy">
                    Uses the saved retention policy and examines at most 100
                    eligible records.
                  </p>
                  <Button
                    type="button"
                    disabled={saving}
                    onClick={() => cleanArtifacts(false)}
                  >
                    Preview cleanup
                  </Button>
                  {cleanup ? (
                    <>
                      <p>
                        {cleanup.eligible_count} eligible records ·{" "}
                        {cleanup.byte_size.toLocaleString()} stored bytes ·{" "}
                        {cleanup.dry_run ? "preview only" : "cleanup applied"}
                      </p>
                      {cleanup.items.map((item: Entity) => (
                        <p className="small-copy" key={item.id}>
                          {item.kind} · {item.id} · {item.status}
                        </p>
                      ))}
                      {cleanup.dry_run && cleanup.eligible_count > 0 ? (
                        <Button
                          type="button"
                          disabled={saving}
                          onClick={() => cleanArtifacts(true)}
                        >
                          Expire eligible artifacts
                        </Button>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </form>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
