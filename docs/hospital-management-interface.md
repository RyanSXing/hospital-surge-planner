# Hospital management interface

The October 2026 interface redesign follows the user's light hospital-management references. It supersedes the original specification's dark visual theme and large persistent inspector/timeline layout. The original simulation, evidence, frozen-input, resource, import, export, and role contracts still apply.

## Working through a forecast

1. **Overview** shows the saved starting census as occupancy bars. Choose a duration, emergency-arrival level and arrival pattern beside the live arrivals chart. Open **More parameters** for optional precise edits. **Run simulation** saves the inputs and opens the completed forecast in Analysis.
2. **Summary** shows occupancy and queue charts, a short finding, and the next useful action. Facility maps, exact bed status, and the precise calendar/time controls are optional sections.
3. **Replay** follows one explicitly selected recorded run. Play, pause, speed, event stepping, and time remain separate from the ensemble forecast. Patient, capacity, and event evidence are available in an inspection drawer; exact timing tools and the full census are optional.
4. **Analytics** contains Outcomes and Patients & units. Charts are the starting point; full metric tables and exact records remain available when needed.
5. **Comparison** evaluates response plans against matched inputs. The chart and paired waiting reduction guide selection. Save a chosen response as a proposed scenario; source scenarios and earlier results remain intact.

The sidebar collapses by choice and remembers the preference in the browser. Repeated sidebar guidance and connection status have been removed; the planning guide stays available as a secondary tool. Data & setup, the planning guide, alerts, and workspace options remain secondary tools. Optional arrival timing, patient care needs, staffing, equipment, internal bed capacity and calculation settings are grouped under **More parameters**. Alternate-site, shelter and transfer planning controls and the separate Resources page have been removed from the current single-hospital workflow.

## Components and visual language

Mantine 8 supplies shared buttons, badges, alerts, dialogs, native selects, tabs, expandable sections, and replay drawers. Lucide supplies the established icon set. D3/SVG charts and the Canvas replay remain application-specific visualizations; their data tables and recorded evidence remain accessible. The shell uses a white surface, restrained blue/teal/amber accents, compact rows, clear selected states, and visible focus indicators.

Dataset timestamps and units remain visible where they explain the result. Technical IDs, execution estimates, individual resource ledgers, and reproducibility details are secondary. A failed forecast read displays an explicit retry action; missing or unobserved statistics remain distinct from zero. A selected-time reconstruction error cannot silently substitute the starting census.

## Vanderbilt campus context and original artwork

Replay has an original light campus illustration and an optional original SVG local reference centered on Vanderbilt University Medical Center in Nashville. The official location record supplies 36.14229° N, 86.801627° W and the address 1211 Medical Center Drive. The simplified north-up inset follows the official visitor map's hospital/road/garage relationships and is explicitly not to scale.

Sources: [Vanderbilt University Medical Center location](https://www.vanderbilthealth.com/locations/vanderbilt-university-medical-center), [official visitor parking map](https://www.vumc.org/med-center-parking/sites/default/files/public_files/VUMC%20Parking%20Map%20%28Visitor%29.pdf), [adult emergency department](https://www.vanderbilthealth.com/locations/vanderbilt-emergency-department).

The care-zone geometry, patient positions, operational data, resource assumptions, and transitions are synthetic. The local reference does not represent actual Vanderbilt capacity, a hospital floor plan, or real patient locations. The blue hospital application mark is also an original SVG. Artwork is drawn locally in Canvas/SVG; no remote map tiles or downloaded artwork are required.

Recorded patient identities remain stable during animation. Playback buffers upcoming recorded states and uses a continuous presentation clock. Pausing and seeking reconstruct the exact displayed time; changing the run and reduced motion preserve exact state. Interpolated positions are presentation only, never additional clinical events.

## Verification

The current single-hospital simplification is described in the [single-hospital workflow](single-hospital-workflow.md). The verification records below describe the preceding interface release; the new release has its own evidence under `evidence/single-hospital`.

The release retains the existing model and API acceptance baseline and runs the UI's unit, production-build, desktop/mobile, keyboard, permission, frozen-context, scenario, replay, comparison, recovery, import, update, and export checks. New coverage verifies guided setup, optional defaults, navigation preference, dialog focus restoration, retrying failed forecast reads without rerunning the model, local campus context, and actual Canvas compositing during animation.

The frozen production bundle passed **111 frontend unit tests** in 19 files and **71 browser checks**, with 29 intentional device-specific skips and zero failures. Desktop, touch mobile, keyboard navigation, and 320px/820px Comparison layouts are covered. See [local verification](../evidence/hospital-ui/local-verification.json) and the [complete browser report](../evidence/hospital-ui/browser-final.json). Final source identity, protected live data, and deployed-asset matching are recorded separately in the hosted release evidence. Earlier performance results remain attributed to their measured releases; this interface change does not claim a new large-cohort FPS or annual simulation benchmark.

The hosted release is `9db04450f2f0dab35dc40fc1270b09370ff5ffb4`. All 50 deployed frontend files match the tested build, a fresh two-run simulation completed, and the eight protected records and original workspace default are unchanged. See [hosted verification](../evidence/hospital-ui/hosted-verification.json), [source identity](../evidence/hospital-ui/release.json), and the [live screen gallery](../evidence/hospital-ui/README.md).
