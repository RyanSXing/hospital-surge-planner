# Single-hospital workflow release

Application release: `3e9f792d43339a08ea0673b1c272527c28df102a`.

[Open demo](https://hospital-surge.131.186.0.156.sslip.io/?view=overview&scenario=scenario-demo-v1-1-0-hospital_baseline-41021-365) · [Completed demo results](https://hospital-surge.131.186.0.156.sslip.io/?view=analysis&analysis=summary&scenario=scenario-demo-v1-1-0-hospital_baseline-41021-365&run=run_d69728c5b6a9413ca4ae).

- [Local verification](local-verification.json): 605 backend tests, 129 frontend unit tests and 91 distinct browser checks passed; 19 device-specific skips, no unresolved failures.
- [Deployment](deployment.json), [exact source and bundle hashes](release.json), [all 43 hosted asset matches](live-assets.json), [six-service runtime and volume preservation](runtime-preservation.json).
- [Full browser run](browser-full-initial.json): 85 passes, 19 skips and two initial failures. [Final affected-flow run](browser-followup.json): 36 passes, two skips and zero failures. [Scope](final-followup-scope.json) identifies the later changes; unchanged full-suite cases were not all rerun against the final bundle.
- [Refreshed private database backup](backup-refreshed.json), taken before the requested scenario cleanup.
- [Actual hosted demo](cloud-smoke.json): all ten runs across seven days completed on this release, with four private OCI artifacts; **20.840 s** from worker start to durable completion.
- [Hosted comparison](live-comparison.json): the current setup and two hospital responses each completed ten runs; all three plans were feasible. [Open comparison](https://hospital-surge.131.186.0.156.sslip.io/?view=analysis&analysis=comparison&scenario=scenario-demo-v1-1-0-hospital_baseline-41021-365&comparison=comparison_caf1e7ae9e4545a5ad35).
- [Live browser proof](live-browser.json): Overview/setup, Summary, Replay play/pause, Analytics, completed Comparison and the one-demo library inspected with zero browser errors. The handoff returns to Overview.
- [Requested workspace cleanup](workspace-curation.json): 39 old scenarios archived recoverably; demo is the only active scenario. Previous inputs and 20 recent completed-run references remain intact; no hard deletions.

This release focuses configuration, results and comparison on Vanderbilt University Hospital. Operational inputs are generated planning data; the backdrop identifies the real campus and the internal unit layout is illustrative.

The setup uses duration, arrival level and arrival pattern beside a live demand chart. Exact inputs remain available under **More parameters**. Empty assumption rails, the Resources workspace and alternate-site creation controls are removed. Saved hospital responses remain editable, and completed runs retain their original frozen inputs.

## Hosted screenshots

| View | Evidence |
|---|---|
| Overview | [Live screenshot](live-demo-overview.jpg) |
| Simulation setup | [Live screenshot](live-demo-setup.jpg) |
| Summary | [Live screenshot](live-demo-summary.jpg) |
| Replay | [Live screenshot](live-demo-replay.jpg) |
| Analytics | [Live screenshot](live-demo-analytics.jpg) |
| Comparison | [Live screenshot](live-demo-comparison.jpg) |
| Scenario library | [Live screenshot](live-demo-library.jpg) |

## Local interface evidence

| View | Evidence |
|---|---|
| Main controls and live arrivals | [Desktop setup](browser-desktop-simple-setup-middle.png), [mobile setup](browser-mobile-simple-setup.png) |
| Responsive chart and compact shell | [320px](browser-desktop-arrival-preview-320.png), [1280px](browser-desktop-arrival-preview-1280-middle.png) |
| Hospital-only response options | [Comparison](browser-desktop-hospital-comparison.png) |
| Continuous replay and optional evidence | [Replay](browser-desktop-replay-simple.png), [desktop measurements](browser-replay-simple-desktop.json), [mobile measurements](browser-replay-simple-mobile.json) |
| Exact inputs and conservation | [Bed and staffing checks](browser-internal-hospital-resources-desktop.json), [full workflow](browser-workflow.json) |

Local ZIP creation, download and all member checksums passed in the full workflow. Hosted export download is excluded. The demo timing is one completed smoke workload; it does not replace the historical performance gates.

Historical performance, security and restore measurements remain attributed to their original releases in the [hosted verification record](../../docs/hosted-verification.md).
