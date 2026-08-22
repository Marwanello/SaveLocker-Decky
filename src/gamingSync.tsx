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
  hasSteamCloud: boolean
  pullBeforeLaunchEnabled: boolean | null
}

type Result<T> = { ok: true; data: T } | { ok: false; reason: string }

const fetchRowsForSync = callable<[], Result<GamingSyncRow[]>>('rows')
const fetchGamesForSync = callable<[], Result<GamingSyncGame[]>>('games')
const runSyncForGaming =
  callable<[string, string | null, boolean], Result<{ exitCode: number; output: string }>>('sync')
const fetchGamingSyncEnabled = callable<[], boolean>('gaming_sync_enabled')
const persistGamingSyncEnabled = callable<[boolean], void>('set_gaming_sync_enabled')

// Module scope, not React state: this needs to be read from a SteamClient callback that fires
// outside any component's lifetime, same reasoning as index.tsx's `stickyTarget`.
let gamingSyncEnabled = true
// steamAppId -> the tracked game's name, for whichever launches this session has pulled for (or
// skipped pulling for, per the setting below) and is waiting to push on close. In-memory only: a
// Decky/plugin reload mid-game loses this session's close-side push, an accepted, documented
// limitation rather than something persisted.
const trackedLaunches = new Map<number, string>()

/**
 * Which tracked game (if any) this Steam AppID is, and whether this mechanism should touch it at
 * all. Null covers both "not an enrolled game" and "enrolled, but the launch-option wrapper already
 * owns it" — the caller doesn't need to tell those apart, it just does nothing either way. Returns
 * the game's own record (carrying its resolved SteamAppId and pull-before-launch override) rather
 * than a derived summary, so the caller doesn't have to re-fetch it a second time.
 */
async function resolveMatch(appId: number): Promise<GamingSyncGame | null> {
  const [rows, games] = await Promise.all([fetchRowsForSync(), fetchGamesForSync()])
  if (!games.ok) return null

  // Primary match: the exact steamAppId -> game mapping already fetched for the launch-options
  // feature. Far more reliable than a name comparison, and it doubles as the wrapper-applied check.
  if (rows.ok) {
    const row = rows.data.find((r) => r.steamAppId === appId)
    if (row) {
      if (row.appliedAt !== null) return null // the wrapper already owns this launch
      return games.data.find((g) => g.gameId === row.gameId) ?? null
    }
  }

  // Fallback: only reachable for a game absent from `rows()` at all — either it has no resolvable
  // Steam AppID, or the launch-options wrapper binary isn't installed on this machine at all (rows()
  // comes back empty either way) — so there is no wrapper to race regardless of what this finds.
  const displayName = appStore.GetAppOverviewByAppID(appId)?.display_name?.trim().toLowerCase()
  if (!displayName) return null
  return games.data.find((g) => (g.alias ?? g.name).trim().toLowerCase() === displayName) ?? null
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

async function handleLifetimeChange(data: SaveLockerAppLifetimeNotification): Promise<void> {
  if (!gamingSyncEnabled) return

  if (data.bRunning) {
    if (trackedLaunches.has(data.unAppID)) return // already handling this launch
    const match = await resolveMatch(data.unAppID)
    if (!match) return

    trackedLaunches.set(data.unAppID, match.name)

    if (!resolvePullEnabled(match)) {
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
