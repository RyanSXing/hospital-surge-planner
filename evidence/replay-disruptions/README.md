# Recorded care status, chart shading and AEGIS address

Replay colors active treatment rooms red during a recorded hospital-wide pause, including empty active rooms. The existing map key shows the reason and actual resumption time in fixed space. Queue areas and recorded beds remain unchanged. A disruption ending while supplies are exhausted keeps treatment paused until the recorded refill permits care.

Analytics uses faint amber plot backgrounds for periods with recorded resource constraints, preserving gaps and source-period precision. Treatment-interruption lines and keys are removed from every Analytics chart. Supporting interruption facts remain collapsed. Routine controls remain navy; supplies has a restrained teal accent and severity keeps its meaningful colors.

The primary free address is `aegisconsole.131.186.0.156.sslip.io`. The old address remains an exact HTTPS alias. Sessions stay host-only, so the new address requires a fresh sign-in. No additional host or storage is provisioned.

## Local verification

The final frozen build passed **447 frontend tests**, **65 distinct focused replay/API tests** and **19 desktop browser cases**. Four additional historical-model tests repeat a subset of those 65 and are not added to the total. The initial 13-case browser attempt exposed a real eight-pixel CSS-zoom fit oscillation. Paint scaling now preserves intrinsic measurements; all 19 cases pass on the repaired build, with zero layout shift in the pause/resume audits and one identical geometry across the 91-frame follow-up probe. Original failure and diagnostic evidence remain available.

Coverage includes recorded onset/resumption, backward scrubbing, continuous playback across window boundaries, overlapping disruption and supply exhaustion, actual refill, empty active rooms, missing history, bed/node identity, resource-period shading and gaps, configuration save/reload, saved-scenario comparison, three desktop viewport sizes, fullscreen, zoom, 100-bed rooms, routes, quick bed lights and reduced motion. The complete general browser/backend suites were not repeated. No new performance, security-scan or restore benchmark is claimed.

See [validation](validation.json), [browser attempts](browser-results.json), [recorded pause](pause-map-local.png) and [recorded resumption](resumed-map-local.png). Local screenshots show isolated test scenarios. Hosted acceptance evidence is recorded separately after deployment; it must match the frozen source and bundle and preserve saved scenarios, stored results and named volumes.
