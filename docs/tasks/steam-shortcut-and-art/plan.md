# Steam shortcut and library art from the plugin

Create the "SaveLocker" Game Mode shortcut automatically, and keep its library art (grid, wide grid, hero, logo) in the
accent and mark the agent is showing. Today people add the shortcut by hand (install.sh step 4) and set each picture with
"Set Custom Artwork". The agent repaints its bundled `~/.local/share/SaveLocker/artwork/` folder when the look changes
(SaveLocker PR Marwanello/SaveLocker#54), but Steam keeps its own copy of a picture once it is set, so nothing reaches the
library without the person setting it again.

The plugin runs inside Steam's own JS context, so it can do this with Steam's functions, live, with no restart and no
`shortcuts.vdf` editing.

## Status

| Phase | Status |
|-------|--------|
| 1. Agent: art and look endpoints | ⏳ Not started |
| 2. Plugin: create the shortcut once | ⏳ Not started |
| 3. Plugin: set the art, and repaint on a look change | ⏳ Not started |
| 4. Settings, doctor, and updaters | ⏳ Not started |
| 5. install.sh fallback without Decky | ⏳ Not started |

## Why the plugin (findings)

- `SteamClient.Apps.AddShortcut(name, exe, startDir, launchOptions)` returns the new shortcut's appId directly. There is
  no CRC guessing, and the shortcut appears in the library at once.
- `SteamClient.Apps.SetCustomArtworkForApp(appId, base64Png, 'png', assetType)` sets a picture live. The asset types are
  0 = grid (portrait), 1 = hero, 2 = logo, 3 = wide grid. `ClearCustomArtworkForApp(appId, assetType)` removes one.
- Also available: `SetShortcutName`, `SetShortcutExe`, `SetShortcutStartDir`, `SetAppLaunchOptions` (we use this
  already), `RemoveShortcut`.
- Two plugins on the test Deck already rely on these: NonSteamLaunchers (AddShortcut, then SetCustomArtworkForApp for
  types 1, 2, 0, 3) and decky-steamgriddb (SetCustomArtworkForApp / ClearCustomArtworkForApp). So they work on current
  SteamOS.
- The alternative, writing `shortcuts.vdf` and the `userdata/<id>/config/grid/` files from the agent or install.sh, is
  only safe while Steam is closed (Steam rewrites the file on exit), needs a Steam restart, and has to guess which
  shortcut is ours. It stays as the fallback for people without Decky (phase 5).

**Caveat:** `SteamClient` is not a documented Valve API. Every call goes through one wrapper in `src/shared.tsx` that
checks the function exists and catches errors, so a Steam update that renames something degrades to "no shortcut/art",
never a broken plugin.

## Phases

### 1. Agent: art and look endpoints (SaveLocker repo)

- `GET /api/appearance` already returns the accent and mark. The plugin polls it (it already talks to the agent with the
  `X-SaveLocker-Token`), or reads a look version counter so a poll is cheap.
- Add `GET /api/steam-art/{piece}` (piece = `capsule`, `capsule-wide`, `hero`, `logo`) returning the PNG the agent
  renders for the current look (`SteamArtRenderer`), plus a stamp (accent|mark|build) so the plugin knows when to repaint.
  The pictures come from the agent, so the plugin bundles no art and always matches the look.
- Add a small store for the shortcut's appId and a "the person removed it" flag, in the agent's state, so a reinstalled
  plugin does not recreate a shortcut the person deleted on purpose.
- Regenerate `web/src/api-types.ts` and the `openapi.json` snapshot.

**Verify:** agent API tests return valid PNGs for every piece and look; the stamp changes with the look.

### 2. Plugin: create the shortcut once

- On plugin load, after the agent is reachable: look for our shortcut. Match by the stored appId first, then by exe path
  (`~/.local/bin/savelocker` or the agent binary `_agent_binary()` finds) with `ui` launch options. Never by name alone.
- None found, and not marked "removed by the person": `AddShortcut("SaveLocker", exe, startDir, "ui")`, store the appId
  with the agent, and set the art (phase 3).
- Found: if its exe path is stale (agent moved), fix it with `SetShortcutExe` / `SetShortcutStartDir`.
- If the stored appId no longer exists in the library, the person deleted it: set the "removed" flag and do not
  recreate. The Settings page offers "Add SaveLocker to the library" to undo that.

**Verify:** on the Deck, fresh install → shortcut appears without a Steam restart; delete it → not recreated after a
plugin reload; the Settings button adds it back.

### 3. Plugin: set the art, and repaint on a look change

- After creating (or finding) the shortcut: fetch the four pieces from the agent and call `SetCustomArtworkForApp` with
  types 0 (capsule), 3 (capsule-wide), 1 (hero), 2 (logo). Remember the stamp painted.
- When the agent's look stamp differs from the painted one (poll on load, on QAM open, and every few minutes while
  running), paint again. Only our own shortcut is ever touched.
- If the person set their own artwork on our shortcut, do not fight it: offer "Keep SaveLocker art in sync" as a
  setting, on by default, and turn it off automatically if a picture changed under us (compare what Steam reports, or
  simply respect the toggle).

**Verify:** change the accent and the mark in the agent UI → the library art updates within a minute, with no Steam
restart. Hero is background only, logo sits on it.

### 4. Settings, doctor, and updaters

- Settings page: "SaveLocker in your library" row: shows whether the shortcut exists, with "Add" / "Repaint art" buttons
  and the sync toggle.
- People who are only updating get this automatically: the first load of the new plugin version runs phase 2, which finds
  no shortcut (or finds their hand-made one by exe path, adopts it, and paints it).
- `savelocker doctor` (agent) reports whether a shortcut is known and when its art was last painted.

**Verify:** update from the previous plugin version with a hand-made shortcut → it is adopted, not duplicated.

### 5. install.sh fallback without Decky (SaveLocker repo)

- Only when Decky is not installed and Steam is not running (`pgrep -x steam`): add the shortcut to `shortcuts.vdf` with
  the same splicer the test rig uses (`DevSteamShortcut`), and write the grid art for its appId. If Steam is running, keep
  today's manual step 4 and say Decky makes it automatic.
- Several Steam accounts on one machine: do it for the most recently used account only (`loginusers.vdf`
  `MostRecent`), and say so.

**Verify:** WSL with a fake Steam root (as `testenv` does) and on the Deck in Desktop Mode with Steam closed.

## Out of scope

- Fetching art for games from SteamGridDB (decky-steamgriddb does that).
- Windows / Playnite shortcuts.
