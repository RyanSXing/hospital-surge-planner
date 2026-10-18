# Configuration polish and daily disruption chance

The release integrates save status beside Save draft, replaces small bed/staff arrows with centered plus/minus controls, brightens severity colors, and replaces repeated analytics markers with narrow recorded-period ribbons.

Daily treatment disruption chance is optional beside the arrivals chart. Operations model 1.3 samples independent seeded local dates; arrivals continue while treatment pauses. Zero preserves earlier random trajectories. Historical models 1.0–1.2 and saved dated pauses remain supported without rewriting results.

## Verification

[Validation](validation.json) records 436 frontend tests, 132 focused simulation/API checks and six desktop workflows. Browser coverage includes typing, keyboard and plus/minus controls, Undo/Redo, save/reload, actual 14/30-day arrival curves, chance-driven interruptions, exact bottleneck Replay and saved-scenario Comparison. The initial browser report retains one obsolete wording assertion; its recorded-ribbon replacement passed on the targeted rerun, with application and bundle hashes unchanged. [Backend checks](backend-tests.json) include 0%, 100%, intermediate seeded chance, DST, overlaps, partial days, frozen lineage and historical reproduction.

Local visual checks: [configuration and save status](configuration-local.png), [number controls](number-controls-local.png), [severity colors](severity-local.png), and [actual recorded interruption ribbon](recorded-ribbon-local.png). Screens show isolated local scenarios. The [accepted hosted release](acceptance.json) matches all 48 tested frontend files, preserves four active scenarios and 23 stored records, and runs all six services with unchanged volumes. See the [live configuration](configuration-live.png), [live Analytics](analytics-live.png), and [read-only browser checks](live-browser.json). No production scenario was edited and no new production simulation was created.
