import { useEffect, useState } from 'react'
import { PanelSection, PanelSectionRow, ToggleField } from '@decky/ui'
import { callable } from '@decky/api'
import { saveLockerToast } from './toast'
import {
  classifySyncOutput, outcomeChip, pageOpenPullIsFresh, setChip,
} from './syncStatus'

// Re-exported so existing importers (index.tsx, libraryOverlay.tsx) keep one obvious place to reach
// for these; the definitions themselves moved to `syncStatus.tsx` so that module could stay a leaf
// both this file and `libraryOverlay.tsx` import without the three becoming circular.
export { classifySyncOutput } from './syncStatus'
export type { SyncOutcome } from './syncStatus'

/**
 * Gaming Mode launch/close detection — split out of index.tsx (already ~800 lines without this)
 * rather than folded in. The per-game alias/pull-enabled UI this depends on lives on the full-screen
 * page now (fullPage.tsx), not here; this file owns the detection logic and the one global toggle.
 * `resolveMatchSync` and `runSyncForGaming` are also exported for `libraryOverlay.tsx`'s per-game
 * Pull/Push/Sync buttons, so both features share one warm cache instead of polling the agent twice.
 *
 * The pre-launch pull is genuinely gated on completing, not a best-effort race, as of the
 * `RegisterForGameActionStart`-based path below — see `handleGameActionStart`'s doc comment for how.
 * It is deliberately NOT the same mechanism as the launch-option wrapper (see index.tsx's `applyAll`),
 * which still runs pull before the game binary exists at all via a shell wrapper substituted into
 * Steam's own launch command — for any game whose wrapper IS applied (`rows()`'s `appliedAt` set),
 * this file stays hands-off entirely, since running a second pull/push here would race the wrapper's
 * own sync rather than back it up. This file's mechanism exists for everything the wrapper does not
 * cover: Heroic, emulators, and any other launch command whose own wrapping SaveLocker's wrapper
 * cannot safely compose with.
 *
 * The close-side push reacts to `SteamClient.GameSessions.RegisterForAppLifetimeNotifications`'s
 * `bRunning` going false, which has no race to reason about: by the time it fires the process has
 * genuinely exited. It is never gated by the pull-enabled setting below — only the pull is optional.
 */

interface GamingSyncRow {
  steamAppId: number
  gameId: string
  name: string
  appliedAt: string | null
}

interface GamingSyncGame {
  gameId: string
  name: string
  alias: string | null
  hasSteamCloud: boolean
  pullBeforeLaunchEnabled: boolean | null
}

export type Result<T> = { ok: true; data: T } | { ok: false; reason: string }

const fetchRowsForSync = callable<[], Result<GamingSyncRow[]>>('rows')
const fetchGamesForSync = callable<[], Result<GamingSyncGame[]>>('games')
export const runSyncForGaming =
  callable<[string, string | null, boolean], Result<{ exitCode: number; output: string }>>('sync')
const fetchGamingSyncEnabled = callable<[], boolean>('gaming_sync_enabled')
const persistGamingSyncEnabled = callable<[boolean], void>('set_gaming_sync_enabled')
const fetchSyncOnOpenOverrides = callable<[], Record<string, boolean>>('gaming_sync_on_open_overrides')
const persistSyncOnOpenRaw = callable<[string, boolean | null], void>('set_gaming_sync_on_open')

/**
 * Persists a game's "sync on page open" override AND mirrors it into the warm `syncCache` right away.
 * Without the cache write, `resolveSyncOnOpenEnabled` (read by the launch-detection paths) would keep
 * answering with the pre-change value until the next `refreshSyncCache` — up to the 2-minute timer —
 * so a setting toggled on the full-screen page wouldn't take effect for the very next launch.
 */
export async function persistSyncOnOpen(gameId: string, enabled: boolean | null): Promise<void> {
  await persistSyncOnOpenRaw(gameId, enabled)
  if (syncCache) {
    if (enabled === null) delete syncCache.syncOnOpenOverrides[gameId]
    else syncCache.syncOnOpenOverrides[gameId] = enabled
  }
}

// Module scope, not React state: this needs to be read from a SteamClient callback that fires
// outside any component's lifetime, same reasoning as index.tsx's `stickyTarget`.
let gamingSyncEnabled = true
// steamAppId -> the tracked game's name, for whichever launches this session has pulled for (or
// skipped pulling for, per the setting below) and is waiting to push on close. In-memory only: a
// Decky/plugin reload mid-game loses this session's close-side push, an accepted, documented
// limitation rather than something persisted.
const trackedLaunches = new Map<number, string>()

/**
 * A local mirror of `rows()`/`games()`, refreshed on an interval rather than fetched per call.
 *
 * `RegisterForGameActionStart` (see `handleGameActionStart`) has to decide whether to cancel a
 * launch and must do so SYNCHRONOUSLY, before its callback returns — Steam's own launch pipeline
 * keeps advancing toward `CreatingProcess` for the entire time an `await` would otherwise take, so an
 * async `rows()`/`games()` round trip at that point would just move the race rather than remove it.
 * This cache is what makes the decision synchronous instead. `resolveMatch` (the async, authoritative
 * version used where there is no race to lose) refreshes it as a side effect on every call, and
 * `registerGamingModeSync` also refreshes it on a timer so it isn't permanently stale between games.
 */
let syncCache: {
  rows: GamingSyncRow[]
  games: GamingSyncGame[]
  syncOnOpenOverrides: Record<string, boolean>
} | null = null
let lastSyncCacheRefresh = 0

async function refreshSyncCache(): Promise<void> {
  lastSyncCacheRefresh = Date.now()
  const [rows, games, syncOnOpenOverrides] =
    await Promise.all([fetchRowsForSync(), fetchGamesForSync(), fetchSyncOnOpenOverrides()])
  if (rows.ok && games.ok) syncCache = { rows: rows.data, games: games.data, syncOnOpenOverrides }
}

/**
 * Which tracked game (if any) this Steam AppID is, and whether this mechanism should touch it at
 * all, read from the cache above with zero `await`s. Null covers "not an enrolled game", "enrolled,
 * but the launch-option wrapper already owns it", AND "the cache hasn't loaded yet" — the caller
 * doesn't need to tell those apart: it just does nothing, exactly as if this hook had never fired
 * (`handleLifetimeChange`'s `bRunning` fallback still gets an authoritative, freshly-fetched answer
 * a little later, so a cold cache degrades to the old best-effort behaviour rather than to nothing).
 */
export function resolveMatchSync(appId: number): GamingSyncGame | null {
  if (!syncCache) return null

  // Primary match: the exact steamAppId -> game mapping already fetched for the launch-options
  // feature. Far more reliable than a name comparison, and it doubles as the wrapper-applied check.
  const row = syncCache.rows.find((r) => r.steamAppId === appId)
  if (row) {
    if (row.appliedAt !== null) return null // the wrapper already owns this launch
    return syncCache.games.find((g) => g.gameId === row.gameId) ?? null
  }

  // Fallback: only reachable for a game absent from `rows()` at all — either it has no resolvable
  // Steam AppID, or the launch-options wrapper binary isn't installed on this machine at all (rows()
  // comes back empty either way) — so there is no wrapper to race regardless of what this finds.
  // `GetAppOverviewByAppID` is itself synchronous, so this fallback is race-safe too.
  const displayName = appStore.GetAppOverviewByAppID(appId)?.display_name?.trim().toLowerCase()
  if (!displayName) return null
  return syncCache.games.find((g) => (g.alias ?? g.name).trim().toLowerCase() === displayName) ?? null
}

/** The authoritative version of `resolveMatchSync`, for callers with no race to lose: it refreshes
 * the shared cache from the agent first, so the answer reflects this moment, not the last poll. */
async function resolveMatch(appId: number): Promise<GamingSyncGame | null> {
  await refreshSyncCache()
  return resolveMatchSync(appId)
}

/** The reverse of `resolveMatchSync`: which Steam AppID (if any) a tracked game's own gameId maps
 * to, for `conflicts.tsx` to know which library page's status chip a conflict belongs on. Reuses
 * this same warm cache rather than a second one — a conflict without a resolvable AppID (the game
 * has never been seen by `rows()`, e.g. no Steam launch has happened yet) has no library page chip
 * to update anyway, so `null` here is a correct "nothing to do," not a failure. */
export function gameIdToAppId(gameId: string): number | null {
  return syncCache?.rows.find((r) => r.gameId === gameId)?.steamAppId ?? null
}

/**
 * `resolveMatchSync`, but willing to pay for one fresh round trip when the cache might be stale —
 * used by the library overlay's page-open check (`libraryOverlay.tsx`'s `OverlayHost`) so a game
 * enrolled moments ago shows its Pull/Push/Sync buttons on the very next visit to its library page,
 * rather than needing the 2-minute background timer in `registerGamingModeSync` to catch up or the
 * plugin to be reloaded. Rate-limited by `maxAgeMs` rather than refreshing unconditionally: without
 * it, flipping through many unrelated (non-enrolled) games in the library would hit the local agent
 * once per page view for nothing.
 */
export async function resolveMatchFresh(appId: number, maxAgeMs = 15_000): Promise<GamingSyncGame | null> {
  if (!syncCache || Date.now() - lastSyncCacheRefresh > maxAgeMs) await refreshSyncCache()
  return resolveMatchSync(appId)
}

/**
 * Whether the pre-launch pull should run for this game: an explicit override if the user set one,
 * else off for a title known to have Steam Cloud saves (so this never fights Steam's own Cloud sync)
 * and on otherwise. `hasSteamCloud`, not a resolved Steam AppID — a non-Steam shortcut run under
 * Proton gets its own compatdata prefix too, so an AppID alone can't tell the two apart.
 */
export function resolvePullEnabled(game: {
  pullBeforeLaunchEnabled: boolean | null
  hasSteamCloud: boolean
}): boolean {
  return game.pullBeforeLaunchEnabled ?? !game.hasSteamCloud
}

/**
 * Whether opening this game's library page should also trigger a pre-launch pull, on top of pulling
 * when Play is pressed. On by default — only an explicit `false` in the local override map turns it
 * off, same shape as `resolvePullEnabled` but simpler since there is no `hasSteamCloud`-style default
 * to weigh. Meaningless (and not shown in settings) for a game with pull-before-launch itself off;
 * callers still gate on `resolvePullEnabled` separately rather than relying on this alone.
 */
export function resolveSyncOnOpenEnabled(gameId: string): boolean {
  return syncCache?.syncOnOpenOverrides[gameId] ?? true
}

// steamAppId -> the in-flight pull promise for that app, however it was started (page-open or the
// Play button below) — shared so a second trigger while one is already running joins it instead of
// starting a redundant second pull. Exported so `libraryOverlay.tsx`'s page-open trigger and this
// file's `handleGameActionStart` coordinate through the same map rather than each tracking their own.
const pullsInFlight = new Map<number, Promise<Result<{ exitCode: number; output: string }>>>()

/** Starts a pull for `appId`/`gameName`, or returns the already-running one if this app is mid-pull.
 * Callers can tell which happened via `pullsInFlight.has(appId)` before calling this. */
export function runPull(appId: number, gameName: string): Promise<Result<{ exitCode: number; output: string }>> {
  const existing = pullsInFlight.get(appId)
  if (existing) return existing
  const p = runSyncForGaming('pull', gameName, false).finally(() => pullsInFlight.delete(appId))
  pullsInFlight.set(appId, p)
  return p
}

/**
 * Reports a pull/push result: always into the status chip for that game (so the library page shows
 * the current state whenever the user next looks at it), and — unless `quiet` — as a toast too.
 *
 * `quiet` is passed by the launch path for a game whose "Sync on page open" is on. That game's
 * library page is the surface the user is already looking at when they press Play, and it carries a
 * chip saying the same thing, so a toast on top of it is the same fact twice. With sync-on-open off
 * there is no chip in play, and the toast is the only report there is.
 */
export function reportSyncOutcome(
  action: 'pull' | 'push',
  gameName: string,
  r: Result<{ exitCode: number; output: string }>,
  opts: { appId?: number; quiet?: boolean } = {},
): void {
  if (opts.appId !== undefined) setChip(opts.appId, outcomeChip(action, r))
  if (opts.quiet) return

  const verb = action === 'pull' ? 'Pull' : 'Push'
  if (!r.ok) {
    saveLockerToast('blocked', `${verb} blocked for ${gameName}`, r.reason)
    return
  }
  const outcome = classifySyncOutput(action, r.data.output)
  if (outcome === 'changed') {
    saveLockerToast('success', `${action === 'pull' ? 'Pulled' : 'Pushed'} ${gameName}`)
  } else if (outcome === 'up-to-date') {
    saveLockerToast('info', `${gameName} is up to date`)
  } else {
    const reason = r.data.output.split('\n').filter((l) => l.trim() !== '').pop() ?? `exit ${r.data.exitCode}`
    saveLockerToast('blocked', `${verb} blocked for ${gameName}`, reason)
  }
}

// appId -> "a GameActionStart-driven pull already ran (or was intentionally skipped) for this
// launch" — read once by `handleLifetimeChange`'s `bRunning` fallback and cleared there, so a launch
// the fast path already handled is never double-pulled by the slower, reactive one behind it.
const preLaunchHandled = new Set<number>()
// appId -> "a GameActionStart handler is mid-flight for this appId" — guards against a second
// GameActionStart (e.g. a mashed Play button) starting a second cancel/pull/relaunch cycle on top
// of one already running.
const interceptedLaunches = new Set<number>()
// appId -> "the very next GameActionStart for this appId is this plugin's own re-launch call below,
// not a real new launch" — without this, calling `RunGame` from inside the handler would trigger
// another GameActionStart for the same appId and cancel itself forever.
const selfRelaunching = new Set<number>()

/**
 * The reliable half of pre-launch sync: cancels Steam's own launch pipeline the instant it starts,
 * pulls, then re-triggers the launch — the same shape Steam's own Cloud sync uses (a
 * `SynchronizingCloud` step ahead of `CreatingProcess` in `LaunchAppTask_t`), rebuilt from outside
 * since a Decky plugin cannot inject a step into Valve's own pipeline. Unlike the old `bRunning`-based
 * pull (still kept below as a fallback), this genuinely gates the launch on the pull finishing: `await
 * runSyncForGaming(...)` sits between `CancelGameAction` and `RunGame`, so the process cannot exist
 * until that call has returned, refused or not.
 *
 * The one hard requirement this depends on is deciding synchronously: `CancelGameAction` has to run
 * before Steam's pipeline reaches `CreatingProcess`, so nothing before it may `await` — hence
 * `resolveMatchSync` (cache-backed, zero `await`s) rather than `resolveMatch` here. A cold cache (this
 * plugin has not fetched `rows()`/`games()` yet, e.g. moments after Steam boots) reads as "not
 * enrolled" and this function does nothing, same as any other non-enrolled launch — the `bRunning`
 * fallback in `handleLifetimeChange` still catches it a little later with an authoritative, freshly
 * fetched answer, exactly the old best-effort behaviour.
 *
 * The `finally` below always re-triggers the launch, success, refusal, or exception alike — this
 * plugin delaying a launch is acceptable, this plugin ever silently stranding one on a cancelled
 * action without retrying is not.
 */
async function handleGameActionStart(
  gameActionId: number,
  appIdStr: string,
  action: string,
  launchSource: number,
): Promise<void> {
  if (action !== 'LaunchApp') return
  const appId = Number(appIdStr)
  if (Number.isNaN(appId)) return
  if (selfRelaunching.delete(appId)) return // our own RunGame call below — let Steam run it untouched
  if (!gamingSyncEnabled) return
  if (interceptedLaunches.has(appId)) {
    // A launch for this appId is already mid-pull. This new one is a second Play press racing it —
    // cancel it too (best effort) rather than let it run the pipeline uninterrupted and start a
    // second copy of the game while the first is still syncing.
    try { SteamClient.Apps.CancelGameAction(gameActionId) } catch { /* nothing more to do here */ }
    return
  }

  const match = resolveMatchSync(appId)
  if (!match) return

  if (!resolvePullEnabled(match)) {
    preLaunchHandled.add(appId) // seen and intentionally skipped — bRunning below should not retry
    saveLockerToast('info', `Pull before launch is disabled for ${match.name}`)
    return
  }

  /**
   * "Sync on page open" owns pulling for this game, so launching should not pull a second time —
   * opening the page already fetched the latest save, and re-pulling here would delay every launch
   * to re-confirm something confirmed moments ago.
   *
   * Gated on that pull having ACTUALLY happened and still being fresh, rather than on the setting
   * alone. The setting being on is not evidence a pull ran: a game launched from a collection, from
   * the Recents row, from a controller shortcut, or straight after a Steam restart never had its
   * library page open at all, and skipping the pull on the strength of the setting would launch it
   * against a stale save with nothing said. When there is no fresh page-open pull to trust, this
   * falls through to the normal cancel-pull-relaunch path below.
   */
  const syncOnOpen = resolveSyncOnOpenEnabled(match.gameId)
  if (syncOnOpen && !pullsInFlight.has(appId) && pageOpenPullIsFresh(appId)) {
    preLaunchHandled.add(appId)
    return
  }

  interceptedLaunches.add(appId)
  try {
    SteamClient.Apps.CancelGameAction(gameActionId)
    // Confirm the cancel actually took rather than assume it: if this action is still active a
    // moment later, cancelling lost the race (the pipeline had already moved past a cancellable
    // state) — back off and let Steam's own launch carry on untouched. Proceeding anyway risks
    // calling `RunGame` on top of a launch that is still going, i.e. starting the game twice.
    const active = await SteamClient.Apps.GetActiveGameActions()
    if (active.some((a) => a.nGameActionID === gameActionId)) {
      interceptedLaunches.delete(appId)
      // Pressing Start deserves a reaction every time, not just on the path that wins the race —
      // silence here reads as "did this even see me press Play?". Routed to the chip instead of a
      // toast when the page's own chip is the reporting surface (see `reportSyncOutcome`'s `quiet`).
      setChip(appId, { kind: 'blocked', text: 'Launched unsynced', pct: null, at: Date.now() })
      if (!syncOnOpen) saveLockerToast('blocked', `Pull blocked for ${match.name}`, 'Launching without it')
      return
    }
  } catch {
    interceptedLaunches.delete(appId)
    setChip(appId, { kind: 'blocked', text: 'Launched unsynced', pct: null, at: Date.now() })
    if (!syncOnOpen) saveLockerToast('blocked', `Pull blocked for ${match.name}`, 'Launching without it')
    return
  }

  // Join an already-running pull (started by opening this game's library page — see
  // `libraryOverlay.tsx`) rather than starting a redundant second one: the report says so, since
  // "still syncing" is a different fact than "just started" and a user watching the screen should
  // see the difference between "I pressed Start early" and "this only just began".
  const joining = pullsInFlight.has(appId)
  setChip(appId, { kind: 'syncing', text: joining ? 'Finishing sync…' : 'Syncing…', pct: null, at: Date.now() })
  if (!syncOnOpen) {
    saveLockerToast('syncing', joining ? `Waiting for ${match.name} to finish syncing…` : `Starting sync for ${match.name}…`)
  }
  try {
    const r = await runPull(appId, match.name)
    reportSyncOutcome('pull', match.name, r, { appId, quiet: syncOnOpen })
  } finally {
    interceptedLaunches.delete(appId)
    preLaunchHandled.add(appId)
    selfRelaunching.add(appId)
    try {
      SteamClient.Apps.RunGame(appIdStr, '', 0, launchSource)
      // Clear the flag if RunGame never produces the matching GameActionStart it's meant to swallow
      // (some launch sources don't re-enter this hook). Without this the flag sticks and the NEXT
      // genuine launch of this game is let through with no pre-launch pull. The real self-relaunch
      // fires within milliseconds, well inside this grace window.
      setTimeout(() => selfRelaunching.delete(appId), 5000)
    } catch {
      selfRelaunching.delete(appId)
      saveLockerToast('error', `Could not relaunch ${match.name}`, 'Open it again from the library')
    }
  }
}

async function handleLifetimeChange(data: SaveLockerAppLifetimeNotification): Promise<void> {
  if (!gamingSyncEnabled) return

  if (data.bRunning) {
    if (trackedLaunches.has(data.unAppID)) return // already handling this launch
    const match = await resolveMatch(data.unAppID)
    if (!match) return

    trackedLaunches.set(data.unAppID, match.name)

    // `Set.delete` returns whether the value was present: consumes the flag and checks it in one
    // step. If `handleGameActionStart` already handled (or intentionally skipped) this exact launch,
    // there is nothing left to do — this is only reached at all for a launch that hook never saw
    // (cold cache, or a Steam build that doesn't fire `RegisterForGameActionStart` for this app).
    if (preLaunchHandled.delete(data.unAppID)) return

    if (!resolvePullEnabled(match)) {
      saveLockerToast('info', `Pull before launch is disabled for ${match.name}`)
      return
    }

    // Same "sync on page open already did this" skip as the fast path above, for the same reasons —
    // this fallback fires for launches `RegisterForGameActionStart` never saw, and those deserve the
    // identical decision rather than a second pull the fast path would have skipped.
    const syncOnOpen = resolveSyncOnOpenEnabled(match.gameId)
    if (syncOnOpen && !pullsInFlight.has(data.unAppID) && pageOpenPullIsFresh(data.unAppID)) return

    // `runPull`, not a fresh `runSyncForGaming` call: if a page-open pull (see `libraryOverlay.tsx`)
    // is already running for this app, join it rather than starting a redundant second one.
    setChip(data.unAppID, { kind: 'syncing', text: 'Syncing…', pct: null, at: Date.now() })
    if (!syncOnOpen) {
      saveLockerToast('syncing', pullsInFlight.has(data.unAppID)
        ? `Waiting for ${match.name} to finish syncing…`
        : `Starting sync for ${match.name}…`)
    }
    const r = await runPull(data.unAppID, match.name)
    reportSyncOutcome('pull', match.name, r, { appId: data.unAppID, quiet: syncOnOpen })
  } else {
    const name = trackedLaunches.get(data.unAppID)
    if (name === undefined) return
    trackedLaunches.delete(data.unAppID)

    // The push after a play session runs while NO library page is mounted — the user is on the
    // "game closed" screen, not looking at a chip. Writing the result into the chip store anyway is
    // the point: navigating back to the game afterwards is exactly when they want to see whether
    // this session's progress made it to the server, and before this the chip was empty there.
    setChip(data.unAppID, { kind: 'syncing', text: 'Saving…', pct: null, at: Date.now() })
    saveLockerToast('syncing', `Syncing ${name} after play…`)
    const r = await runSyncForGaming('push', name, false)
    reportSyncOutcome('push', name, r, { appId: data.unAppID })
  }
}

let registered = false
// The handles for everything `registerGamingModeSync` wires up, kept so `unregisterGamingModeSync`
// can tear them all down. Two SteamClient registrations and the cache-refresh interval — none of
// which stop on their own — so a plugin reload/update that skipped this would leave the old handlers
// firing alongside the freshly-registered ones (double pull/push per launch) and leak the interval.
let lifetimeReg: SaveLockerUnregisterable | null = null
let gameActionReg: SaveLockerUnregisterable | null = null
let cacheRefreshTimer: ReturnType<typeof setInterval> | null = null

/**
 * Wires the launch/close listeners once. Called from `definePlugin`'s setup rather than from
 * `Content()`'s mount, so it is live as early as the plugin loads rather than only while the QAM
 * panel happens to be open — the best available mitigation for the known Steam/Decky quirk where
 * some app-lifetime registrations only reliably fire after the plugin has been viewed once per boot.
 * That residual limitation is not solved by this, only reduced; it needs hardware verification.
 *
 * The cache backing `resolveMatchSync` is refreshed here too: once immediately (racing the first
 * launch of the session — see `handleGameActionStart`'s doc comment for what happens if it loses),
 * and then on a timer so a game enrolled or re-aliased mid-session doesn't need a plugin reload to be
 * seen by the fast, synchronous path. `resolveMatch` (used by the `bRunning` fallback) also refreshes
 * it as a side effect, so the timer is a floor, not the only source of freshness.
 */
export function registerGamingModeSync(): void {
  if (registered) return
  registered = true
  void fetchGamingSyncEnabled().then((value) => { gamingSyncEnabled = value })
  void refreshSyncCache()
  cacheRefreshTimer = setInterval(() => void refreshSyncCache(), 2 * 60 * 1000)
  lifetimeReg = SteamClient.GameSessions.RegisterForAppLifetimeNotifications((data) => void handleLifetimeChange(data))
  gameActionReg = SteamClient.Apps.RegisterForGameActionStart(
    (gameActionId, appId, action, launchSource) =>
      void handleGameActionStart(gameActionId, appId, action, launchSource),
  )
}

/**
 * Undoes `registerGamingModeSync`, called from the plugin's own `onDismount` (mirroring
 * `unregisterLibraryOverlay`). Both SteamClient registrations and the refresh interval are torn down
 * so a plugin reload doesn't layer a second set of launch/close handlers onto Steam's still-live ones.
 */
export function unregisterGamingModeSync(): void {
  if (!registered) return
  registered = false
  try { lifetimeReg?.unregister() } catch { /* already gone */ }
  try { gameActionReg?.unregister() } catch { /* already gone */ }
  if (cacheRefreshTimer !== null) clearInterval(cacheRefreshTimer)
  lifetimeReg = null
  gameActionReg = null
  cacheRefreshTimer = null
}

export function GamingSyncSettings() {
  const [enabled, setEnabled] = useState(gamingSyncEnabled)

  // `gamingSyncEnabled` is seeded to `true` and only corrected asynchronously by
  // `registerGamingModeSync`'s `fetchGamingSyncEnabled().then(...)`. If this panel mounts before that
  // resolves, the initial state above is the stale default — so re-read the persisted value on mount
  // and reconcile both the local state and the module var rather than showing ON until a remount.
  useEffect(() => {
    void fetchGamingSyncEnabled().then((value) => {
      gamingSyncEnabled = value
      setEnabled(value)
    })
  }, [])

  return (
    <PanelSection title="Gaming Mode sync">
      <PanelSectionRow>
        <ToggleField
          label="Auto-sync in Gaming Mode"
          description="Pulls an enrolled game before it starts and pushes after it closes, for games without a working launch-option wrapper."
          checked={enabled}
          onChange={(value: boolean) => {
            setEnabled(value)
            gamingSyncEnabled = value
            void persistGamingSyncEnabled(value)
          }}
        />
      </PanelSectionRow>
    </PanelSection>
  )
}
