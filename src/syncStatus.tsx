import { useEffect, useState } from 'react'
import type { ToastKind } from './toast'

/**
 * Where "what is this game's save doing right now" lives, independent of any component.
 *
 * The status chip on a game's library page used to hold its state in `OverlayButtons`'s own
 * `useState`, which meant it was destroyed by exactly the events it most needed to survive: Steam
 * remounts `/library/app/:appid` from scratch every time you navigate to it, so playing a game and
 * coming back showed an empty chip even though a pull AND a post-play push had just run for it. This
 * module holds that state at module scope instead — the same reasoning as `gamingSync.tsx`'s
 * `trackedLaunches`, and with the same accepted limitation: a Decky/plugin reload clears it, since
 * none of this is worth persisting to disk.
 *
 * It also lets `gamingSync.tsx` (which has no UI of its own) report into the chip — the post-play
 * push happens while no library page is mounted at all, and its result should be waiting on the chip
 * when the user navigates back. That is also why this is its own leaf module rather than living in
 * `gamingSync.tsx` or `libraryOverlay.tsx`: both of those import it, and either of them owning it
 * would make the pair circular.
 */

/** A pull/push result as the plugin's Python backend hands it back. Structurally identical to
 * `gamingSync.tsx`'s `Result<{ exitCode, output }>`; defined here so this module stays a leaf. */
export type SyncResult =
  | { ok: true; data: { exitCode: number; output: string } }
  | { ok: false; reason: string }

export type SyncOutcome = 'changed' | 'up-to-date' | 'blocked'

/**
 * What actually happened, read out of the CLI's own words rather than its exit code — `pull`/`push`
 * both exit 0 for nearly every outcome including refusals (AgentCli.cs's `pull`/`push` cases never
 * inspect `SyncEngine`'s return value; only an unhandled exception produces a non-zero exit), so exit
 * code alone cannot tell "nothing needed to happen" from "this was refused" from "this actually ran".
 *
 * The agent already hash-diffs before every pull and push — `SyncEngine.cs` compares
 * `SaveArchive.HashDirectory(...)` against the server's head hash for pull, against `LastSyncedHash`
 * for push — and prints one of a small set of stable phrases depending on the outcome. This reads
 * those phrases back out of the captured output instead of re-implementing the comparison client-side
 * (which would need the plugin to read save files directly, something only the agent does today).
 */
export function classifySyncOutput(action: 'pull' | 'push', output: string): SyncOutcome {
  const text = output.toLowerCase()
  // "Changed" checked before "up to date": `target: null` (index.tsx's "all games") runs every game
  // through one CLI call, so `output` can contain one game's "already up to date" alongside another's
  // "restored latest save" in the same string — if anything at all changed, that is the more useful
  // summary than reporting the whole batch as untouched just because a substring for it exists too.
  if (action === 'pull') {
    if (text.includes('restored latest save')) return 'changed'
    if (text.includes('already up to date') || text.includes('nothing to pull')) return 'up-to-date'
  } else {
    if (text.includes('pushed new version')) return 'changed'
    if (text.includes('no local changes since last sync') || text.includes('server already had this content')) {
      return 'up-to-date'
    }
  }
  // Every refusal (game running, unsynced local changes, conflict, unsafe archive, lock contention)
  // exits 0 too and prints its own distinct phrase — rather than matching each one individually, and
  // needing an update here every time the agent's wording changes, anything that isn't recognizably
  // "nothing changed" or "changed" is treated as blocked: a 0 exit code is not evidence nothing went
  // wrong, so the safe default when unsure is to say so rather than claim success.
  return 'blocked'
}

/** `at` is when this status was established, so the chip can say "up to date" without implying it
 * was checked this second — see `SyncChip`'s relative-age suffix in `libraryOverlay.tsx`. */
export interface ChipState {
  kind: ToastKind
  text: string
  pct: number | null
  reason?: string
  at: number
}

/** Reads a pull/push result into chip state. Deliberately separate from `reportSyncOutcome`'s toast
 * (rather than having that function return something) because a toast and a chip disagree about how
 * long an answer should live: the toast fades, the chip stays as the current status. */
export function outcomeChip(action: 'pull' | 'push', r: SyncResult): ChipState {
  const at = Date.now()
  if (!r.ok) return { kind: 'blocked', text: 'Blocked', pct: null, reason: r.reason, at }
  const outcome = classifySyncOutput(action, r.data.output)
  if (outcome === 'changed') {
    return { kind: 'success', text: action === 'pull' ? 'Pulled' : 'Pushed', pct: null, at }
  }
  if (outcome === 'up-to-date') return { kind: 'info', text: 'Up to date', pct: null, at }
  const reason = r.data.output.split('\n').filter((l) => l.trim() !== '').pop() ?? `exit ${r.data.exitCode}`
  return { kind: 'blocked', text: 'Blocked', pct: null, reason, at }
}

const chips = new Map<number, ChipState>()
const listeners = new Map<number, Set<(s: ChipState | null) => void>>()

export function getChip(appId: number): ChipState | null {
  return chips.get(appId) ?? null
}

export function setChip(appId: number, state: ChipState | null): void {
  if (state === null) chips.delete(appId)
  else chips.set(appId, state)
  listeners.get(appId)?.forEach((cb) => cb(state))
}

/** Subscribes a mounted chip to updates written from anywhere — including from `gamingSync.tsx`
 * while the game is launching, so a pull kicked off by pressing Play is reflected on the page the
 * user is still looking at rather than only in a toast. */
export function useSyncChip(appId: number): ChipState | null {
  const [state, setState] = useState<ChipState | null>(() => getChip(appId))

  useEffect(() => {
    setState(getChip(appId))
    const set = listeners.get(appId) ?? new Set()
    listeners.set(appId, set)
    set.add(setState)
    return () => {
      set.delete(setState)
      if (set.size === 0) listeners.delete(appId)
    }
  }, [appId])

  return state
}

// steamAppId -> when a page-open pull last COMPLETED for it. Read by two different decisions, which
// is why it is a timestamp rather than the "have we done this once" Set it replaced:
//
//  - `libraryOverlay.tsx` re-pulls on page open only if the last one is older than
//    `PAGE_OPEN_REPULL_MS`. The Set meant a page-open pull happened at most ONCE per plugin session:
//    open a game, play it, come back, and no pull ran — which is exactly the window where the save
//    most likely changed (this device just pushed, or another device did).
//  - `gamingSync.tsx` skips the pre-launch pull entirely when a page-open pull is still fresh, since
//    the whole point of pulling on page open is that the save is already current by the time Play is
//    pressed.
const lastPageOpenPull = new Map<number, number>()

/** How long a page-open pull is considered to still represent "current". Deliberately generous
 * (the common path is opening a page and pressing Play seconds later) but bounded: leaving a game's
 * page open for an afternoon and then launching should re-check rather than trust a stale pull. */
const PAGE_OPEN_PULL_FRESH_MS = 10 * 60 * 1000
/** How long before opening the page again re-pulls. Short enough that returning after a play session
 * always re-checks, long enough that flicking back and forth between two pages doesn't spam the
 * agent with pulls it will only answer "already up to date" to. */
const PAGE_OPEN_REPULL_MS = 60 * 1000

export function markPageOpenPull(appId: number): void {
  lastPageOpenPull.set(appId, Date.now())
}

/** Whether a page-open pull ran recently enough that pressing Play can trust it and skip its own. */
export function pageOpenPullIsFresh(appId: number): boolean {
  const at = lastPageOpenPull.get(appId)
  return at !== undefined && Date.now() - at < PAGE_OPEN_PULL_FRESH_MS
}

/** Whether opening this game's page again should run another pull. */
export function shouldRepullOnOpen(appId: number): boolean {
  const at = lastPageOpenPull.get(appId)
  return at === undefined || Date.now() - at > PAGE_OPEN_REPULL_MS
}
