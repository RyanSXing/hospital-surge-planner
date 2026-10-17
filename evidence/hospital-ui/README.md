# Hospital interface release evidence

Application release: `9db04450f2f0dab35dc40fc1270b09370ff5ffb4`.

- [Local unit/build/browser verification](local-verification.json): 111 unit tests and 71 browser checks passed; 29 device-specific skips.
- [Hosted release proof](hosted-verification.json), [exact source and build hashes](release.json), [live asset comparison](live-assets.json).
- [Saved data and default preservation](protected-final.json), [verification-only scenario curation](verification-curation.json), [predeployment backup](backup.json).

Live screenshots use actual synthetic results and the user's existing saved proposal. Summary/Replay/Analytics show the fresh verification run; Comparison shows the unchanged earlier 7-day evaluation.

| View | Live screenshot |
|---|---|
| Hospital overview | [Baseline and setup](live-overview.jpg) |
| Three-step setup | [Configure and run](live-setup.jpg) |
| Summary | [Charts and next action](live-summary.jpg) |
| Replay | [Recorded patient flow](live-replay.jpg) |
| Analytics | [Outcome charts](live-analytics.jpg) |
| Comparison | [Preserved response evaluation](live-comparison.jpg) |

The full local browser gallery covers desktop and mobile, including 320px and 820px Comparison layouts. Detailed IDs and checksums in JSON reports retain their source/run provenance. Performance results from previous releases are not reattributed to this UI change.
