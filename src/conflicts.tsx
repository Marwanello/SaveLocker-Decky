import { useEffect, useRef, useState } from 'react'
import { DialogButton, Focusable, ModalRoot, ToggleField, showModal } from '@decky/ui'
import { FaCloud, FaMobileAlt } from 'react-icons/fa'
import { gameIdToAppId } from './gamingSync'
import { getChip, setChip } from './syncStatus'
import { saveLockerToast } from './toast'
import {
  fetchConflict, fetchConflicts, fetchGames, fetchSaveVersion, fetchVersionStats, resolveConflict,
  type Conflict, type SaveVersion, type VersionStats,
} from './shared'

/**
 * The Decky-side conflict poller and resolve popup (tasks/conflict-resolution-ui/plan.md, Phase 10).
 *
 * A poller, structured (`GET /api/conflicts` via `main.py`'s `conflicts()`), never string-parsed CLI
 * output — a conflict is now a known fact, not something to infer from a sync's prose the way
 * `syncStatus.tsx`'s `classifySyncOutput` still has to for a plain push/pull result. Held at module
 * scope, same reasoning as `syncStatus.tsx`'s chip store and `gamingSync.tsx`'s caches: Steam remounts
 * `/library/app/:appid` from scratch on every navigation, and this needs to survive that, plus be
 * readable from both the QAM (`index.tsx`) and the library overlay (`libraryOverlay.tsx`) without
 * either owning it (owning it in either would make the pair circular, the same reason `syncStatus.tsx`
 * is its own leaf module).
 */

const CONFLICT_POLL_MS = 20_000

let openConflicts: Conflict[] = []
const listeners = new Set<(c: Conflict[]) => void>()
// Which games' chips this module last painted 'conflict' onto, so a conflict that closes since the
// last poll gets its chip CLEARED rather than left reading 'Conflict' forever — the poll only ever
// sees the current open set, never an explicit "this one just resolved" event.
let lastConflictGameIds = new Set<string>()

export function getOpenConflicts(): Conflict[] {
  return openConflicts
}

/** The already-known conflict for a game, if any — read from the poller's own warm cache, no
 * network call. `gamingSync.tsx`'s launch gate uses this for its "a conflict is already known"
 * carve-out (tasks/conflict-resolution-ui/plan.md, Phase 11): reusing this rather than attempting
 * another sync over the network the moment Play is pressed on a game already known to conflict. */
export function getOpenConflictForGame(gameId: string): Conflict | null {
  return openConflicts.find((c) => c.gameId === gameId) ?? null
}

/** Subscribes a component to the shared conflict list — mirrors `syncStatus.tsx`'s `useSyncChip`. */
export function useOpenConflicts(): Conflict[] {
  const [state, setState] = useState<Conflict[]>(openConflicts)
  useEffect(() => {
    setState(openConflicts)
    listeners.add(setState)
    return () => { listeners.delete(setState) }
  }, [])
  return state
}

/**
 * Paints/clears the 'conflict' chip on each affected game's library page, keyed off `gameIdToAppId`
 * so this only touches AppIDs that actually have a page to show a chip on. Never clobbers an
 * actively-'syncing' chip — a pull/push in flight is a more urgent, more current fact than "this game
 * also has an open conflict," and stomping it would make an in-progress sync look stuck.
 */
function mergeConflictChips(conflicts: Conflict[]): void {
  const gameIds = new Set(conflicts.map((c) => c.gameId))

  for (const gameId of lastConflictGameIds) {
    if (gameIds.has(gameId)) continue
    const appId = gameIdToAppId(gameId)
    if (appId === null) continue
    if (getChip(appId)?.kind === 'conflict') setChip(appId, null)
  }

  for (const gameId of gameIds) {
    const appId = gameIdToAppId(gameId)
    if (appId === null) continue
    const current = getChip(appId)
    if (current?.kind === 'syncing') continue
    if (current?.kind === 'conflict') continue // already painted; don't reset its `at` every poll
    setChip(appId, { kind: 'conflict', text: 'Conflict', pct: null, at: Date.now() })
  }

  lastConflictGameIds = gameIds
}

let pollTimer: ReturnType<typeof setInterval> | null = null
let polling = false

async function poll(): Promise<void> {
  if (polling) return
  polling = true
  try {
    const r = await fetchConflicts()
    if (r.ok) {
      openConflicts = r.data
      mergeConflictChips(openConflicts)
      listeners.forEach((cb) => cb(openConflicts))
    }
  } finally {
    polling = false
  }
}

/** Called once from `definePlugin`'s setup, mirroring `registerGamingModeSync`/
 * `registerLibraryOverlay` — live for the plugin's whole lifetime, not just while a component that
 * cares is mounted, so a conflict found while no relevant page is open still lights up the QAM badge
 * the moment one opens. */
export function registerConflictPolling(): void {
  if (pollTimer) return
  void poll()
  pollTimer = setInterval(() => void poll(), CONFLICT_POLL_MS)
}

export function unregisterConflictPolling(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  openConflicts = []
  lastConflictGameIds = new Set()
}

/** Forces the next poll to run immediately rather than waiting out the interval — called right after
 * a resolve so the badge/chip/panel clear without a stale read in between. */
export function refreshConflictsSoon(): void {
  void poll()
}

// ----- Resolve popup -----

const asUtc = (t: string) => (/[Z+]|-\d\d:\d\d$/.test(t) ? t : t + 'Z')

function relative(iso: string): string {
  const ms = Date.now() - new Date(asUtc(iso)).getTime()
  const mins = Math.round(ms / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

interface Side {
  kind: 'cloud' | 'local'
  versionId: string
  version?: SaveVersion
  stats?: VersionStats
}

/** What the popup closed with, for `gamingSync.tsx`'s launch gate to act on:
 *  - `resolved` — a side was chosen; the conflict is gone server-side.
 *  - `playAnyway` — the player chose to launch without resolving (only offered when `showPlayAnyway`
 *    is set); the conflict is still open server-side.
 *  - `cancelled` — backed out via B/backdrop dismiss without choosing either. "(B) Decide later —
 *    don't launch yet" in the plan's own mockup means exactly that.
 * `resolved` and `playAnyway` both mean "go ahead and launch now"; only `cancelled` means stay
 * blocked — see both call sites' `if (outcome !== 'cancelled')` checks. */
export type ConflictModalOutcome = 'resolved' | 'playAnyway' | 'cancelled'

/**
 * Big Picture-styled resolve popup — `Focusable` cards, D-pad left/right between them, A (via
 * `DialogButton`/`onActivate`) to pick a side, B backs out via `ModalRoot`'s own cancel handling
 * without resolving anything. Copy and layout follow plan.md's mockup verbatim: local vs. cloud,
 * never machine vs. machine (decision 2) — the cloud side is always "The Cloud," whichever machine
 * last updated it is supporting context only (`from "X"`), same framing as the dashboard/agent-ui
 * card this deliberately mirrors without literally sharing the component (Decky's D-pad-navigable
 * `Focusable` tree and the web card's plain clickable divs are not the same shape).
 *
 * Resolves immediately on a side being chosen (`agent-ui`'s `ConflictCard` `'immediate'` mode) rather
 * than a separate confirm step — this is a "decide now so the game/session can move on" surface, not
 * a page to review at leisure the way `agent-ui`'s own Conflicts list is.
 *
 * `showPlayAnyway` (Bug 1 fix) adds a third option beside the two "Keep X" cards: launch right now
 * without resolving anything, leaving the conflict open. Only meaningful when this popup was raised
 * by pressing Play with a launch still cancelled and waiting on this decision — a page-open or
 * already-running-game trigger has no pending launch to proceed with, so those callers omit it.
 *
 * `onClosed` (Phase 11) fires exactly once, on unmount, with the outcome above. A ref (not state
 * captured directly) because the unmount cleanup below runs once, reading whatever the ref was LAST
 * set to at the moment of the action, not whatever it was when the effect was set up.
 */
function ConflictResolveModal({ conflict, closeModal, onClosed, showPlayAnyway }: {
  conflict: Conflict
  closeModal?: () => void
  onClosed?: (outcome: ConflictModalOutcome) => void
  showPlayAnyway?: boolean
}) {
  const [gameName, setGameName] = useState(conflict.gameId)
  const [versionA, setVersionA] = useState<SaveVersion | undefined>()
  const [versionB, setVersionB] = useState<SaveVersion | undefined>()
  const [statsA, setStatsA] = useState<VersionStats | undefined>()
  const [statsB, setStatsB] = useState<VersionStats | undefined>()
  const [keepBoth, setKeepBoth] = useState(false)
  const [resolving, setResolving] = useState(false)
  const [done, setDone] = useState(false)
  const outcomeRef = useRef<ConflictModalOutcome>('cancelled')
  useEffect(() => () => onClosed?.(outcomeRef.current), [])

  useEffect(() => {
    // Guards every setter below: the player can back out (B/backdrop) while any of these five fetches
    // are still in flight, and this component will already be unmounted by the time they resolve.
    let cancelled = false
    void fetchGames().then((r) => {
      if (cancelled || !r.ok) return
      const g = r.data.find((g) => g.gameId === conflict.gameId)
      if (g) setGameName(g.alias ?? g.name)
    })
    void fetchSaveVersion(conflict.versionAId).then((r) => { if (!cancelled && r.ok) setVersionA(r.data) })
    void fetchSaveVersion(conflict.versionBId).then((r) => { if (!cancelled && r.ok) setVersionB(r.data) })
    void fetchVersionStats(conflict.versionAId).then((r) => { if (!cancelled && r.ok) setStatsA(r.data) })
    void fetchVersionStats(conflict.versionBId).then((r) => { if (!cancelled && r.ok) setStatsB(r.data) })
    return () => { cancelled = true }
  }, [conflict.id])

  const resolve = async (winningVersionId: string) => {
    if (resolving || done) return
    setResolving(true)
    try {
      const r = await resolveConflict(conflict.id, winningVersionId, keepBoth)
      if (r.ok) {
        outcomeRef.current = 'resolved'
        setDone(true)
        saveLockerToast('success', `${gameName} — conflict resolved`)
        refreshConflictsSoon()
        setTimeout(() => closeModal?.(), 900)
      } else {
        saveLockerToast('blocked', `Could not resolve ${gameName}'s conflict`, r.reason)
      }
    } catch {
      // A transport-layer rejection, not a `{ok:false}` resolution — without this, the button just
      // re-enables (via `finally` below) with no explanation at all, which reads as broken since
      // there's no console visible in Big Picture/Gaming Mode to show what actually happened.
      saveLockerToast('blocked', `Could not resolve ${gameName}'s conflict`, 'unexpected error')
    } finally {
      setResolving(false)
    }
  }

  // No server call — the conflict stays open. Sets the outcome ref directly and closes; the unmount
  // cleanup above reads whatever the ref was last set to, same as `resolve` does on success.
  const playAnyway = () => {
    if (resolving || done) return
    outcomeRef.current = 'playAnyway'
    closeModal?.()
  }

  if (done) {
    return (
      <ModalRoot closeModal={closeModal} onCancel={closeModal} bDisableBackgroundDismiss bHideCloseIcon>
        <div style={{ padding: '20px', fontSize: '14px' }}>
          <div style={{ fontWeight: 700, marginBottom: '8px' }}>{gameName}</div>
          <div style={{ opacity: 0.75 }}>Syncing your choice…</div>
        </div>
      </ModalRoot>
    )
  }

  const newerId = versionA && versionB
    ? (new Date(asUtc(versionA.createdAt)) > new Date(asUtc(versionB.createdAt))
      ? conflict.versionAId : conflict.versionBId)
    : null

  const sides: Side[] = [
    { kind: 'local', versionId: conflict.versionBId, version: versionB, stats: statsB },
    { kind: 'cloud', versionId: conflict.versionAId, version: versionA, stats: statsA },
  ]

  return (
    <ModalRoot closeModal={closeModal} onCancel={closeModal}>
      <div style={{ padding: '20px', maxWidth: '640px' }}>
        <div style={{ fontSize: '16px', fontWeight: 700, marginBottom: '8px' }}>
          {gameName} — your save and the cloud have both changed
        </div>
        <div style={{ fontSize: '13px', opacity: 0.75, lineHeight: 1.5, marginBottom: '16px' }}>
          You (and another device) both played this since you last synced. Pick which save to keep —
          the other one is never deleted right now, just set aside.
        </div>

        {conflict.escalated && (
          <div style={{ color: '#e5534b', fontSize: '12px', fontWeight: 600, marginBottom: '12px' }}>
            Overdue — this conflict has been unresolved for more than six hours.
          </div>
        )}

        <Focusable style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }} flow-children="right">
          {sides.map((side) => {
            const label = side.kind === 'cloud' ? 'The Cloud' : 'This Device'
            const Icon = side.kind === 'cloud' ? FaCloud : FaMobileAlt
            const v = side.version
            const caption = !v ? null
              : side.kind === 'local' ? "This is the device you're using right now."
                : `from "${v.machineName}"`

            return (
              <Focusable
                key={side.versionId}
                style={{
                  flex: '1 1 220px', minWidth: 220,
                  background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: '8px', padding: '14px',
                }}
                onActivate={() => void resolve(side.versionId)}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                  <Icon style={{ fontSize: '13px', opacity: 0.85 }} />
                  <span style={{ fontWeight: 700, fontSize: '13px' }}>{label}</span>
                  {newerId === side.versionId && (
                    <span style={{
                      fontSize: '9.5px', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
                      color: '#16b992', background: 'rgba(18,146,113,0.15)', borderRadius: '10px', padding: '1px 6px',
                    }}
                    >
                      newer
                    </span>
                  )}
                </div>
                <div style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: '15px', marginBottom: '4px' }}>
                  {v ? relative(v.createdAt) : '…'}
                </div>
                {v && (
                  <div style={{ fontSize: '11px', opacity: 0.7, marginBottom: '6px' }}>
                    {side.stats ? `${side.stats.fileCount} file${side.stats.fileCount === 1 ? '' : 's'} · ` : ''}
                    {fmtSize(v.size)}
                  </div>
                )}
                {caption && <div style={{ fontSize: '10.5px', opacity: 0.55, marginBottom: '10px' }}>{caption}</div>}
                <DialogButton
                  disabled={resolving}
                  onClick={() => void resolve(side.versionId)}
                  style={{ width: '100%', padding: '8px' }}
                >
                  Keep {label}
                </DialogButton>
              </Focusable>
            )
          })}
        </Focusable>

        <div style={{ marginTop: '16px' }}>
          <ToggleField
            label="Also keep the other one as a backup"
            description="Never auto-deleted — downloadable and restorable later from the dashboard."
            checked={keepBoth}
            disabled={resolving}
            onChange={setKeepBoth}
          />
        </div>

        {showPlayAnyway && (
          <div style={{ marginTop: '14px', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '14px' }}>
            <DialogButton disabled={resolving} onClick={playAnyway} style={{ width: '100%', padding: '8px' }}>
              Play Anyway
            </DialogButton>
            <div style={{ fontSize: '10.5px', opacity: 0.55, marginTop: '6px', textAlign: 'center' }}>
              Launches with this device's current save, unresolved — you can pick a side later.
            </div>
          </div>
        )}
      </div>
    </ModalRoot>
  )
}

/**
 * `opts.onClosed` (Phase 11) is how `gamingSync.tsx`'s launch gate learns whether to relaunch the
 * game it cancelled to show this popup — see `ConflictResolveModal`'s own doc comment.
 *
 * Falls back to a direct `fetchConflict` when the id isn't in the polled cache yet: the launch gate
 * hands over a conflict id `pre_launch_sync` just discovered, which can be newer than the poller's
 * last 20s tick. The caller already knows the id is real (the agent just returned it), so silently
 * doing nothing here would strand it — better to pay for one fetch than show no popup at all.
 */
export function openConflictResolveModal(
  conflictId: string,
  opts: { onClosed?: (outcome: ConflictModalOutcome) => void; showPlayAnyway?: boolean } = {},
): void {
  const cached = openConflicts.find((c) => c.id === conflictId)
  if (cached) {
    showModal(
      <ConflictResolveModal conflict={cached} onClosed={opts.onClosed} showPlayAnyway={opts.showPlayAnyway} />,
    )
    return
  }
  void fetchConflict(conflictId).then((r) => {
    if (r.ok) {
      showModal(
        <ConflictResolveModal conflict={r.data} onClosed={opts.onClosed} showPlayAnyway={opts.showPlayAnyway} />,
      )
    } else opts.onClosed?.('cancelled')
  }).catch(() => {
    // A transport-layer rejection, not a `{ok:false}` resolution — without this, a caller waiting on
    // `onClosed` (e.g. `gamingSync.tsx`'s launch gate) never hears back at all, stranding whatever it
    // was waiting to resolve (a cancelled launch, a frozen process) with no popup and no way out.
    opts.onClosed?.('cancelled')
  })
}
