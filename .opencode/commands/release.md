---
description: Walk through the SaveLocker-Decky release rollout
---

$ARGUMENTS

Follow the rollout in order, confirming the version number first. Steps:
1. Bump `package.json`'s `version` to match the tag — Decky and `main.py`'s `plugin_version` report that value, and forgetting it shipped v0.2.4 as 0.2.3 (`AGENTS.md`).
2. Tag `vX.Y.Z` and push — `.github/workflows/release.yml` builds, packages `plugin.json` + `package.json` + `main.py` + `dist/` as Decky unpacks them, publishes the zip, regenerates `store/plugins` with the zip's SHA-256, and commits it to `main`.
3. Confirm the workflow committed the store update (never edit `store/plugins` by hand) and that the release assets exist.
4. Hardware check via the sibling agent repo: set `$env:SAVELOCKER_DECKY_PLUGIN_REPO` to this checkout, then `.\tests\testenv.ps1 build` and `.\tests\testenv.ps1 up` in `..\SaveLocker`.
Report each step's result before proceeding to the next.
