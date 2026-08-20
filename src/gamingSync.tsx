import { useState } from 'react'
import { PanelSection, PanelSectionRow, ToggleField } from '@decky/ui'
import { callable, toaster } from '@decky/api'

/**
 * Gaming Mode launch/close detection — split out of index.tsx (already ~800 lines without this)
 * rather than folded in. The per-game alias/pull-enabled UI this depends on lives on the full-screen
 * page now (fullPage.tsx), not here; this file owns the detection logic and the one global toggle.
 *
 * This is deliberately NOT the same guarantee the launch-option wrapper gives (see index.tsx's
 * `applyAll`): that one runs pull before the game binary exists at all. This one reacts to
 * `SteamClient.GameSessions.RegisterForAppLifetimeNotifications`, which only fires once the process
 * already does — so the pre-launch pull below is best-effort and can be legitimately refused by the
 * agent's own "game is running" guard. The close-side push has no such race: by the time
 * `bRunning` goes false the process has genuinely exited, so that half is fully reliable, and is
 * never gated by the pull-enabled setting below — only the pull is optional.
 *
 * For any game whose launch-option wrapper IS applied (`rows()`'s `appliedAt` set), this stays
 * hands-off entirely — running a second pull/push here would race the wrapper's own sync rather
 * than back it up.
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
}

type Result<T> = { ok: true; data: T } | { ok: false; reason: string }

const fetchRowsForSync = callable<[], Result<GamingSyncRow[]>>('rows')
const fetchGamesForSync = callable<[], Result<GamingSyncGame[]>>('games')
const runSyncForGaming =
  callable<[string, string | null, boolean], Result<{ exitCode: number; output: string }>>('sync')
const fetchGamingSyncEnabled = callable<[], boolean>('gaming_sync_enabled')
const persistGamingSyncEnabled = callable<[boolean], void>('set_gaming_sync_enabled')
const fetchPullOverrides = callable<[], Record<string, boolean>>('gaming_pull_overrides')

// Module scope, not React state: this needs to be read from a SteamClient callback that fires
// outside any component's lifetime, same reasoning as index.tsx's `stickyTarget`.
let gamingSyncEnabled = true
// steamAppId -> the tracked game's name, for whichever launches this session has pulled for (or
// skipped pulling for, per the setting below) and is waiting to push on close. In-memory only: a
// Decky/plugin reload mid-game loses this session's close-side push, an accepted, documented
// limitation rather than something persisted.
const trackedLaunches = new Map<number, string>()

/**
 * Which tracked game (if any) this Steam AppID is, whether this mechanism should touch it at all,
 * and whether it has a resolved Steam AppID (used to default the pull-enabled setting below). Null
 * covers both "not an enrolled game" and "enrolled, but the launch-option wrapper already owns it" —
 * the caller doesn't need to tell those apart, it just does nothing either way.
 */
async function resolveMatch(
  appId: number,
): Promise<{ gameId: string; name: string; isSteamGame: boolean } | null> {
  const [rows, games] = await Promise.all([fetchRowsForSync(), fetchGamesForSync()])

  // Primary match: the exact steamAppId -> game mapping already fetched for the launch-options
  // feature. Far more reliable than a name comparison, and it doubles as the wrapper-applied check.
  if (rows.ok) {
    const row = rows.data.find((r) => r.steamAppId === appId)
    if (row) return row.appliedAt !== null ? null : { gameId: row.gameId, name: row.name, isSteamGame: true }
  }

  // Fallback: only reachable for a game absent from `rows()` at all — i.e. one with no resolvable
  // Steam AppID, so there is no wrapper to race regardless of what this finds, and not "a Steam
  // game" for the pull-enabled default below (Steam Cloud has nothing to key on here either).
  if (!games.ok) return null
  const displayName = appStore.GetAppOverviewByAppID(appId)?.display_name?.trim().toLowerCase()
  if (!displayName) return null
  const game = games.data.find((g) => (g.alias ?? g.name).trim().toLowerCase() === displayName)
  return game ? { gameId: game.gameId, name: game.name, isSteamGame: false } : null
}

/**
 * Whether the pre-launch pull should run for this game: an explicit override if the user set one,
 * else off for a game with a resolved Steam AppID (so this never fights Steam's own Cloud sync for
 * an ordinary Steam library game) and on otherwise.
 */
export function resolvePullEnabled(
  overrides: Record<string, boolean>,
  gameId: string,
  isSteamGame: boolean,
): boolean {
  const override = overrides[gameId]
  return override !== undefined ? override : !isSteamGame
}

async function handleLifetimeChange(data: SaveLockerAppLifetimeNotification): Promise<void> {
  if (!gamingSyncEnabled) return

  if (data.bRunning) {
    if (trackedLaunches.has(data.unAppID)) return // already handling this launch
    const match = await resolveMatch(data.unAppID)
    if (!match) return

    trackedLaunches.set(data.unAppID, match.name)

    const overrides = await fetchPullOverrides()
    const pullEnabled = resolvePullEnabled(overrides, match.gameId, match.isSteamGame)
    if (!pullEnabled) {
      toaster.toast({ title: 'SaveLocker', body: `Pull before launch is disabled for ${match.name}` })
      return
    }

    toaster.toast({ title: 'SaveLocker', body: `Syncing ${match.name} before launch…` })
    const r = await runSyncForGaming('pull', match.name, false)
    // A refusal here is the agent's own "game is running" guard doing its job — the process already
    // exists by the time this notification fires, so this is expected, not a failure to report loudly.
    if (r.ok && r.data.exitCode === 0) {
      toaster.toast({ title: 'SaveLocker', body: `Pulled ${match.name}` })
    }
  } else {
    const name = trackedLaunches.get(data.unAppID)
    if (name === undefined) return
    trackedLaunches.delete(data.unAppID)

    toaster.toast({ title: 'SaveLocker', body: `Syncing ${name} after play…` })
    const r = await runSyncForGaming('push', name, false)
    toaster.toast({
      title: 'SaveLocker',
      body: r.ok && r.data.exitCode === 0 ? `Pushed ${name}` : `Could not push ${name} — see the plugin`,
    })
  }
}

let registered = false

/**
 * Wires the launch/close listener once. Called from `definePlugin`'s setup rather than from
 * `Content()`'s mount, so it is live as early as the plugin loads rather than only while the QAM
 * panel happens to be open — the best available mitigation for the known Steam/Decky quirk where
 * some app-lifetime registrations only reliably fire after the plugin has been viewed once per boot.
 * That residual limitation is not solved by this, only reduced; it needs hardware verification.
 */
export function registerGamingModeSync(): void {
  if (registered) return
  registered = true
  void fetchGamingSyncEnabled().then((value) => { gamingSyncEnabled = value })
  SteamClient.GameSessions.RegisterForAppLifetimeNotifications((data) => void handleLifetimeChange(data))
}

export function GamingSyncSettings() {
  const [enabled, setEnabled] = useState(gamingSyncEnabled)

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

// GamingSyncRow/GamingSyncGame stay exported-in-spirit via fullPage.tsx's own equivalent local
// types (same shape) — this file only needs them for resolveMatch above, not any UI anymore.
