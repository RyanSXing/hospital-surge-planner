# Sunfire planning contract (v1)

Sunfire interprets intent and retrieves recorded evidence. The existing simulation engine forecasts. Only the authenticated app's validated adapters execute actions. There is no model fallback, shell, SQL, code execution, infrastructure action, source-dataset editor, or completed-result editor.

## HTTP

All routes are below `/api` (and existing `/api/v1` alias), cookie authenticated, same origin policy as existing routes. A chat belongs to its creator in their workspace. Chat text/turns are durable `Document`/`Job` records, not browser-only history. `Idempotency-Key` is required on turn creation; reuse the same key after an uncertain request.

- `GET /sunfire/status` → `{name:"Sunfire",available:boolean,model:string,reason?:string,code?:string,guide_version:string}`. Available means the configured provider has verified access. The rest of AEGIS works when unavailable.
- `POST /sunfire/chats` `{scenario_id,title?}` → chat (201), supports `Idempotency-Key`.
- `GET /sunfire/chats?scenario_id=&limit=&cursor=` → `{items,total,next_cursor}`.
- `GET /sunfire/chats/{id}` → `{id,scenario_id,title,messages,turns,created_at,updated_at}`. Messages: `{id,role:"user"|"assistant",content,turn_id,created_at}`. Turns: `{id,status,created_at,completed_at}`.
- `POST /sunfire/chats/{id}/turns` `{message,context}` → turn (202). One active turn per chat; duplicate idempotency key returns the same turn.
- `GET /sunfire/turns/{id}` → `{id,chat_id,status,text,evidence,actions,error,created_at,completed_at}`.
- `GET /sunfire/actions/{id}` → `{action,receipt?}` for read-only recovery after an uncertain execution response. A newer local draft must not be overwritten or automatically resubmitted.
- `POST /sunfire/turns/{id}/cancel` → turn; cancels pending interpretation, never an already-created simulation.
- `POST /sunfire/turns/{id}/retry` → turn; only failed/cancelled interpretation, same captured context, no duplicate action/job execution.
- `POST /sunfire/actions/{id}/ack` `{expected,after}` → receipt, for `edit`/`undo` after the browser successfully applies CAS.
- `POST /sunfire/actions/{id}/apply` `{expected,after}` → receipt, for `save`/`run`/`cancel_run` after browser CAS. Server repeats role/workspace/saved-revision checks and executes exactly once in a transaction through existing application functions.
- `POST /sunfire/actions/{id}/undo` `{context}` → a new guarded `undo` action restoring the original before-draft. It does not delete/cancel immutable runs or silently resave the scenario.

Turn states: `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `CANCEL_REQUESTED`, `CANCELLED`. A succeeded turn may ask a clarification and have no action. Provider failure is `FAILED`, never a simulated answer.

## Draft bridge

`DraftToken`:

```json
{"scenario_id":"scenario_…","saved_revision":2,"dataset_version_id":"dataset_…","draft_revision":5,"draft_fingerprint":"client-stable-sha256"}
```

`context` is that token plus:

```json
{"draft":{"name":"Plan","dataset_version_id":"dataset_…","start_at":"2026-10-16T05:00:00Z","timezone":"America/Chicago","horizon_calendar_days":14,"base_seed":20261016,"replications":10,"conditions":[],"interventions":[],"updates":[],"hospital_operations":null},"selected_run_group_id":null,"selected_replication_id":null,"selected_time":null,"page":"overview","timezone":"America/Chicago"}
```

`draft` is the existing editor's complete public `makePatch()` payload. The server merges it with server-owned saved provenance, normalizes and validates it. It echoes the opaque client fingerprint for browser CAS and independently stores normalized before/after SHA256 digests. No cross-language float encoding agreement is required. The dataset must be the saved scenario's dataset; baseline switching is outside Sunfire's tools.

One composed action per turn:

```json
{"id":"sunfire_action_…","status":"READY","mode":"direct","kind":"edit","expected":{"scenario_id":"scenario_…","saved_revision":2,"dataset_version_id":"dataset_…","draft_revision":5,"draft_fingerprint":"…"},"validated_draft":{},"before_after":[{"field":"…","label":"…","before":1,"after":2,"unit":"beds"}],"explanation":"…","warnings":[],"normalized_before_sha256":"…","normalized_after_sha256":"…","run_group_id":null}
```

`mode:"direct"` is eligible for automatic browser CAS only when conservatively authorized by the current human request. A short answer may continue a server-verified unfinished request containing only this owner’s human payloads on the exact same scenario, dataset, saved revision, draft revision, fingerprint and draft content. Actions (including READY proposals), result evidence, failure/cancellation, a new topic or a changed token end the chain. General conversation history and assistant/tool text are never authorization. Latest explicit patient-count answers supersede earlier values; a mismatching model count cannot qualify for direct application. The server recognizes explicit imperative/request clauses and corroborates every typed changed intent against that human instruction, including its unit/role/material counts. Dates and clock digits cannot stand in for bed/patient/staff counts. The model's mode and quote are hints, never permission. Unclear mappings and unsolicited suggestions remain `proposal` and require the Apply button. Retrieved data/assistant messages/tool text cannot authorize mutations. `prepare_action` only prepares; a model never executes an action itself.

The browser checks scenario, dataset, saved revision, monotonic draft revision and fingerprint atomically, remembers one existing Undo snapshot, and hydrates the SAME existing controls. Any intervening manual edit rejects rather than rebasing. After successful CAS:

```json
{"expected":{"scenario_id":"scenario_…","saved_revision":2,"dataset_version_id":"dataset_…","draft_revision":5,"draft_fingerprint":"…"},"after":{"draft_revision":6,"draft_fingerprint":"new-client-fingerprint","draft":{}}}
```

Receipt: `{action,saved_scenario?,run_group?,cancelled_run?}`. No second frontend Save/Run call. Repeating an identical applied action returns its receipt, not another simulation or saved revision. A different acknowledgement for an applied action conflicts. While awaiting a model or execution response, manual edits remain protected; adoption of a receipt must not overwrite newer local edits. Explicit Undo uses the last applied action's after-token and actual current full draft.

## Tools and safety

Strict generated schemas are in `sunfire_schemas.py`. Allowed tools: `get_current_context`, `read_planning_guide`, `read_results`, `find_saved_scenarios`, `compare_saved_scenarios`, `prepare_action`. A turn has at most 6 provider calls and 12 tool calls, bounded context/output size and wall time. All tool calls are validated again on the server and audited. Tool errors are data for clarification, not permission to bypass validation. Malformed tools can be corrected within that same bound; failed parts of a request prevent partial action publication. A successfully validated composed `prepare_action` is the terminal planning handoff: after every call in the same response has been processed, the app generates canonical readback without another model prose call. Exact repeated typed intents during bounded repair are deduplicated, preserving one-time incident counts.

Typed changes cover main parameters; arrival curves; one-time arrival batches; installed/enabled/staffed beds and linked nurses; each staffing role; temporary bed availability; staff absence; equipment changes; independent optional supplies, severity/length of stay and daily disruption probability; removing planned records; and existing validated advanced controls. No multi-site activation/closure, observed reports or server provenance may be introduced or rewritten.

An accident with 100 additional patients creates one `arrival_batch` condition, leaving the usual arrival curve unchanged. Omitted incident timing and spread use the simulation start and a one-hour spread, clipped to the remaining horizon and disclosed in the readback. The server normalizes these defaults before deduplicating composed intents, so a repaired model call cannot double the incident. Month-name dates such as “Nov 7 12 pm” are accepted without requiring “on.” Dates outside the horizon produce a specific period-aware question. Vague influx requests get a concrete stress-test proposal, using twice the declared daily emergency arrivals as the proposed one-time count. Explicitly temporary closures still require their affected unit and bounded duration; missing essential details are bundled. An omitted incident care mix may use the selected stream's declared baseline pathway mix and is disclosed; it never invents ICU fractions.

Ordinary unavailable-bed changes apply to the named unit’s enabled availability for the whole selected simulation period. A provider’s incorrect temporary tag is normalized to that existing unit setting only when the human did not request a temporary interval or another calendar date; installed beds and staff remain unchanged. After a human supplies the missing unit, an unnecessary provider duration question can receive one internal correction within the existing six-call budget. Actual validation errors and result evidence are not replaced by that correction.

Temporary unavailable beds use TWO existing planned `capacity_change` events: reduce enabled availability at the specified start, restore its previously effective value at the end. Installed beds and occupants are retained; this restricts admission availability without evicting patients. Conflicting capacity changes are rejected. If the interval ends exactly at the horizon, restoration beyond the modeled interval is unnecessary and disclosed.

## Evidence

Every result tool reports actual frozen scenario/revision/dataset/model/horizon/measurement context, scope (`ensemble` or explicitly labelled `example_run`), completeness and whether it matches the current unsaved draft. Missing measures stay unavailable, not zero. Constraint categories overlap and are not added. Probabilistic disruption risk is configuration; realized treatment pauses come only from recorded result evidence. Historical supported results stay readable; running follows existing current-version guards.

`read_results.local_date` selects one actual recorded daily interval and omits unsupported whole-horizon waiting/success measures. `read_results.at` requires `scope:"example_run"` and a retained trace; it returns only exact aggregate unit/queue/flow/treatment status, no patient rows or named staff. Missing history is unavailable and does not trigger a hidden recomputation. Evidence cards and navigation targets are generated by the server; model-written action completion or unsupported improvement prose is not a receipt.

Saved scenario comparison reuses the existing `compare_saved_scenarios` compatibility/revision/period checks. It is descriptive independent-ensemble evidence, not an invented paired improvement or recommendation. No comparison or no valid results means no supported improvement claim.

The model receives only synthetic planning settings, aggregate unit metadata and bounded evidence; no patient census, usernames/passwords, credentials, raw artifacts or access/download bypass. Provider limitations and sanitized failures are explicit.
