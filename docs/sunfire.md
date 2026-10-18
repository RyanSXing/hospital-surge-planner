# Sunfire planning assistant

Sunfire uses the current AEGIS configuration and recorded results. The existing simulation engine still calculates forecasts. Manual editing, the arrival chart, scenario library, Analysis and Replay remain available independently of the assistant.

Open **Sunfire** from the bottom-right launcher. The compact chat can expand into a right sidebar and return without losing its conversation. The sidebar reserves workspace space. Conversations belong to the signed-in account and selected scenario and are saved on the server.

Describe the event you want to plan. For example:

> An accident sends 100 additional patients to the hospital, and 10 beds are unavailable.

Sunfire asks for material missing details such as the arrival time and spread, affected unit and duration. The additional patients are a one-time batch; ordinary arrivals continue. Temporary bed restrictions change admission availability for the specified interval and restore it afterward, while retaining installed beds and existing occupants. The current care mix may be used only when disclosed as the assumption.

The change card shows **Before → After**, affected time windows and any linked changes, such as the nurses needed to support staffed beds. Direct instructions can update the shared unsaved configuration; suggestions remain proposals. The actual controls and arrival chart update through the same editor as manual changes. **Undo** restores the guarded draft change. If you edit parameters while a reply is pending, the old reply cannot overwrite your edits. Send a fresh request using the updated draft.

Ask Sunfire to save or run when ready. Real simulation jobs retain progress, cancellation and retry behavior. An assistant response and a simulation have separate cancellation controls. Completed forecasts remain immutable. Results are labelled as evidence across simulations or an individual example; missing measurements remain unavailable. Comparison uses two saved library scenarios and their compatible, current saved results.

Daily disruption chance is a probability per modeled local day, not a slowdown percentage. Recorded treatment pauses and resumptions are separate evidence visible in Replay. Resource constraints can overlap and must not be added as independent waiting contributions.

## Model and operating contract

The selected deployment model is **OpenAI GPT-OSS 120B through OCI Generative AI**. It was selected after actual access and tool-call checks against the account's available on-demand models. This is the strongest verified fit from limited functional probes, not proof of the best model overall. Grok 4.7 is supported by OCI, but this account's Chicago request and token quotas were zero during verification. Oracle rejected the attempted quota-increase submission with `403 NotAllowed` because the tenancy was ineligible to submit a limit request; no pending request was created. Switching models requires an explicit, verified configuration; the app never silently falls back to another provider.

Credentials stay on the server. Production calls use the existing host's instance principal with chat permission restricted to the selected model in the project compartment. No model receives shell, SQL, source-code execution, infrastructure, dataset-writing or completed-result-writing tools. Model requests use messages, editable planning settings, aggregate baseline data and bounded recorded evidence, without automatically adding the patient census. The product's existing generated-data provenance still applies; an actual Vanderbilt/EHR connection is not implied. OCI Grok requests, if enabled later, are externally hosted by xAI.

The [versioned HTTP and draft contract](sunfire-contract.md) describes typed tools, role/workspace checks, revision conflicts, guarded Undo, durable jobs and idempotent action receipts. Provider or network errors leave AEGIS usable and configuration preserved. Availability is reported from matching operator verification and observed provider failures; opening the launcher does not issue a paid model ping.
