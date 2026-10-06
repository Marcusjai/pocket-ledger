# Repayment handoff tests

The browser tests are designed to run against a loopback HTTP server in fresh
ephemeral Chromium contexts, using synthetic IndexedDB records and empty
connection settings.
They never call a real transaction backend. Unexpected non-loopback page requests
are blocked and fail the test; a self-only Content Security Policy also blocks
remote requests from pages and service workers.

## Deterministic simulated-DOM integration

```sh
node --test tests/repayment-app.test.js
# Include separate parser/domain unit tests:
node --test tests/*.test.js
```

The dependency-free Node integration suite executes the actual `app.js`,
`repayment-link.js`, `engine.js`, and store domain functions. A small DOM/event/
history adapter and transactional in-memory state replace browser APIs and
IndexedDB. It checks cold/open-page links, validation, drafts, keep/discard,
consumed history, refresh, manual saving, slow-save/new-link races, newer edits
and navigation, repeated submissions, and initialization failure/delay.
No network is available to the adapter. These tests do not prove native
DOM behavior, rendering, IndexedDB, or service-worker behavior.

## Browser setup and run

Requires Python 3.10+ with Playwright and a compatible Chromium executable.
For example, in an isolated Python virtual environment:

```sh
python -m pip install playwright
# Install Chromium through your OS package manager, or install Playwright's build:
python -m playwright install chromium
# If using Playwright's build, set CHROMIUM_PATH to its installed executable.
CHROMIUM_PATH=/usr/bin/chromium python -m unittest discover -s tests -p 'test_*_browser.py' -v
```

Tests start and stop their own server. `CHROMIUM_PATH` defaults to
`/usr/bin/chromium`. Screenshot output defaults to
`/tmp/pocket-ledger-browser-tests`; set `BROWSER_TEST_ARTIFACTS` to override it.
No dependency lockfile is introduced into the static app.

The prepared browser cases cover cold/open-page handoffs, strict invalid payload rejection,
manual original-expense selection and saving, oversize validation, all existing
draft fields, explicit keep/discard, edited/cleared fields, repeat/newer links,
navigation and Back/Forward, delayed/failed IndexedDB initialization, narrow
phone widths, and an offline reload using the service-worker-cached shell and
new repayment parser. It also exercises an old-to-new service-worker upgrade
without mixing shell versions. The upgrade fixture reads the Git revision in
`BASELINE_REF`, defaulting to
`e6bd6ae3b4883fed94fa9e67c2d108ccd718bdd2`. That revision and its complete static
assets must already exist in the local Git history; tests never fetch history.
Override `BASELINE_REF` only if your test fixture uses a different known baseline.
Unit/parser tests are separate.

## Limits

Chromium mobile-sized viewports do not validate real iPhone Safari/PWA behavior,
Apple Shortcuts, device keyboards, native URL routing, notification extraction,
or a production deployment. All ledger entries in these tests are synthetic.
Storage-failure coverage verifies the visible startup error and absence of an
automatic transaction, not full recovery of the application after a failure.

## Verified result and environment limitation (2026-10-06)

- Combined Node suite: 131/131 passed (parser/domain, notification extraction,
  simulated-DOM integration, and service-worker/asset checks)
- Simulated-DOM integration specifically: 18/18 passed
- Python browser test source: compiled successfully; 20 test methods prepared
- Chromium browser execution: blocked before the first test in the available
  test environment. Chromium failed to create its process-singleton socket: `process_singleton_posix.cc:297 socket() failed: Operation not permitted`
- The loopback HTTP test server did start successfully
- No browser screenshots or real-browser pass are claimed

The startup-error test documents an existing limitation: if IndexedDB cannot
open, a clear storage error appears and no repayment is saved, but routing
never starts and the amount remains in the URL fragment. The fragment is not
sent as part of an HTTP request. Retrying after storage works can still consume
the handoff. This failure path is outside the handoff change's scope.
