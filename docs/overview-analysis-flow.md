# Overview and Analysis workflow

This user-requested rework supersedes the original specification's six-item primary navigation. The simulation model, generated data, constraints, frozen input contracts, and underlying planning capabilities remain governed by the build specification.

The application has two primary pages:

- **Overview** shows the editable scenario's source hospital baseline, snapshot timestamp, occupied/staffed/installed/enabled capacity, waiting census, and expandable unit inventory. The complete simulation editor follows: demand, staffing, equipment, capacity, sites, transfers, incident batches, horizon, repetitions, seeds, revisions, scenario library, and saved-input differences. Running saves the current editor inputs and opens Analysis/Summary.
- **Analysis** contains **Summary**, **Replay**, **Analytics**, and **Comparison**. Summary brings together computed outcomes, the campus map, selected-time capacity, placement constraints, forecast, and calendar. Replay retains the patient-flow timeline and evidence tools. Analytics includes detailed ensemble outcomes plus patient/unit and resource inspection. Comparison evaluates matched response plans and opens a completed plan in Summary or Replay.

Data & setup remains a secondary utility available from the workspace menu and Overview's baseline inspection action. Search, alerts, exports, observed updates, resource/site planning, transfer eligibility, scenario versions, and role permissions retain their existing entry points through the new hierarchy.

## Context and navigation

Overview always computes baseline cards from its source dataset snapshot. Moving the Analysis clock or choosing another replication cannot change those counts. The scenario editor stays mounted while another page is visible, so unsaved changes survive ordinary page navigation. A full browser reload restores saved server inputs; unsaved editor changes are held only in that browser page's memory.

Summary, Replay, and Analytics use the selected run's frozen dataset and scenario context. Comparison prepares alternatives from the editable scenario and labels saved results with their frozen assumptions. Global exports and alerts retain the selected result context even when Overview is visible. Completed results remain immutable when the draft changes.

Canonical URLs use `view=overview`, or `view=analysis&analysis=summary|replay|analytics|comparison`. Analytics further uses `section=outcomes|patients|resources`. `view=data` opens the secondary setup utility. Old `view=scenarios|patients|resources|compare|replay` links resolve to the corresponding new destination. Unknown view values resolve to Overview; unknown Analysis children resolve to Summary.

Page and section navigation add browser history entries. Time, grain, facility, replication, patient, unit, resource, and comparison context remain in the URL. Back/forward restores the selected scenario/run and inspection context, and stale restoration responses cannot overwrite newer navigation. Unsubmitted response choices remain available while moving between Analysis tabs.

## Verification

The browser suite includes the existing configuration, import, role, resource, frozen-context, replay, update, recovery, comparison, export, keyboard, and responsive checks, migrated to the new navigation. `navigation-flow.spec.ts` adds complete setup-to-results navigation, baseline stability, unsaved draft retention, all Analysis tabs, deep-link refresh/back/forward, comparison plan selection, update/reforecast, Replay, and ZIP checksum verification.

Release-specific results and hosted commit identity are recorded in the rework evidence and the hosted verification log after deployment.

### Local release verification — 2026-10-17

The full existing and new browser suite passed62 checks with28 intentional device-specific skips and zero failures on the frozen production bundle. After the narrow saved-count restoration and mobile chart-caption repairs,10 focused desktop/mobile checks passed with two device-specific skips. All103 frontend unit tests and the production TypeScript/Vite build passed. The final source and bundle stayed unchanged during the focused suite. See [local verification](../evidence/overview-analysis-local-verification.json), [full report](../evidence/browser-overview-analysis-local-full.json), and [final follow-up](../evidence/browser-overview-analysis-final-local.json).
