# Arrival slider duration fix

Changing the simulation duration now moves the exclusive end date of a whole-period arrival preset along with the chart. The edited preset is included in the saved scenario, so its percentage applies throughout the selected duration. Previously the chart expanded while the preset kept its seven-day endpoint.

Explicit shorter arrival windows, independently edited daily curves, and observed-reset endpoints retain their original timestamps. Calendar endpoints use the scenario time zone, including daylight-saving transitions. Changing duration and undoing it restores the complete prior draft.

Validation: 176 frontend tests, five desktop browser regressions, and a production build. Browser checks cover 7 → 14 → 30 → 7 days, slider edits across every displayed day, exact persisted endpoints, save/reload, existing custom curve editing, and the guided setup through a completed simulation. Evidence is in `evidence/arrival-duration/`.

Live acceptance: deployed application commit `e6d02f7e3a0c81edf3a89a4f9ee68c44fadb627a`; all 43 hosted bundle files match the tested build. Live 14- and 30-day slider checks passed without browser errors. All 23 protected workspace records, saved defaults, and six service volumes remain unchanged.
