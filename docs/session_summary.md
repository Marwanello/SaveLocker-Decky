# SaveLocker-Decky session summary

Branch: `claude/gaming-mode-sync-detection-270ead`
Worktree: `D:\Projects\SaveLocker\SaveLocker-Decky\.claude\worktrees\gaming-mode-sync-detection-270ead`

## What shipped

Full-screen Settings page (`/savelocker` route) plus a slimmer QAM panel, replacing the
previous dropdown-based per-game alias/pull-toggle UI. Commit: `8a28cbd` — "Full-screen
Settings page: per-game list, Diagnostics and Launch options tabs".

QAM panel now: Status + progress, Sync, Gaming Mode auto-sync toggle, Settings button.
Everything else (per-game list, Diagnostics, Launch options) moved to the full-screen page.

## Key architectural constraint: single default export

`@decky/rollup`'s `generateConfig()` sets `output.exports: 'default'` on the entry bundle.
The entry file (`index.tsx`) must have **exactly one export** — the `definePlugin(...)`
default export. Any named export from `index.tsx` that a second file imports breaks the
build with a Rollup error (`"default" was specified for "output.exports", but entry module
"src/index.tsx" has the following exports: ...`), even without a real circular dependency.
`tsc --noEmit` does **not** catch this — only `npm run build` (rollup) does.

Fix: created `src/shared.tsx` as a third module. Neither `index.tsx` nor `fullPage.tsx`
imports from the other; both import from `shared.tsx`.

## File layout

- **`src/shared.tsx`** — cross-file types, callables, helpers:
  ```ts
  export const ReadOnlyRow = ({ children }: { children: React.ReactNode; key?: string | number }) => (
    <Field focusable={true} bottomSeparator="none" childrenLayout="below" childrenContainerWidth="max">
      {children}
    </Field>
  )

  export type AgentResult<T> = { ok: true; data: T } | { ok: false; reason: string }

  export const fetchRows = callable<[], AgentResult<Row[]>>('rows')
  export const resolveOptions = callable<[{ steamAppId: number; current: string }[]], AgentResult<Resolved[]>>('resolve')
  export const report = callable<[number, boolean, string | null], AgentResult<null>>('report')
  export const fetchGames = callable<[], AgentResult<TrackedGame[]>>('games')
  export const runSync = callable<[string, string | null, boolean], AgentResult<DoctorResult>>('sync')
  export const fetchState = callable<[], AgentResult<AgentState>>('state')
  export const fetchVersion = callable<[], AgentResult<AgentVersion>>('agent_version')
  export const fetchActivity = callable<[], AgentResult<ActivityDto>>('activity')
  export const runDoctor = callable<[], AgentResult<DoctorResult>>('doctor')
  ```
  Also: `currentLaunchOptions()`, `applyAll(write)`, `shortState`, `summarise`, `timeAgo`.

- **`src/fullPage.tsx`** — the new full-screen page:
  ```ts
  export const SAVELOCKER_PAGE_ROUTE = '/savelocker'
  export function FullPage() {
    const [activeTab, setActiveTab] = useState('overview')
    const tabs = [
      { id: 'overview', title: 'Overview', content: <OverviewTab /> },
      { id: 'diagnostics', title: 'Diagnostics', content: <Diagnostics /> },
      { id: 'launch', title: 'Launch options', content: <LaunchOptions /> },
    ]
    return (
      <div style={{ marginTop: '40px', height: 'calc(100% - 40px)' }}>
        <Tabs activeTab={activeTab} onShowTab={setActiveTab} tabs={tabs} />
      </div>
    )
  }
  ```
  `marginTop: '40px'` is unverified on hardware — flagged in a code comment.

  Contains `OverviewTab` (stats grid, search box filtering by name/alias, scrollable
  `GameRow` list with inline alias edit + "Pull before launch" `ToggleField`, and the
  `ActivityLog`), plus local `Diagnostics` and `LaunchOptions` tab components.

  Local callables specific to this file:
  ```ts
  const setAlias = callable<[string, string | null], AgentResult<null>>('set_alias')
  const persistPullEnabled = callable<[string, boolean | null], void>('set_gaming_pull_enabled')
  const fetchPullOverrides = callable<[], Record<string, boolean>>('gaming_pull_overrides')
  ```

- **`src/index.tsx`** — QAM entry point. Imports shared pieces from `./shared`, imports
  `FullPage, SAVELOCKER_PAGE_ROUTE` from `./fullPage`, imports `GamingSyncSettings,
  registerGamingModeSync` from `./gamingSync`. Registers the route and the Gaming Mode
  listener in `definePlugin`:
  ```ts
  export default definePlugin(() => {
    registerGamingModeSync()
    routerHook.addRoute(SAVELOCKER_PAGE_ROUTE, FullPage)
    return {
      name: 'SaveLocker',
      titleView: ...,
      content: <Content />,
      icon: <FaGamepad />,
      onDismount() { routerHook.removeRoute(SAVELOCKER_PAGE_ROUTE) },
    }
  })
  ```
  Settings navigation from the QAM:
  ```ts
  const openSettings = () => {
    Navigation.CloseSideMenus()
    Navigation.Navigate(SAVELOCKER_PAGE_ROUTE)
  }
  ```
  (`CloseSideMenus()` before `Navigate()`, confirmed pattern from a real plugin, `bash-shortcuts`.)

- **`src/gamingSync.tsx`** — Gaming Mode launch/close detection. Dropdown-based
  `GameSyncSettings` component removed entirely (replaced by the full-screen page's game
  list). Keeps `resolveMatch()`, `resolvePullEnabled()` (now exported for `fullPage.tsx`),
  `handleLifetimeChange()`, `registerGamingModeSync()`, and the single global
  `GamingSyncSettings()` toggle.
  ```ts
  export function resolvePullEnabled(
    overrides: Record<string, boolean>,
    gameId: string,
    isSteamGame: boolean,
  ): boolean {
    const override = overrides[gameId]
    return override !== undefined ? override : !isSteamGame
  }
  ```

- **`main.py`** — backend endpoints backing the above:
  ```python
  async def set_alias(self, game_id: str, alias: str | None):
      return _request("/api/games/%s/alias" % game_id, {"alias": alias})

  async def gaming_sync_enabled(self):
      return _read_settings().get("gamingSyncEnabled", True)

  async def set_gaming_sync_enabled(self, enabled: bool):
      settings = _read_settings()
      settings["gamingSyncEnabled"] = enabled
      _write_settings(settings)

  async def gaming_pull_overrides(self):
      return _read_settings().get("pullEnabledOverrides", {})

  async def set_gaming_pull_enabled(self, game_id: str, enabled: bool | None):
      settings = _read_settings()
      overrides = settings.setdefault("pullEnabledOverrides", {})
      if enabled is None:
          overrides.pop(game_id, None)
      else:
          overrides[game_id] = enabled
      _write_settings(settings)

  async def activity(self):
      return _request("/api/activity")
  ```

## `@decky/ui` / `@decky/api` facts verified from real type declarations

- `RouterHook` (from `@decky/api`, `node_modules/@decky/api/dist/types.d.ts`):
  ```ts
  export interface RouterHook {
      addRoute(path: string, component: ComponentType, props?: Omit<RouteProps, 'path' | 'children'>): void;
      addPatch(path: string, patch: RoutePatch): RoutePatch;
      addGlobalComponent(name: string, component: ComponentType): void;
      removeRoute(path: string): void;
      removePatch(path: string, patch: RoutePatch): void;
      removeGlobalComponent(name: string): void;
  }
  ```
- `Plugin` / `DefinePluginFn`:
  ```ts
  export interface Plugin {
      name: string;
      version?: string;
      icon: JSX.Element;
      content?: JSX.Element;
      onDismount?(): void;
      alwaysRender?: boolean;
      titleView?: JSX.Element;
  }
  export type DefinePluginFn = () => Plugin;
  ```
- `DropdownItem`'s `onChange?(data: SingleDropdownOption)` always receives a `{data, label}`
  object, never a bare value.
- `TextField` extends `HTMLAttributes<HTMLInputElement>` (**not** `InputHTMLAttributes`) —
  no `placeholder` prop exists; use `label` instead.
- `Tabs`: `{ tabs: Tab[], activeTab: string, onShowTab: (tab: string) => void, autoFocusContents?: boolean }`
  where `Tab = { id, title, content, ... }`.
- `DialogButton` / `DialogButtonPrimary` / `DialogButtonSecondary` are the correct buttons
  for full-page (non-QAM) contexts, as opposed to `ButtonItem` inside `PanelSection`.

## Build/type-check verification performed

```powershell
npx tsc --noEmit -p tsconfig.json   # clean
npm run build                       # clean, no circular-dependency warning, no export-mode error
```
Confirmed via `grep` on `dist/index.js` that `SAVELOCKER_PAGE_ROUTE`,
`routerHook.addRoute(...)`, and `routerHook.removeRoute(...)` are present and bundled.

## Not yet done

The full-screen page has **not** been deployed to or verified on the user's real Steam
Deck. `marginTop: '40px'` needs hardware confirmation. The original "dropdown not working"
bug was addressed architecturally (dropdown removed, replaced by a scrollable list) but
never independently root-caused or confirmed fixed on hardware.

Redeploy via the sibling `SaveLocker` repo's isolated test-plugin pipeline
(`tests/testenv.ps1`, builds/installs as `SaveLocker-Test`, separate from the real
`SaveLocker` plugin/agent):
```powershell
cd "D:\Projects\SaveLocker\SaveLocker\.claude\worktrees\save-by-alias\tests"
$env:SAVELOCKER_DECKY_PLUGIN_REPO = 'D:\Projects\SaveLocker\SaveLocker-Decky\.claude\worktrees\gaming-mode-sync-detection-270ead'
.\testenv.ps1 build
.\testenv.ps1 up
```

Note: `Build-DeckyPlugin` renames `plugin.json`'s `"name": "SaveLocker"` to
`"SaveLocker-Test"` **before** `npm run build` (not after) — `@decky/rollup` bakes the
manifest name into the bundle at build time for IPC routing, so a post-build rename left
the test plugin's frontend calling the real plugin's backend. The rename is restored via
`try/finally` after the build regardless of outcome.

## Reliable pre-launch pull + library-page buttons (this session)

Root cause of "pull before launch doesn't actually pull": `main.py`'s `sync()` always
refuses `pull` while the agent detects the game process running, and Gaming Mode's old
detection hook (`RegisterForAppLifetimeNotifications`'s `bRunning`) only fires **after**
Steam already created that process — so the old pre-launch pull was refused close to
100% of the time for any fast-launching game, not occasionally.

Fix in `src/gamingSync.tsx`: `handleGameActionStart` now listens to
`SteamClient.Apps.RegisterForGameActionStart`, which fires the instant ANY launch begins
— before `CreatingProcess`, for every entry point (Big Picture, Library grid, Quick
Access, friend-join, etc., since it's `ELaunchSource`-tagged, not tied to one UI button).
On a match it `CancelGameAction`s the launch, confirms the cancel actually took via
`GetActiveGameActions` (undocumented whether cancel can silently lose the race), pulls,
then re-triggers the launch itself with `RunGame`. This is the same shape Steam's own
Cloud sync uses internally (`LaunchAppTask_t` has a `SynchronizingCloud` step ahead of
`CreatingProcess`) — genuinely gates the launch on the pull finishing, not a best-effort
race. Guarded against re-entrancy (`selfRelaunching`), concurrent double-Play-presses
(`interceptedLaunches`), and a cold cache at Steam boot (falls through to the old
`bRunning`-based reactive pull as a fallback, tracked via `preLaunchHandled`).

This decision has to be made SYNCHRONOUSLY (zero `await` before `CancelGameAction`, or
Steam's pipeline keeps advancing during the await) — `resolveMatchSync` reads a local
cache (`rows()`+`games()`, refreshed on load and every 2 minutes) instead of fetching.
`resolveMatchSync` and `runSyncForGaming` are exported for reuse.

New file `src/libraryOverlay.tsx`: Pull/Push/Sync icon buttons floated (`position:
fixed`, top-right, unverified pixel position) onto Steam's own `/library/app/:appid`
page via `routerHook.addPatch` + `afterPatch`/`createReactTreePatcher`/`findInReactTree`
(all real exports of `@decky/ui`, confirmed by reading
`node_modules/@decky/ui/src/utils/{patcher,react/react,react/treepatcher}.ts` directly —
not in the `.d.ts` skeleton). The two-step patch pattern (locate an "overview" node
first, patch THAT node's own render, not `renderFunc`'s immediate return) mirrors
SteamGridDB's and Unifideck's shipped plugins — confirmed against Unifideck's actual
source (`src/views/AppDetailsPatch.tsx`) via `curl` on raw.githubusercontent.com, since
`WebFetch`'s summarizer kept dropping the code itself. Wired into `index.tsx`'s
`definePlugin`/`onDismount` alongside the existing route registration.

`src/steam.d.ts` gained `RegisterForGameActionStart`, `CancelGameAction`, `RunGame`, and
`GetActiveGameActions`, signatures cross-checked against the real (non-`.d.ts`, source)
`node_modules/@decky/ui/src/globals/steam-client/App.ts`.

**Verified**: `npx tsc --noEmit` and `npm run build` both clean; `dist/index.js` contains
`RegisterForGameActionStart`, `CancelGameAction`, and `library/app/:appid`.

**NOT verified — needs the user's real Steam Deck**, via the same
`tests/testenv.ps1 build && up` pipeline noted above:
- Whether `CancelGameAction` reliably wins the race before `CreatingProcess` in practice.
- Whether the cancel-then-relaunch is visually smooth or causes a flicker/stutter in
  Steam's own launch animation.
- Whether `RegisterForGameActionStart` fires for every entry point this plugin cares
  about (non-Steam shortcuts / Heroic / emulators included), or only some.
- Whether the overlay buttons' `InnerContainer` anchor is found at all, and whether
  `top: 52px, right: 48px` actually lands top-right without overlapping Steam's own UI.

## Up-to-date detection (this session, later)

Real screenshot from the user showed the actual button row is bottom-of-page beside
Play (controller/settings icons), not top-right — the overlay's position is still
`fixed` top-right and needs re-anchoring to that row when next touched.

Added: `src/toast.tsx` (colored icon-circle toast helper, 6 kinds), `syncOnOpenOverrides`
local per-game setting (`main.py`, on by default, only shown in settings when
"Pull before launch" is on), page-open auto-pull (`libraryOverlay.tsx`), and a shared
`pullsInFlight` map (`gamingSync.tsx`'s `runPull`) so Start joins an already-running
pull instead of restarting it.

Then a real finding: the SaveLocker agent (`D:\Projects\SaveLocker\SaveLocker`, sibling
repo) already hash-diffs before every pull/push (`SyncEngine.cs`: `SaveArchive.HashDirectory`
vs the server's head hash for pull, vs `LastSyncedHash` for push) and skips the transfer
if identical — no backend work was needed for "only pull/push if different." But
`AgentCli.cs`'s `pull`/`push` cases never inspect the engine's return value, so the CLI
exits 0 for **every** outcome (up-to-date, refused-because-running, blocked-by-unsynced,
conflict) — only an uncaught exception returns non-zero. `gamingSync.tsx`'s
`classifySyncOutput()` now reads the agent's own stable log phrases out of the captured
output instead ("already up to date", "restored latest save", "no local changes since
last sync", "server already had this content", "pushed new version" — anything else is
treated as blocked). `reportSyncOutcome()` wraps that into one shared toast call, used by
every pull/push site in `gamingSync.tsx`, `libraryOverlay.tsx`, and `index.tsx`'s QAM
Sync panel. This also fixed a real pre-existing bug: a refused pull (game running) used
to show a false "Pulled" toast because exit code was always 0.

**Not yet built**: the progress chip UI (mocked twice, approved for mockup only so far,
not for implementation) — would use this same `SyncOutcome`/`classifySyncOutput` once built.

## Chip built, enroll-visibility fix, toggle-row wrap fix (this session, later still)

User reported three problems against the state above: the progress chip was still not
actually rendered anywhere (only mocked), the overlay buttons on a game's library page
needed the Decky QAM panel opened once before they'd appear for a freshly-enrolled game,
and enabling "Sync on page open" made the whole `GameRow` controls line wrap onto a new
line under the game name.

**Chip, built for real**: `SyncChip` in `libraryOverlay.tsx`, rendered beside the three
icon buttons in `OverlayButtons`'s fixed-position row. Colors and icons come straight
from `toast.tsx`'s `KIND_STYLE` (now exported, along with `ToastKind`) so the chip and
the toast for the same event never disagree. States: `syncing` (blue, with a live `%`
for a push in progress — polled via `fetchActivity()` from `shared.tsx`, since only
`Pushing` phase reports byte progress; pull/sync legs show the plain label with no
percent), `success`/`changed` ("Pulled"/"Pushed"/"Synced", green), `info`/`up-to-date`
(gray), `blocked` (amber, with the agent's own refusal text as the `title` tooltip).
Wired into every action `OverlayButtons` can trigger: the page-open auto-pull, and each
of the three buttons. `outcomeChip()` mirrors `reportSyncOutcome()`'s classification but
returns chip state instead of firing a toast — kept separate because a toast should fade
and a chip should persist as the current status.

Known scope boundary, not addressed this pass: the chip only reflects syncs *this
plugin's own code* actually ran (page-open, or the three overlay buttons). It cannot
show "up to date" for a game where "Sync on page open" is off and no button has been
pressed yet, because there is no cheap agent-side "check the hash without pulling" call
today — only `pull`/`push` themselves compute the diff, as part of actually running.
Showing a live status with sync-on-open off would need a new read-only endpoint on the
agent side (cross-repo, out of scope for a plugin-only pass) rather than a client fix.

**Enroll-to-visible delay, fixed**: `injectOverlayButtons` used to call
`resolveMatchSync(appId)` and skip injecting anything at all if it returned null — which
it does both for "not enrolled" and for "cache hasn't loaded/refreshed yet", so a game
enrolled after the plugin's last 2-minute cache refresh got no buttons until that timer
(or a plugin reload) happened to catch up. Restructured around a new `OverlayHost`
component that is *always* injected once an AppID is known; it tries the synchronous
cache first and, if that comes back empty, calls a new `resolveMatchFresh()`
(`gamingSync.tsx`) which forces one real cache refresh before answering — rate-limited to
once per 15s (`lastSyncCacheRefresh` timestamp) so flipping through unrelated,
non-enrolled games in the library doesn't hit the local agent on every page view. Net
effect: a freshly-enrolled game's buttons (and its page-open auto-pull, which previously
also silently never ran in this situation since `OverlayButtons` itself never mounted)
now show up on the very next visit to its library page, no QAM-opening detour needed.

**Toggle row wrap, fixed**: root cause is that `ToggleField` (pulled from Steam's own
`CommonUIModule` via `@decky/ui`, not a plugin-owned component — see
`node_modules/@decky/ui/dist/components/ToggleField.js`) lays itself out to fill 100% of
its flex parent rather than sizing to its label, so two of them side by side in an
unconstrained flex row claim far more width than their visible switch+label need. Adding
the second toggle ("Sync on page open") pushed the *inner* controls row wide enough to
overflow, and because the outer row (`game.name` + controls) also had `flexWrap: wrap`,
the whole controls block dropped to a new line instead of the inner row just reflowing
on its own. Fix, in `fullPage.tsx`'s `GameRow`: each `ToggleField` now sits in its own
fixed-width wrapper div (200px / 180px) so its internal 100% resolves against something
narrow; the controls `Focusable` is `flexWrap: 'nowrap'` with `flexShrink: 0`; and the
name column's flex-basis was reduced (220px → 140px) with text-overflow ellipsis added
to both its lines, freeing horizontal room rather than relying on it happening to be
available. This is a real, structural fix for the documented cause, not a guessed pixel
tweak — but the exact widths (200px/180px) are still only checked against the full-page
route's presumed ~1280px width, not measured on hardware.

**Verified**: `npx tsc --noEmit` and `npm run build` both clean; `dist/index.js` contains
`resolveMatchFresh`, `OverlayHost`, and `SyncChip`.

**NOT verified — needs the user's real Steam Deck**: whether the chip's live push
percentage actually updates smoothly (activity poll is client-side at 700ms, independent
of the agent's own reporting cadence), whether 15s is the right staleness window for
`resolveMatchFresh` in practice, and whether the toggle row's fixed widths actually fit
without wrapping at the full-screen page's real on-device width.

## Chip persistence, page-open re-pull, launch-pull handoff

Hardware report from the user: the chip appeared on a game's first page open, vanished
after playing and returning, and only came back on pressing a button. Plus a direct
challenge — "i don't think sync happen on opening the page. verify that."

**Verified, and the user was right about the symptom.** Sync-on-open *did* fire, but only
ever ONCE per plugin session per game: `libraryOverlay.tsx` gated it on an
`autoPulledThisSession` `Set<number>`, so the first open of a game pulled and every later
open — including the one right after a play session, the single most likely moment for the
save to have changed — did nothing at all. Two independent bugs produced one symptom:

1. *Chip vanished*: chip state lived in `OverlayButtons`'s own `useState`, and Steam
   rebuilds `/library/app/:appid` from scratch on every navigation, so the state was
   destroyed by exactly the event it needed to survive.
2. *Nothing re-synced*: the `Set` above.

New leaf module `src/syncStatus.tsx` holds all of it at module scope: the chip store
(`getChip`/`setChip`/`useSyncChip`, a tiny subscribable map), `markPageOpenPull` /
`pageOpenPullIsFresh` / `shouldRepullOnOpen`, and — moved out of `gamingSync.tsx` —
`SyncOutcome`, `classifySyncOutput`, and `outcomeChip`. It is a leaf specifically so both
`gamingSync.tsx` and `libraryOverlay.tsx` can import it without the pair becoming
circular; `gamingSync.tsx` re-exports `classifySyncOutput`/`SyncOutcome` for compatibility.
The `Set` became a timestamp map: re-pull on open if the last one is older than
`PAGE_OPEN_REPULL_MS` (60s) — short enough that returning from a game always re-checks,
long enough that flicking between pages doesn't spam the agent.

Because the chip store is module-scope, `gamingSync.tsx` (which has no UI) now reports
into it too. The post-play push in particular runs while no library page is mounted at
all; its result is now waiting on the chip when the user navigates back, which is the case
that previously showed nothing.

**Pull moved from launch to page open.** Per the user: with "Sync on page open" enabled,
pressing Play should not pull again ("it already pulled the latest changes") and should
not toast ("the chip will do the update"). Both implemented in `handleGameActionStart` and
the `bRunning` fallback. The skip is deliberately gated on a page-open pull having
*actually happened and still being fresh* (`pageOpenPullIsFresh`, 10 min) rather than on
the setting alone — a game launched from a collection, the Recents row, or a controller
shortcut never opens its library page, and skipping on the strength of the setting would
launch against a stale save silently. Toast suppression is `reportSyncOutcome`'s new
`quiet` option; it still writes the chip via `appId`, so the report is moved, not dropped.
The chip also gained a relative-age suffix ("Up to date · 4m ago") — a bare "Up to date"
is a claim about right now, which it isn't.

**Second, separate silent gate found while verifying** (pre-existing, not reported by the
user): sync-on-open is gated behind `resolvePullEnabled`, which defaults to
`!hasSteamCloud`. A Steam Cloud title whose "Pull before launch" was never explicitly
turned on therefore gets no page-open sync and no chip, with nothing on screen saying why.
Left as-is for now since changing the default would fight Steam's own Cloud sync, but the
settings row arguably needs to say so.

**Verified**: `npx tsc --noEmit` and `npm run build` clean; `dist/index.js` contains
`shouldRepullOnOpen`, `markPageOpenPull`, `pageOpenPullIsFresh`, `useSyncChip`; no
remaining reference to `autoPulledThisSession` anywhere in `src/`.

**Known remaining gap — needs an agent change, not built.** The user wants the chip to
"always be visible matching the current status of the save with the server". It now does
so for any game the plugin has synced this session, and sync-on-open (default on) refreshes
it on every page open. But with sync-on-open OFF and nothing synced yet, there is no chip,
because nothing client-side can answer "does local match the server" without running a
pull. Investigated: `GameStateDto.Head` is a `SaveVersionDto` carrying `ContentHash`, and
the agent's `status` CLI command *already* calls `GetStateAsync(gameId)` per game — it just
prints the version GUID and never computes the local hash to compare. So a true, cheap
check (local `SaveArchive.HashDirectory` vs server head `ContentHash`, metadata only, no
download — `DownloadHeadAsync` downloads, this would not) is a small extension to that
existing command plus a `main.py` callable. Deferred because it is a cross-repo change
requiring a worktree in `D:\Projects\SaveLocker\SaveLocker`, a C# build, and the user
redeploying the agent to the Deck — a coupling worth their say-so.
