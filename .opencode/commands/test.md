---
description: Verify the Decky plugin (tsc + build; no test suite exists)
---

$ARGUMENTS

This repo has no automated tests (`AGENTS.md`). Verification is `npx tsc --noEmit -p tsconfig.json` plus `npm run build` — run both and report pass/fail with any errors.

`main.py` cannot run off-Deck (`import decky` comes from the loader), so Python changes are only verifiable on a real Deck via the sibling agent repo's `testenv.ps1` (installs as `SaveLocker-Test`; set `$env:SAVELOCKER_DECKY_PLUGIN_REPO` to this checkout first).
