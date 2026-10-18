# Summary and replay update

This release promotes the exact forecast timeline into Summary's main chart slot and shares the four Analytics outcome cards with Summary. Replay uses paginated recorded events to keep every displayed care stage in order, including visits absent from both sampled census endpoints. Only recorded discharges travel into the discharge bay.

Verification records in this directory identify their scope and application commit. Historical backend, performance, security and restore results remain attributed to their original releases in [hosted verification](../../docs/hosted-verification.md).

The existing live scenarios, their revisions, completed runs, workspace defaults and named volumes are protected during deployment. No scenario cleanup or new simulation is performed on the live workspace for this interface release. Browser simulation, comparison, update and ZIP checksum checks run against the local development service; hosted export download is excluded.

Private credentials, database backups, raw operational logs and browser traces remain outside tracked files.

## Local verification

- [Verification scope and results](local-verification.json): 142 frontend unit tests, 21 API contract checks, 93 full-suite browser passes with 19 intentional device skips, followed by eight affected-flow passes and two device skips after the final Summary-only CSS correction.
- [Full browser run](browser-full.json), [final affected-flow run](browser-followup.json), and [exact change scope](final-followup-scope.json).
- [Actual replay journey and draw coordinates](replay-journey.json), [source review](source-review.json), and [API contracts](backend-contracts.json).
- [Desktop Summary](browser-desktop-summary.png), [320px timeline](browser-mobile-summary-width-320.png), [390px timeline](browser-mobile-summary-width-390.png), and [replay](browser-desktop-replay-simple.png).

The full suite was not repeated after the final Summary-only CSS correction. All replay, engine and API source is unchanged from that full run. The final bundle passed the affected timeline, keyboard/calendar, screen and comparison flows; the manifest comparison records this boundary explicitly.
