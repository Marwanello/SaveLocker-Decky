import { useEffect, useState } from 'react'
import {
  ButtonItem, DropdownItem, Field, PanelSection, PanelSectionRow, TextField, ToggleField,
} from '@decky/ui'
import { callable, toaster } from '@decky/api'

/**
 * Gaming Mode launch/close detection, and the per-game settings UI it depends on — split out of
 * index.tsx (already ~800 lines without this) rather than folded in.
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

/** Same D-pad-focusable-row trick as index.tsx's `ReadOnlyRow` — duplicated rather than imported
 * to avoid a circular import between this module and index.tsx. */
const ReadOnlyRow = ({ children }: { children: React.ReactNode }) => (
  <Field focusable={true} bottomSeparator="none" childrenLayout="below" childrenContainerWidth="max">
    {children}
  </Field>
)

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
const setAlias = callable<[string, string | null], Result<null>>('set_alias')
const fetchGamingSyncEnabled = callable<[], boolean>('gaming_sync_enabled')
const persistGamingSyncEnabled = callable<[boolean], void>('set_gaming_sync_enabled')
const fetchPullOverrides = callable<[], Record<string, boolean>>('gaming_pull_overrides')
const persistPullEnabled = callable<[string, boolean | null], void>('set_gaming_pull_enabled')

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
function resolvePullEnabled(
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

// Sticky across the QAM's dropdown-open remount, same reasoning and shape as index.tsx's
// `stickyTarget` for the Sync panel's own target picker.
let stickyGameId: string | null = null

/**
 * One game picker driving two per-game settings: the name-match alias, and whether Gaming Mode's
 * pre-launch pull runs for it at all. Combined rather than two separate pickers so choosing the game
 * once is enough to see and edit both.
 */
export function GameSyncSettings({ rows, games }: { rows: GamingSyncRow[]; games: GamingSyncGame[] }) {
  const [gameId, setGameIdState] = useState<string | null>(stickyGameId)
  const setGameId = (id: string | null) => { stickyGameId = id; setGameIdState(id) }
  const [editingAlias, setEditingAlias] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})

  useEffect(() => { void fetchPullOverrides().then(setOverrides) }, [])

  const selected = games.find((g) => g.gameId === gameId) ?? games[0] ?? null

  if (!selected) {
    return (
      <PanelSection title="Game settings">
        <PanelSectionRow><ReadOnlyRow>No tracked games yet.</ReadOnlyRow></PanelSectionRow>
      </PanelSection>
    )
  }

  const isSteamGame = rows.some((r) => r.gameId === selected.gameId)
  const pullEnabled = resolvePullEnabled(overrides, selected.gameId, isSteamGame)

  // The effective value IS the name when no override is set — that's what matching actually falls
  // back to, so showing anything else here would misrepresent what Gaming Mode sync will compare.
  const effectiveAlias = selected.alias ?? selected.name

  const startEditAlias = () => {
    setDraft(effectiveAlias)
    setEditingAlias(true)
  }

  const saveAlias = async () => {
    setBusy(true)
    try {
      const trimmed = draft.trim()
      const next = trimmed === '' || trimmed === selected.name ? null : trimmed
      const r = await setAlias(selected.gameId, next)
      if (r.ok) {
        // Optimistic: index.tsx's own 30s status poll refreshes `games` with the server's copy soon
        // anyway, this just avoids the field visibly reverting until then.
        selected.alias = next
        setEditingAlias(false)
      }
    } finally {
      setBusy(false)
    }
  }

  const setPull = (value: boolean) => {
    setOverrides((prev) => ({ ...prev, [selected.gameId]: value }))
    void persistPullEnabled(selected.gameId, value)
  }

  return (
    <PanelSection title="Game settings">
      <PanelSectionRow>
        <DropdownItem
          label="Game"
          rgOptions={games.map((g) => ({ data: g.gameId, label: g.name }))}
          selectedOption={selected.gameId}
          onChange={(o: any) => {
            const picked = o && typeof o === 'object' && 'data' in o ? o.data : o
            setGameId(picked == null ? null : String(picked))
            setEditingAlias(false)
          }}
        />
      </PanelSectionRow>

      <PanelSectionRow>
        <ToggleField
          label="Pull before launch"
          description={isSteamGame
            ? 'Off by default for this game — it has a Steam App ID, so pulling here could fight Steam Cloud.'
            : 'On by default — no Steam App ID resolved, so there is nothing else already syncing it.'}
          checked={pullEnabled}
          onChange={setPull}
        />
      </PanelSectionRow>

      {!editingAlias && (
        <>
          <PanelSectionRow>
            <ReadOnlyRow>
              <span style={{ fontSize: '0.85em' }}>Alias: {effectiveAlias}</span>
            </ReadOnlyRow>
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={startEditAlias}>Edit alias</ButtonItem>
          </PanelSectionRow>
        </>
      )}

      {editingAlias && (
        <>
          <PanelSectionRow>
            <TextField value={draft} onChange={(e: any) => setDraft(e?.target?.value ?? '')} />
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem layout="below" disabled={busy} onClick={() => void saveAlias()}>
              {busy ? 'Saving…' : 'Save'}
            </ButtonItem>
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem layout="below" disabled={busy} onClick={() => setEditingAlias(false)}>
              Cancel
            </ButtonItem>
          </PanelSectionRow>
        </>
      )}
    </PanelSection>
  )
}
