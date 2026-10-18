# Arrival controls and simulation verification

Daily arrival edits keep the percentage slider and arrival-pattern controls visible and enabled. The slider scales the entire edited stream proportionally, preserving day-to-day differences and fixed scheduled batches. The percentage shows the average change for an edited plan. Reset daily edits restores the selected regular pattern at the current overall volume; undo restores the prior curve. Saved pattern metadata preserves the selected pattern after reload. Exact interval tools remain optional and separately labeled.

The baseline waiting-patient side panel has been removed, and hospital capacity uses the full row.

Verification includes actual 14-day and 30-day browser-to-API simulation runs, not just chart previews. Each workflow edits a late day to zero, increases the last day, rescales with the main slider, checks reset/undo, saves/reloads, and runs the exact saved conditions. Engine expected arrival totals match the forecast's integrated exposure; replay arrival events contain no new ED arrivals on the zero day and do contain arrivals on the final day. Actual patient counts remain Poisson samples, so they are not expected to equal the forecast exactly.

A separate engine regression executes paired baseline/edited simulations for both durations. It verifies every local day's exact intensity, late increases/decreases/zero arrivals, identical identities and timestamps on unaffected days and the direct-admission stream, the 25-hour daylight-saving day, and patient conservation. The regression is in the normal tests/ discovery directory.

Existing saved scenarios, results, defaults, datasets and private storage are preserved during deployment. Release evidence is in evidence/arrival-controls/.

Accepted live release: `c33cca192e7d77cd3b35a4504db6ddb0468ce8de`. Validation passed: 184 frontend tests, 11 desktop browser flows, two engine regressions executing four runs, plus the two full browser-submitted 14/30-day runs. All 43 hosted bundle files match the tested build. Live controls remain available after dot edits for both durations, with no browser errors; all 23 protected workspace records and service volumes remain unchanged.
