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
