# AEGIS branding and sign-in

The sign-in screen shows the centered AEGIS wordmark, Sign in heading, username and password fields, and submit button. The supplied PNG is preserved byte-for-byte; SVG viewports display its wordmark and large symbol without redrawing or editing the artwork. The header, page titles and favicon use AEGIS branding.

A successful authentication starts a single transition: the login wordmark grows, the full logo appears centered, and the wordmark shrinks into the header. The transition waits for workspace readiness. The header logo stays hidden until the floating logo reaches its measured destination, avoiding duplicates or a handoff flash. Form and application interactions are paused during the transition; focus returns to the header when it completes. Invalid credentials leave the form available for retry. A synchronous submission guard prevents repeated requests.

Reduced motion retains the login-size wordmark and uses a brief fade. Session restoration and ordinary navigation do not play the introduction. Animations, timers, queued animation frames and media-query listeners are cleaned up; a bounded fallback releases the overlay if loading cannot complete.

Validation uses the actual staging authentication behavior, local generated credentials, Secure cookies on localhost and real backend responses. Three desktop browser tests cover invalid credentials and retry, actual animation geometry and destination, delayed authentication/workspace responses, duplicate submission, reduced motion, session reload and navigation. The latency tests delay and forward original responses; authentication is not mocked. All 184 frontend tests and the production build pass. Evidence is in evidence/aegis-branding/.

No existing scenarios, results, defaults, datasets or private storage are changed by this release.

Accepted live release: `f1760cf81f5fe9af436c27f58f59c40068eeab89`. All 44 hosted files match the tested bundle. A real hosted sign-out/sign-in verified the simplified login, expanded-logo hold, measured header handoff, focus restoration and interactive workspace; no unexpected browser errors were recorded. All 24 protected workspace records, saved defaults and service volumes remain unchanged.
