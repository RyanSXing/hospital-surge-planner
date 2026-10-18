# Replay and saved-scenario comparison

## Replay

Analysis → Replay shows an illustrative top-down hospital footprint with distinct clinical wings and a central entrance spine. ED waiting precedes emergency treatment near the entrance. Admission waiting sits before the ward and ICU corridors; discharge has a separate exit branch. Beds are compact rectangles. Blue means occupied; white means a ready physical bed. Reserved, cleaning and unavailable beds have separate states in the legend. Selecting a bed opens its recorded patient or slot; selecting a unit opens its capacity evidence.

The map uses the selected run and replication's reconstructed `state.slots` and `state.units`. It does not substitute the editable draft or baseline dataset's bed slots. Editing installed or staffed bed capacity and running again produces a new replay with that run's inventory. Older saved results keep their original inventory. Uninstalled planned beds remain in the capacity inspector and do not inflate the map's bed count.

Staffing and equipment are shared unit constraints. A ready physical bed is not necessarily available for another admission; each area therefore also shows its recorded supported capacity and admission availability. Red intensity follows occupancy relative to supported capacity and recorded constraints. Constraint categories can overlap and are never summed as separate contributions.

Noncapacity areas show counts. Waiting counts use the complete aggregate state, not a bounded patient sample. “Discharged so far” counts actual discharge events since the run began; the model does not invent a discharge-bay capacity or dwell time. Missing evidence is unavailable, not zero. Corridor movement illustrates recorded patient location changes during playback. Routes follow measured corridor junctions and room doors. Seeking, changing runs, resizing the map or enabling reduced motion clears movement.

ED waiting is the number currently awaiting assessment, not cumulative arrivals. It falls when treatment places become available. It can keep growing when supplies pause care or patients awaiting inpatient beds continue occupying ED places. Recorded unit constraints distinguish these causes from an apparent shortage of physical beds.

Dragging the replay timeline updates the actual recorded state before releasing the pointer. One exact-state read runs at a time; newer pointer positions replace the pending destination, so rapid dragging cannot build a backlog or let an older event lookup overwrite the final selection. Bed lights switch in 90 ms with one brief 150 ms glow when their recorded occupancy changes. Initial loading, unchanged frames and patient selection do not flash the beds. Reduced motion shows the same exact states without animated fills or movement.

The complete map fits the available desktop width and height by default. Compact controls leave more room for the hospital. Zoom is optional; **Fit** restores the complete view. **Expand** retains playback, the timeline and zoom controls, with an explicit **Exit full screen** action.

During playback, a short trail and a larger marker make each sampled recorded movement easier to follow along the corridors. The sample prioritizes coverage of actual units and routes, including less frequent ward, ICU and discharge movement, and uses at most twelve patients at once. It is not a proportional flow chart. Destinations still come from the simulation: a scenario with many available beds in Ward A can genuinely send most new ward admissions there. The display does not invent traffic to other wards.

## Comparison

Analysis → Comparison selects two active scenarios from the saved library. Each side uses the latest complete ordinary simulation matching that scenario's current saved configuration revision, frozen inputs, dataset, period and model version. Unsaved draft edits are excluded. Starting a run checks the expected saved revision before enqueueing; a concurrent edit requires a refresh.

The page shows outcomes, one bookmarked chart workspace and collapsed configuration differences. Changing either selector does not replace the workspace's selected scenario or run. “Open results” explicitly opens the chosen side's recorded results. Pair selection is retained in `compare_left` and `compare_right` URL parameters and browser history.

Missing, incomplete, failed, stale and archived results remain explicit. Differences are available only when periods, baselines and model versions are compatible. Zero baseline values do not produce a percentage improvement. Results are separate simulation ensembles; displayed right-minus-left differences are descriptive. Historical automated-comparison records remain available through the existing API and saved artifacts, but the new page does not generate preset response plans.

The read-only projection is `GET /api/scenario-comparisons?left_scenario_id=…&right_scenario_id=…`. Existing scenarios and saved results require no migration or rewrite.
