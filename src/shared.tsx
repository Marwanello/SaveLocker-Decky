import { Field } from '@decky/ui'
import { callable } from '@decky/api'

/**
 * Types, callables and small helpers shared between index.tsx (the Quick Access panel) and
 * fullPage.tsx (the full-screen settings page) — split out into its own module rather than having
 * one import from the other, because Decky's build (`@decky/rollup`) requires the ENTRY file
 * (index.tsx) to have exactly one export, the plugin definition itself: `output.exports: 'default'`
 * rejects the build outright the moment index.tsx carries any named export a second file imports
 * from, circular or not. Confirmed by hitting exactly that Rollup error the first time this was
 * built with fullPage.tsx importing straight from index.tsx.
 */

/**
 * A read-only row the D-pad can actually land on.
 *
 * `Field`'s own `focusable` prop, not a bare `Focusable`: the QAM scrolls by MOVING FOCUS, and a
 * `Focusable` with no handler is not reliably a navigation target — so a block of them is a hole the
 * D-pad skips, and scrolling up into it jumps to the back button instead. Every read-only row in
 * this panel goes through here for that reason. The full-screen page is not D-pad-scrolled the same
 * way, but a game controller can still navigate it, so the same shape is used there too.
 */
export const ReadOnlyRow = ({ children }: { children: React.ReactNode; key?: string | number }) => (
  <Field focusable={true} bottomSeparator="none" childrenLayout="below" childrenContainerWidth="max">
    {children}
  </Field>
)

export interface Row {
  steamAppId: number
  gameId: string
  name: string
  desired: string
  appliedAt: string | null
  error: string | null
}

export interface Resolved {
  steamAppId: number
  desired: string
  changed: boolean
}

export interface LeaseWarning {
  gameName: string
  holderMachine: string
}

export interface AgentState {
  connected: boolean
  currentVersion: string
  machineName: string
  serverUrl: string
  gamesTracked: number
  savesBacked: number
  lastSyncAgo: string
  leaseWarnings: LeaseWarning[]
  /** This device's own machine id, once registered — null before then. Lets the conflict-policy
   * dropdown offer "prefer THIS device" without a fleet-wide machine list (only the dashboard has
   * one). */
  machineId: string | null
}

/**
 * `updateAvailable` and `stagedVersion` are different states and only one of them is actionable
 * from here.
 *
 * Available means the server is offering something newer and nothing has been downloaded: taking it
 * needs network, a download, a digest check and a smoke test, any of which can fail and all of which
 * take a while. Staged means the payload is already on this disk, verified against the published
 * SHA-256 and smoke-tested — applying it is a file copy and a restart, which works offline and
 * cannot fail for any of the reasons a download can.
 */
export interface AgentVersion {
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  stagedVersion: string | null
  /** Why restarting right now would install nothing. The agent's own sentence — show it verbatim. */
  stagedBlockedReason: string | null
}

export interface DoctorResult {
  exitCode: number
  output: string
}

export interface TrackedGame {
  gameId: string
  name: string
  saveDirectory: string
  /** Manual name-match override for Gaming Mode sync's fallback matcher — see `gamingSync.tsx`. */
  alias: string | null
  /** This game's resolved compatdata-prefix AppID, or null when it has none. NOT an "is this a
   * Steam Store game" signal — a non-Steam shortcut run under Proton gets its own compatdata prefix
   * too. Use `hasSteamCloud` for that question. */
  steamAppId: number | null
  /** Whether this title is known to have Steam Cloud saves (a Ludusavi-manifest lookup, resolved
   * server-side) — the signal `resolvePullEnabled` actually needs, independent of `steamAppId`. */
  hasSteamCloud: boolean
  /** Gaming Mode pre-launch-pull override: null means "use the computed default" — see
   * `gamingSync.tsx`'s `resolvePullEnabled`. */
  pullBeforeLaunchEnabled: boolean | null
}

/** What the agent's `SyncActivityTracker` reports right now, and its short rolling history — the
 * same feed the agent's own local web UI polls for its Overview page. */
export interface ActivitySnapshot {
  gameName: string | null
  phase: 'Idle' | 'Pulling' | 'Settling' | 'Pushing'
  bytesDone: number
  bytesTotal: number
  startedAtUtc: string | null
}

export interface ActivityLogEntry {
  timestampUtc: string
  message: string
}

export interface ActivityDto {
  current: ActivitySnapshot
  recent: ActivityLogEntry[]
}

export type AgentResult<T> = { ok: true; data: T } | { ok: false; reason: string }

// ----- Conflicts (tasks/conflict-resolution-ui/plan.md Phase 10) -----
//
// Mirrors the shape `agent-ui/src/types.ts` generates from the agent's own OpenAPI document —
// hand-written here because this plugin has no code-gen step of its own, but the field names and
// casing (camelCase, System.Text.Json's default) must match `AgentApiServer.cs`'s local routes
// exactly, the same contract agent-ui's `ConflictDto`/`SaveVersionDto`/`VersionStatsDto` types read.

export type ConflictPolicyKind = 'Manual' | 'NewestWins' | 'PreferMachine'

/** `versionAId` is always "the cloud" (the head this device diverged from), `versionBId` is always
 * this device's own diverged push — the comparison is never device vs. device (plan.md decision 2). */
export interface Conflict {
  id: string
  gameId: string
  versionAId: string
  versionBId: string
  status: 'Open' | 'Resolved'
  createdAt: string
  resolvedVersionId: string | null
  resolvedBy: string | null
  resolvedAt: string | null
  machineId: string | null
  count: number
  lastSeen: string | null
  escalated: boolean
}

export interface SaveVersion {
  id: string
  gameId: string
  machineId: string | null
  machineName: string
  createdAt: string
  contentHash: string
  size: number
  parentVersionId: string | null
  protected: boolean
}

export interface VersionStats {
  fileCount: number
  newestFileWriteUtc: string | null
}

export interface ConflictPolicySetting {
  policy: ConflictPolicyKind
  preferredMachineId: string | null
}

/** `GET /api/games/{id}/sync-status` (`SyncStatusDto` in `Contracts.cs`) — an on-demand, disk-cost
 * "am I actually in sync right now" check (Phase 12). Never poll this; see `fetchSyncStatus`'s own
 * call site in `fullPage.tsx` for the one place it's meant to be triggered from. */
export interface SyncStatus {
  inSync: boolean
  hasOpenConflict: boolean
  conflictId: string | null
}

export const fetchConflicts = callable<[], AgentResult<Conflict[]>>('conflicts')
export const fetchConflict = callable<[string], AgentResult<Conflict>>('conflict')
/** `winningVersionId` is one of the conflict's own `versionAId`/`versionBId` — the caller already
 * knows which side is "this device"'s. */
export const resolveConflict =
  callable<[string, string, boolean], AgentResult<null>>('resolve_conflict')
export const fetchConflictPolicy =
  callable<[string], AgentResult<ConflictPolicySetting>>('conflict_policy')
export const setConflictPolicy =
  callable<[string, ConflictPolicyKind, string | null], AgentResult<null>>('set_conflict_policy')
export const fetchSaveVersion = callable<[string], AgentResult<SaveVersion>>('save_version')
export const fetchVersionStats = callable<[string], AgentResult<VersionStats>>('version_stats')
export const fetchSyncStatus = callable<[string], AgentResult<SyncStatus>>('sync_status')

export const fetchRows = callable<[], AgentResult<Row[]>>('rows')
export const resolveOptions =
  callable<[{ steamAppId: number; current: string }[]], AgentResult<Resolved[]>>('resolve')
export const report = callable<[number, boolean, string | null], AgentResult<null>>('report')
export const fetchGames = callable<[], AgentResult<TrackedGame[]>>('games')
export const runSync = callable<[string, string | null, boolean], AgentResult<DoctorResult>>('sync')
export const fetchState = callable<[], AgentResult<AgentState>>('state')
export const fetchVersion = callable<[], AgentResult<AgentVersion>>('agent_version')
export const fetchActivity = callable<[], AgentResult<ActivityDto>>('activity')
export const runDoctor = callable<[], AgentResult<DoctorResult>>('doctor')
/** This plugin's own version (not the agent's) — see `main.py`'s `plugin_version`. */
export const fetchPluginVersion = callable<[], string>('plugin_version')

/**
 * A game's launch options as Steam holds them right now.
 *
 * `RegisterForAppDetails` is a subscription, not a getter, so this takes the first callback and
 * unregisters. The timeout matters: an AppID Steam does not know never calls back at all, and
 * without it the whole sweep would hang on one stale shortcut.
 *
 * A non-Steam shortcut keeps its options in `strShortcutLaunchOptions` while an installed Steam
 * game uses `strLaunchOptions`, and the first is the case SaveLocker exists for — so take whichever
 * is set rather than guessing which kind of app this is.
 */
function currentLaunchOptions(appId: number): Promise<string> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: string) => {
      if (settled) return
      settled = true
      try { registration?.unregister() } catch { /* already gone */ }
      resolve(value)
    }

    const registration = SteamClient.Apps.RegisterForAppDetails(appId, (details: any) => {
      finish(details?.strShortcutLaunchOptions || details?.strLaunchOptions || '')
    })

    setTimeout(() => finish(''), 4000)
  })
}

export interface Outcome {
  name: string
  state: 'written' | 'already-correct' | 'failed' | 'would-write'
  /** Exactly what was read out of Steam. Shown verbatim — it is the evidence, not a summary. */
  current: string
  target: string
  detail?: string
}

/**
 * One pass: read what Steam has, ask the agent what it should be, write only what differs.
 *
 * Writing only on `changed` is the whole safety story. `Row.desired` assumes a game with nothing
 * set; a user running mangohud, setting environment variables or passing per-game arguments has
 * something set, and the resolve round trip is what preserves it.
 */
export async function applyAll(write: boolean): Promise<{ outcomes: Outcome[]; problem?: string }> {
  const rows = await fetchRows()
  if (!rows.ok) return { outcomes: [], problem: rows.reason }
  if (rows.data.length === 0) return { outcomes: [] }

  const current = await Promise.all(
    rows.data.map(async (row) => ({
      steamAppId: row.steamAppId,
      current: await currentLaunchOptions(row.steamAppId),
    })),
  )
  const currentByAppId = new Map(current.map((c) => [c.steamAppId, c.current]))

  const resolved = await resolveOptions(current)
  if (!resolved.ok) return { outcomes: [], problem: resolved.reason }

  const byAppId = new Map(resolved.data.map((r) => [r.steamAppId, r]))
  const outcomes: Outcome[] = []

  for (const row of rows.data) {
    const target = byAppId.get(row.steamAppId)
    if (!target) continue
    const was = currentByAppId.get(row.steamAppId) ?? ''
    const base = { name: row.name, current: was, target: target.desired }

    if (!target.changed) {
      outcomes.push({ ...base, state: 'already-correct' })
      // Reported anyway: "already correct" is exactly as much of an answer to "are this game's
      // launch options set?" as having just written them, and doctor should be able to say so.
      // Not in dry run — nothing has been confirmed if nothing was allowed to act.
      if (write) await report(row.steamAppId, true, null)
      continue
    }

    // Dry run stops here, having read everything and changed nothing. This is the mode a first run
    // on real hardware wants: if the field this plugin reads is the wrong one, it sees an empty
    // string, concludes the game has no options, and would clobber a real mangohud line. Better to
    // be shown that in a list than to discover it afterwards.
    if (!write) {
      outcomes.push({ ...base, state: 'would-write' })
      continue
    }

    try {
      SteamClient.Apps.SetAppLaunchOptions(row.steamAppId, target.desired)
      outcomes.push({ ...base, state: 'written' })
      await report(row.steamAppId, true, null)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      outcomes.push({ ...base, state: 'failed', detail })
      await report(row.steamAppId, false, detail)
    }
  }

  return { outcomes }
}

export const shortState = (o: Outcome) =>
  o.state === 'written' ? 'set'
    : o.state === 'already-correct' ? 'ok'
      : o.state === 'would-write' ? 'would change'
        : 'failed'

/** One line the user can read at a glance, so the list below is detail rather than the answer. */
export function summarise(outcomes: Outcome[]): string {
  const n = (s: Outcome['state']) => outcomes.filter((o) => o.state === s).length
  const parts = [`${outcomes.length} game${outcomes.length === 1 ? '' : 's'}`]
  if (n('already-correct')) parts.push(`${n('already-correct')} already set`)
  if (n('would-write')) parts.push(`${n('would-write')} would change`)
  if (n('written')) parts.push(`${n('written')} set`)
  if (n('failed')) parts.push(`${n('failed')} failed`)
  return parts.join(' · ')
}

export function timeAgo(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
