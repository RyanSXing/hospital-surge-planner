# Configuration and Analysis update

Configuration now provides editable hospital beds and per-unit nurse, provider and support staff sliders. The daily arrivals curve supports direct dragging, keyboard editing and one-step gesture undo. These inputs are saved into immutable simulation revisions; the source hospital snapshot remains unchanged.

Analytics combines its charts into eleven bookmarks over one full-width chart. Summary has one full-width timeline, visible observations for sparse Week/Month intervals, and recorded bed, staffing and equipment constraints with first-occurrence links. Routine state loading uses the fixed footer instead of inserting a shifting banner.

Patient-type controls were explicitly removed from this request. Verification targets desktop; no mobile implementation or acceptance work is claimed for this update. Existing optional care-mix settings remain available.

## Local verification

- **640 backend checks**: the complete 638-case suite plus two additional API lifecycle regressions for frozen configuration and observed resets.
- **172 frontend unit tests** and the production build pass.
- **60 distinct desktop checks** pass across the complete suite and final affected-flow verification. The complete suite initially had 59 passes, one intentional device skip and one failure. That failure exposed a real duplicate chart after saving: sibling arrival and capacity components shared the same React key. Namespaced keys fix the product, and the regression now requires exactly one chart. The final affected-flow run passes 17 checks with one intentional device skip and zero failures.
- The final run covers all new controls, curve edits and imported curves, Summary constraints and timing, Analytics bookmarks, screen layout, navigation, keyboard/calendar, comparisons and local export checksums. The full suite was not repeated after the final UI corrections. API, engine and replay source is unchanged from the complete run.

[Results](local-verification.json), [complete browser run](browser-full.json), [final affected flows](browser-followup.json), [exact change scope](final-followup-scope.json), [source review](source-review.json) and [tested source/bundle hashes](release.json) record this attribution.

## Screenshots

- [Beds and staff controls](browser-desktop-configuration-capacity-middle.png)
- [Edited arrivals curve](browser-desktop-arrival-curve-edited.png)
- [Chart bookmarks](browser-desktop-analytics-bookmarks.png)
- [Sparse Month observation](browser-desktop-summary-month-observation.png)
- [Recorded staffing constraints](browser-desktop-summary-exact-staffing-bottlenecks-middle.png)

Existing live scenarios, saved results, defaults and named volumes are protected during deployment. The release backup is private OCI storage. A fresh hosted check uses only a newly created verification scenario, then archives that scenario recoverably while retaining its run and artifacts. Existing scenarios are not reset or archived. Hosted export download is excluded.

Private credentials, backups, raw operational logs and browser traces remain ignored by Git. Historical performance, security and restore measurements retain their original release attribution in [hosted verification](../../docs/hosted-verification.md).

## Hosted verification

Release `46ca91eb6b084fd0680424cc817d886e0c61c799` passed [all hosted gates](hosted-verification.json): [43 exact frontend files](live-assets.json), [six healthy services and preserved volumes](runtime-preservation.json), and [21 unchanged protected records with the original active scenario/default](preservation.json). The fresh [one-day OCI run](cloud-smoke.json) completed one replication, persisted four private OCI artifacts, used configured capacity and all three staff roles across five shift times, and reported the exact emergency-department shortages. This is a smoke workload, not a performance benchmark. Only the newly created verification scenario was [archived recoverably](verification-curation.json).

The signed-in [browser review](live-browser.json) verifies Configuration, Summary, eleven Analytics bookmarks, shortage-time navigation and configured replay. The paused scene displays all 83 recorded active patients and the equipment-limited ICU capacity of 16 supported beds; [the exact API state agrees](live-paused-state.json). There were zero browser errors or warnings. The handoff returns to the original preserved Configuration.

- [Live bed and staffing controls](live-configuration.jpg)
- [Live Configuration overview](live-configuration-top.jpg)
- [Live Summary](live-summary.jpg)
- [Live chart bookmarks](live-analytics.jpg)
- [Actual live bottlenecks](live-bottlenecks.jpg)
- [Configured replay while playing](live-configured-replay-playing.jpg)
- [Paused full hospital flow](live-configured-replay-paused.jpg)
