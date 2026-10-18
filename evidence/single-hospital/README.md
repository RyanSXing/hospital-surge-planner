# Single-hospital workflow release

This release focuses configuration, results and comparison on Vanderbilt University Hospital. Operational inputs are generated planning data; the backdrop identifies the real campus and the internal unit layout is illustrative.

The setup uses duration, arrival level and arrival pattern beside a live demand chart. Exact inputs remain available under **More parameters**. Empty assumption rails, the Resources workspace and alternate-site creation controls are removed. Saved hospital responses remain editable, and completed runs retain their original frozen inputs.

## Interface evidence

| View | Evidence |
|---|---|
| Main controls and live arrivals | [Desktop setup](browser-desktop-simple-setup-middle.png), [mobile setup](browser-mobile-simple-setup.png) |
| Responsive chart and compact shell | [320px](browser-desktop-arrival-preview-320.png), [1280px](browser-desktop-arrival-preview-1280-middle.png) |
| Hospital-only response options | [Comparison](browser-desktop-hospital-comparison.png) |
| Continuous replay and optional evidence | [Replay](browser-desktop-replay-simple.png), [desktop measurements](browser-replay-simple-desktop.json), [mobile measurements](browser-replay-simple-mobile.json) |
| Exact inputs and conservation | [Bed and staffing checks](browser-internal-hospital-resources-desktop.json), [full workflow](browser-workflow.json) |

The full browser run and the final affected-flow follow-up are attributed separately in `local-verification.json`. Initial failures remain in `browser-full-initial.json`; the follow-up documents their resolution. Local ZIP export verification is separate from hosted smoke, where export download is skipped.

`backup.json` records the private database backup taken before the requested scenario reset. The live reset archives existing scenarios recoverably and preserves their inputs and run artifacts. Hosted deployment, runtime, static-asset and workspace-curation reports accompany the release after acceptance.
