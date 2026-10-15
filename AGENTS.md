# SaveLocker — Decky plugin

Decky Loader plugin that writes the Steam launch options the SaveLocker agent cannot set itself.
The frontend runs inside Steam's own JS context; the Python backend (`main.py`) is the only part
allowed to call the agent (`127.0.0.1:5178`, token in `~/.local/share/SaveLocker/api-token`).
The agent and its install path live in the sibling repo `../SaveLocker` (C#). `README.md` documents
the user-facing rationale, manual install, and debug routes — read it before architectural changes.

## Commands

- `npm ci` — only `package-lock.json` is committed; CI uses `npm ci`.
- `npm run build` — rollup via `@decky/rollup`, writes `dist/index.js` (`dist/` is gitignored).
- `npx tsc --noEmit -p tsconfig.json` — typecheck; there is no npm script for it.
- `npm run watch` — rebuild on change.
- No tests or lint exist here. Verification for frontend changes is tsc + build (and optionally
  grepping `dist/index.js` for new symbols). Python changes are only verifiable on a Deck.

## Constraints that must not be "fixed"

- **Every agent API call stays in `main.py`.** The agent deliberately has no CORS policy and rejects
  foreign `Origin`s; the frontend runs on `https://steamloopback.host` and cannot call it at all.
- **Never add the `_root` flag to `plugin.json`.** Read `decky.DECKY_USER_HOME`, never `HOME` (the
  backend's home is `/root`). Treat `~/.local/share/SaveLocker/` as read-only except for reading
  `api-token`; root-created files there break the agent on its next rewrite.
- `plugin.json` `flags: ["debug"]` is Decky's reload opt-in, not a dev switch — keep it.
- `main.py` cannot run off-Deck (`import decky` comes from the loader).
- Decky shares one asyncio loop across all plugins: blocking `_request` calls with long timeouts
  must go through `asyncio.to_thread` (see `pre_launch_sync`), and subprocess work uses
  `asyncio.create_subprocess_exec` (see `sync`/`doctor`), never `subprocess.run`.

## Frontend build quirks

- `@decky/rollup` sets `output.exports: 'default'`, so `src/index.tsx` must have exactly one export —
  the `definePlugin(...)` default. A named export imported elsewhere fails `npm run build` with a
  Rollup error that `tsc` does not report. Put shared code in `shared.tsx`; new cross-module helpers
  go in a leaf module (pattern: `syncStatus.tsx`) rather than being imported from `index.tsx`.
- Steam tears down and rebuilds QAM/library components on navigation, so state that must survive
  lives at module scope by design (sync target in `index.tsx`, chip store in `syncStatus.tsx`).
- `callable<...>('name')` in TS dispatches to the same-named method on `Plugin` in `main.py` —
  change both sides together.
- Exit codes lie: the agent CLI exits 0 for up-to-date, refused, and blocked syncs alike. Classify
  output from the agent's own log phrases via `syncStatus.tsx`'s `classifySyncOutput`.
- `SteamClient` members are undocumented Valve internals; declare only what is used in
  `src/steam.d.ts` and guard calls that may not exist.
- Plugin code runs in Steam's `SharedJSContext`, but the QAM and the full page render in OTHER
  windows (`QuickAccess_uid*`, `Steam Big Picture Mode`). The global `document` /
  `getComputedStyle` are SharedJSContext's own: look elements up from a ref and read styles through
  `el.ownerDocument.defaultView`. A global `document.querySelector` silently finds nothing.
- Right stick: Steam's navigation only maps the LEFT stick to directions. The right stick arrives
  as `SteamClient.Input` analog messages (action 47, `GAMEPAD_ANALOG_SCROLL`) only while
  `EnableControllerAnalogInputMessages(true)` is on, and x/y are a running mouse-style total
  (~3,200 units/s at full tilt; stick up lowers y) — scroll by the delta. See `useRightStickScroll`.

## Layout notes

- `src/`: `index.tsx` (QAM panel + plugin wiring; registers routes/overlays/listeners and tears all
  of them down in `onDismount`), `fullPage.tsx` (settings page at `/savelocker`), `gamingSync.tsx`
  (Gaming Mode launch/close detection), `libraryOverlay.tsx` (library-page buttons/chip),
  `conflicts.tsx`, `syncStatus.tsx`, `toast.tsx`.
- `store/plugins` is the custom-store index; CI regenerates and commits it on release. Never edit
  by hand.
- `docs/tasks/*/plan.md` are active task plans. `docs/session_summary.md` is a historical session
  log — some callables and details in it are stale; trust `src/` and `main.py` first.
- Code comments referencing `tasks/...` (e.g. `tasks/conflict-resolution-ui/plan.md`) point at the
  sibling agent repo, not this one.

## Deploy / release

- Release is a tag: pushing `v*` runs `.github/workflows/release.yml`, which builds, packages
  `plugin.json` + `package.json` + `main.py` + `dist/` exactly as Decky unpacks them, publishes the
  zip, regenerates `store/plugins` with the zip's SHA-256, and commits it to `main`.
- The store version comes from the tag name, but Decky and `main.py`'s `plugin_version` report
  `package.json`'s `version` — bump it when tagging (v0.2.4 shipped with package.json still at
  0.2.3; keep them in step).
- Hardware testing uses the sibling agent repo's pipeline (installs as `SaveLocker-Test`): from
  `../SaveLocker/tests`, set `$env:SAVELOCKER_DECKY_PLUGIN_REPO` to this checkout, then
  `.\testenv.ps1 build` and `.\testenv.ps1 up`.
- Manual copy to a Deck: stage all four items (`plugin.json`, `package.json`, `main.py`, `dist/`) and
  `sudo cp` into `~/homebrew/plugins/SaveLocker`. Omitting `package.json` makes Decky eval the ESM
  bundle as a classic script and fails inside the loader with `Unexpected token 'export'`.
- Frontend errors exist only in CEF: `ssh -N -L 8080:127.0.0.1:8080 deck@<ip>`, then CDP against the
  `SharedJSContext`/`QuickAccess` targets. Backend logs: `~/homebrew/logs/SaveLocker/*.log`.

## Git and style

- Remotes: `origin` = Marwanello fork (active, ahead), `upstream` = SkorcherX (canonical, behind).
- Line endings are LF by policy (`.gitattributes`); do not let commits flip files to CRLF.
- The house style is rationale-heavy doc comments (the why, failure modes, hardware findings) on
  nearly every function. This is deliberate — preserve and match it when editing; do not strip it.
