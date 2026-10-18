# Sunfire release verification

Application release: `56f76da2710ea52ba538d132c13d43e1feb380a1`.

Sunfire uses real OCI inference and the existing shared configuration, durable jobs, scenario library and recorded results. The sign-in gate prevents console chrome before authentication, and nursing, provider and support sliders use distinct restrained colors. The simulation engine package is unchanged.

## Verification scope

- **471 frontend tests**, **252 backend tests**: 165 assistant/provider/result tests plus 87 existing API, worker, configuration, arrival and comparison regressions.
- **16 distinct desktop browser cases**: six authentication/brand-transition cases, eight manual configuration/arrival/library-comparison cases, and two actual OCI-backed Sunfire workflows. Final browser reports have no failures, skips, retries or flakes.
- The real planning workflow clarified an incomplete incident, applied exactly 100 additional one-time arrivals and a temporary 40 → 30 → 40 bed-availability change, preserved ordinary arrivals, exercised guarded Undo and manual history, saved and completed two simulation repetitions, displayed measured outcomes, navigated to the exact recorded bottleneck and retained the run after reload without duplicate actions.
- A delayed actual model response could not overwrite a newer manual nursing edit. A fresh request using that draft succeeded.

The final read-only bottleneck repair followed the 16 browser cases. Its latest backend suite and separate real-provider browser questions verify full-forecast scope, recorded constraint ranking, affected units, times, measured waits and Replay links. The complete historical backend/browser suites were not repeated. [Validation](validation.json), [actual planning proof](real-provider-planning-summary.json), [browser report](persistent-browser-results.json), [frozen source/build hashes](tested-build-manifest.json).

Earlier failed actual-provider attempts prompted fixes to action authorization, terminal handoff, Save-and-Run intent, the metrics query bound and durable run references. Their traces remain private because browser traces can contain credentials. [Attempt summary](verification-attempts.json). The first live bottleneck question exposed an unrequested daily filter; the corrected answer uses matching full-period ensemble evidence. [Initial issue](live-initial-result-scope.json), [corrected live turn](live-sunfire.json).

## Model selection

GPT-OSS 120B is the strongest verified fit from limited functional probes of this account's usable models, not proof of the best model overall. Chicago is the only subscribed region. Grok and Gemini quotas were zero. Oracle rejected the authorized Grok quota-increase submission with `403 NotAllowed` because the tenancy was ineligible; no request was created. Production uses the existing instance principal with permission limited to the selected model in the project compartment. No user API key was copied to production and no silent fallback exists. [Access proof](provider-verification.json), [selection audit](model-selection.json), [quota attempt](grok-quota-attempt.json).

## Hosted acceptance

All **54 frontend files** match the tested production bundle. The API, worker and web identify the release above; all six services are running and reported checks are healthy. Both exact HTTPS hostnames pass certificate, origin, login, protected-read and secure host-only-cookie checks.

The **four active scenarios, 23 protected API/stored records, workspace defaults and named volumes** remain unchanged. A fresh private backup preceded deployment. Acceptance created three private read-only assistant turns, with no planning actions or new production simulations. Existing saved comparison and continuous Replay results pass read-only checks.

The corrected live question identified emergency-department bed cleaning as the greatest recorded mean waiting burden, with a median per-patient wait of **0.1892 hours** in the saved forecast. Its link opened replication 2 at `2026-10-27T13:14:42.473849Z`. The visible 29 occupied/30 physical emergency beds and one cleaning constraint match the exact state API. These numbers describe these saved results only. [Live assistant](live-sunfire.json), [navigation/layout](live-browser.json), [exact state](live-replay-state.json).

The repair rebuilt only API and web; worker shares the API image. Existing database, cache and TLS services were reused. Unused build cache and the two unused intermediate `77c6834` app-image tags were removed. Current `56f76da` and pre-update `ac0fe41` rollback images were verified present; no volumes or database records were deleted. [Deployment](deployment-current.json), [runtime](runtime-preservation.json), [stored records](stored-record-preservation.json), [preservation](preservation.json), [image cleanup](build-image-cleanup.json).

No new performance benchmark, broad model benchmark, security scan or restore trial is claimed. Earlier results retain their original release attribution.

![Live Sunfire answer and exact Replay navigation](live-replay-navigation.png)

See the [user guide](../../docs/sunfire.md), [provider setup](../../docs/sunfire-provider.md) and [HTTP/draft contract](../../docs/sunfire-contract.md).
