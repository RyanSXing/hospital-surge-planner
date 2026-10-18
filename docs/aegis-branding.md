# AEGIS branding and sign-in

The sign-in screen shows the centered AEGIS wordmark, Sign in heading, username and password fields, and submit button. The supplied PNG is preserved byte-for-byte; SVG viewports display its wordmark and initial A without redrawing or editing the artwork. The header uses only the A symbol; page titles and favicon use AEGIS branding.

A successful authentication starts a single transition: EGIS fades out in place while only the initial A expands into the center of the screen. That same A then shrinks and moves into the top-left header. The symbol uses the identical source crop throughout, and EGIS never grows or travels. The transition waits for workspace readiness. The header symbol stays hidden until the floating A reaches its measured destination, avoiding duplicates or a handoff flash. Form and application interactions are paused during the transition; focus returns to the header when it completes. Invalid credentials leave the form available for retry. A synchronous submission guard prevents repeated requests.

Reduced motion retains the login-size artwork and uses a brief fade without zoom or travel. Session restoration and ordinary navigation do not play the introduction. Animations, timers, queued animation frames and media-query listeners are cleaned up; a bounded fallback releases the overlay if loading cannot complete.

Validation uses the actual staging authentication behavior, local generated credentials, Secure cookies on localhost and real backend responses. Three desktop browser tests cover invalid credentials and retry, symbol-only animation geometry and destination, stationary fading letters, delayed authentication/workspace responses, duplicate submission, reduced motion, session reload and navigation. The latency tests delay and forward original responses; authentication is not mocked. The symbol-motion correction is recorded separately in evidence/aegis-symbol-motion/; the preceding release remains in evidence/aegis-branding/.

No existing scenarios, results, defaults, datasets or private storage are changed by this release.

The preceding live release was `f1760cf81f5fe9af436c27f58f59c40068eeab89`. Its acceptance evidence is retained. The symbol-only correction is undergoing fresh browser and hosted acceptance checks.
