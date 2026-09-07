import { useEffect, useState } from 'react'
import { afterPatch, appDetailsClasses, createReactTreePatcher, findInReactTree, Focusable } from '@decky/ui'
import { routerHook } from '@decky/api'
import { FaCloudDownloadAlt, FaCloudUploadAlt, FaSyncAlt } from 'react-icons/fa'
import {
  reportSyncOutcome, resolveMatchFresh, resolveMatchSync, resolvePullEnabled,
  resolveSyncOnOpenEnabled, runPull, runSyncForGaming,
} from './gamingSync'
import { openConflictResolveModal, useOpenConflicts } from './conflicts'
import { saveLockerToast, KIND_STYLE } from './toast'
import {
  classifySyncOutput, markPageOpenPull, setChip, shouldRepullOnOpen, useSyncChip,
  type ChipState, type SyncOutcome,
} from './syncStatus'
import { fetchActivity } from './shared'

/**
 * Pull/Push/Sync buttons floated onto Steam's own `/library/app/:appid` page, for an enrolled game
 * this session hasn't launched yet (or doesn't want to launch, just to check on) — the "sync it right
 * now, from the game's own page" counterpart to the automatic pre-launch pull in `gamingSync.tsx`.
 *
 * Steam's Big Picture UI is not a Decky-owned route, so there is no `routerHook.addRoute` for this —
 * `routerHook.addPatch` intercepts Steam's OWN render for that route instead. The two-step patch below
 * (`createReactTreePatcher` locating an "overview" node, then patching THAT node's own render) mirrors
 * the pattern real, shipped Decky plugins use for this exact route (SteamGridDB, Unifideck): patching
 * `renderFunc` directly and searching ITS immediate return value doesn't work, because that return
 * value is still a shallow, lazily-evaluated element tree — the `appDetailsClasses.InnerContainer`
 * marker this needs to anchor on only exists once React has actually rendered several components
 * deeper than that. Anchored on `InnerContainer`'s class name rather than any component's displayName,
 * since Steam mangles the latter in production builds.
 *
 * `OverlayHost` is always injected once an AppID is known, even before enrollment is resolved — it
 * used to be `OverlayButtons` gated directly behind `resolveMatchSync`, which meant a game that had
 * just been enrolled did not get buttons until the 2-minute background cache refresh happened to land
 * (or the plugin reloaded) to catch up, since `injectOverlayButtons` simply skipped unshifting
 * anything for it. `OverlayHost` instead always mounts and resolves for itself, paying for one fresh
 * round trip (`resolveMatchFresh`, rate-limited so flipping through unrelated library pages doesn't
 * hammer the agent) when the synchronous cache doesn't already know the answer.
 *
 * Rendered `position: fixed` rather than spliced into Steam's own flex layout, deliberately: the exact
 * pixel position below is unverified on hardware (flagged the same way `fullPage.tsx`'s
 * `marginTop: '40px'` is), but a `fixed` overlay only risks looking wrong, never breaking Steam's own
 * layout if `InnerContainer`'s structure shifts under it — the injection point only needs to exist,
 * not host the button in-flow the way a spliced sibling element would.
 */

/** How long ago this status was established, for the chip's own suffix. A bare "Up to date" with no
 * age is a claim about right now, which it isn't — it's a claim about the last time anything checked,
 * and on a page you may have left open for an hour that distinction matters. */
function ageSuffix(at: number): string {
  const seconds = Math.floor((Date.now() - at) / 1000)
  if (seconds < 45) return ''
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return ` · ${Math.max(1, minutes)}m ago`
  return ` · ${Math.floor(minutes / 60)}h ago`
}

/** The status/progress pill beside the buttons — same colored-circle language as `saveLockerToast`,
 * via the shared `KIND_STYLE` map, so the chip and the toast for the same event never disagree.
 * Clickable only in its 'conflict' state, straight into the resolve popup — every other state is
 * read-only status, not an action. */
function SyncChip({ state, onClick }: { state: ChipState | null; onClick?: () => void }) {
  // Re-renders on a slow tick purely so the relative age above stays honest on a page left open.
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30 * 1000)
    return () => clearInterval(t)
  }, [])

  if (!state) return null
  const { bg, fg, Icon } = KIND_STYLE[state.kind]
  const syncing = state.kind === 'syncing'
  const clickable = state.kind === 'conflict' && onClick !== undefined
  return (
    <div
      title={state.reason}
      onClick={clickable ? onClick : undefined}
      style={{
        display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0,
        background: bg, color: fg, borderRadius: '14px',
        padding: '6px 12px', fontSize: '13px', whiteSpace: 'nowrap',
        cursor: clickable ? 'pointer' : 'default',
      }}
    >
      <Icon style={{ fontSize: '12px' }} />
      <span>
        {state.text}
        {state.pct !== null ? ` ${state.pct}%` : ''}
        {syncing ? '' : ageSuffix(state.at)}
      </span>
    </div>
  )
}

/** Runs one leg of the combined "sync" button, classifying its outcome so `go()` below can decide
 * whether the two legs together should read as "up to date" or "synced" — the two individual toasts
 * for pull/push already go through `reportSyncOutcome`, which this deliberately does not call, since
 * a combined sync reports once for both legs, not twice. */
async function runLeg(action: 'pull' | 'push', gameName: string) {
  const r = await runSyncForGaming(action, gameName, false)
  const outcome: SyncOutcome = r.ok ? classifySyncOutput(action, r.data.output) : 'blocked'
  return { outcome, r }
}

function OverlayButtons({ appId, gameName }: { appId: number; gameName: string }) {
  const [busy, setBusy] = useState<'pull' | 'push' | 'sync' | null>(null)
  // From the shared module-scope store, not local state: Steam rebuilds this whole page on every
  // navigation to it, so component-local chip state was destroyed by exactly the thing it needed to
  // survive — playing a game and coming back showed an empty chip even though a pull and a post-play
  // push had both just run. `useSyncChip` also subscribes, so a pull started from the Play button
  // (in `gamingSync.tsx`, which has no UI) updates this chip live.
  const chip = useSyncChip(appId)
  // Which open conflict (if any) belongs to THIS game's own chip — `conflicts.tsx`'s chip-merge
  // already painted the chip 'conflict' by gameId -> appId, so the reverse lookup here just needs
  // this game's own id, which `resolveMatchSync` (synchronous, already-warm cache) already has.
  const conflicts = useOpenConflicts()
  const gameId = resolveMatchSync(appId)?.gameId
  const conflict = gameId ? conflicts.find((c) => c.gameId === gameId) : undefined

  // Polls `activity()` while a pull/push this component started is in flight, so the chip can show a
  // live percentage — only ever available for a push (the agent only reports byte progress on the
  // upload chunk loop; a pull gets the plain "Syncing…" label with no percent). Returns a stop
  // function rather than taking a signal, so callers can end it from a `.then()` without needing a
  // ref: the loop just checks a closed-over flag each tick instead.
  const trackProgress = (label: string) => {
    let stopped = false
    void (async () => {
      while (!stopped) {
        const a = await fetchActivity()
        if (stopped) return
        if (a.ok && a.data.current.gameName === gameName && a.data.current.phase !== 'Idle') {
          const c = a.data.current
          const pct = c.phase === 'Pushing' && c.bytesTotal > 0
            ? Math.min(100, Math.round((c.bytesDone / c.bytesTotal) * 100))
            : null
          setChip(appId, { kind: 'syncing', text: label, pct, at: Date.now() })
        }
        await new Promise((r) => setTimeout(r, 700))
      }
    })()
    return () => { stopped = true }
  }

  /**
   * The "sync on open" feature. Fires on each mount of this page (Steam remounts it fresh on every
   * navigation to `/library/app/:appid`), gated on both settings — pull-before-launch itself, and the
   * page-open sub-toggle (see `fullPage.tsx`'s conditional "Sync on page open" row).
   *
   * `shouldRepullOnOpen` replaced a plain "already done this appId once" Set, which was the bug
   * behind "the chip disappeared after playing and coming back, and nothing re-synced": that Set made
   * the page-open pull a once-per-plugin-session event, so the FIRST open of a game pulled and every
   * later open did nothing at all — including the open right after a play session, which is the one
   * most likely to need it. It is now a short time window instead, long enough that flicking between
   * two pages doesn't spam the agent, short enough that coming back from a game always re-checks.
   *
   * Re-checks `resolveMatchSync` rather than trusting the `gameName` prop, since the cache (and the
   * user's settings) may have changed since this element was injected.
   */
  useEffect(() => {
    if (!shouldRepullOnOpen(appId)) return
    const match = resolveMatchSync(appId)
    if (!match || !resolvePullEnabled(match) || !resolveSyncOnOpenEnabled(match.gameId)) return
    setChip(appId, { kind: 'syncing', text: 'Syncing…', pct: null, at: Date.now() })
    const stopTracking = trackProgress('Syncing…')
    void runPull(appId, match.name)
      .then((r) => {
        // Recorded whatever the outcome: `gamingSync.tsx`'s launch path reads this to decide whether
        // it can skip its own pre-launch pull, and a refusal is still a check that happened just now.
        markPageOpenPull(appId)
        // Quiet by design: the chip immediately above the Play button is already saying this, and the
        // user asked not to be toasted for a sync they can see. `reportSyncOutcome` still writes the
        // chip via `appId`.
        reportSyncOutcome('pull', match.name, r, { appId, quiet: true })
      })
      // A rejected pull (transport error) has nothing to report, but must still be caught so it isn't
      // an unhandled rejection — and `stopTracking` has to run either way (`.finally`), or the
      // `trackProgress` poll loop keeps running and the chip stays stuck on "Syncing…".
      .catch(() => { /* nothing to report; chip keeps its last state */ })
      .finally(() => stopTracking())
  }, [appId])

  const go = async (action: 'pull' | 'push' | 'sync') => {
    if (busy) return
    setBusy(action)
    // Held here (not scoped to each leg) so the `finally` can always stop the tracker — if a sync
    // call rejects, the explicit `stopTracking()` calls below are skipped, and without this net the
    // `trackProgress` poll loop would run forever and the chip would stay stuck on "Pulling…".
    let stopTracking: (() => void) | null = null
    try {
      if (action === 'sync') {
        setChip(appId, { kind: 'syncing', text: 'Pulling…', pct: null, at: Date.now() })
        stopTracking = trackProgress('Pulling…')
        const pull = await runLeg('pull', gameName)
        stopTracking(); stopTracking = null
        if (pull.outcome === 'blocked') {
          reportSyncOutcome('pull', gameName, pull.r, { appId })
          return
        }
        setChip(appId, { kind: 'syncing', text: 'Pushing…', pct: null, at: Date.now() })
        stopTracking = trackProgress('Pushing…')
        const push = await runLeg('push', gameName)
        stopTracking(); stopTracking = null
        if (push.outcome === 'blocked') {
          reportSyncOutcome('push', gameName, push.r, { appId })
          return
        }
        // A completed pull leg is as good a freshness signal as the page-open one: the launch path's
        // skip check only cares that SOMETHING pulled recently, not which surface asked for it.
        markPageOpenPull(appId)
        const bothUpToDate = pull.outcome === 'up-to-date' && push.outcome === 'up-to-date'
        saveLockerToast(
          bothUpToDate ? 'info' : 'success',
          bothUpToDate ? `${gameName} is up to date` : `Synced ${gameName}`,
        )
        setChip(appId, {
          kind: bothUpToDate ? 'info' : 'success',
          text: bothUpToDate ? 'Up to date' : 'Synced',
          pct: null,
          at: Date.now(),
        })
      } else {
        setChip(appId, {
          kind: 'syncing', text: action === 'pull' ? 'Pulling…' : 'Pushing…', pct: null, at: Date.now(),
        })
        stopTracking = trackProgress(action === 'pull' ? 'Pulling…' : 'Pushing…')
        const r = await runSyncForGaming(action, gameName, false)
        stopTracking(); stopTracking = null
        if (action === 'pull') markPageOpenPull(appId)
        reportSyncOutcome(action, gameName, r, { appId })
      }
    } finally {
      stopTracking?.()
      setBusy(null)
    }
  }

  const icon = (action: 'pull' | 'push' | 'sync', Icon: typeof FaSyncAlt, label: string) => (
    <Focusable
      style={{
        width: '36px',
        height: '36px',
        borderRadius: '50%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.55)',
        color: '#fff',
        fontSize: '15px',
        opacity: busy !== null && busy !== action ? 0.4 : 1,
      }}
      onActivate={() => void go(action)}
      onClick={() => void go(action)}
      title={label}
    >
      <Icon />
    </Focusable>
  )

  return (
    <Focusable
      style={{
        position: 'fixed',
        top: '52px',
        right: '48px',
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
      }}
    >
      <SyncChip state={chip} onClick={conflict ? () => openConflictResolveModal(conflict.id) : undefined} />
      {icon('pull', FaCloudDownloadAlt, 'Pull save')}
      {icon('push', FaCloudUploadAlt, 'Push save')}
      {icon('sync', FaSyncAlt, 'Sync save')}
    </Focusable>
  )
}

/**
 * Resolves enrollment for one library page and mounts `OverlayButtons` once it knows the answer.
 * Always injected (see the file-level doc comment above for why): a game enrolled moments before this
 * page opened still gets its buttons, at the cost of one rate-limited background check for a game
 * that turns out not to be enrolled at all.
 */
function OverlayHost({ appId }: { appId: number }) {
  const [match, setMatch] = useState(() => resolveMatchSync(appId))

  useEffect(() => {
    if (match) return
    let cancelled = false
    void resolveMatchFresh(appId).then((m) => { if (!cancelled) setMatch(m) })
    return () => { cancelled = true }
  }, [appId])

  if (!match) return null
  return <OverlayButtons appId={appId} gameName={match.name} />
}

function injectOverlayButtons(tree: any): void {
  const overviewNode = findInReactTree(tree, (x: any) => x?.props?.children?.props?.overview != null)
  const appId = overviewNode?.props?.children?.props?.overview?.appid
  if (typeof appId !== 'number') return

  const innerContainer = findInReactTree(
    tree,
    (x: any) =>
      Array.isArray(x?.props?.children) &&
      typeof x?.props?.className === 'string' &&
      appDetailsClasses?.InnerContainer != null &&
      x.props.className.includes(appDetailsClasses.InnerContainer),
  )
  if (!innerContainer) return

  const key = `savelocker-overlay-${appId}`
  const children = innerContainer.props.children as any[]
  if (children.some((c) => c?.key === key)) return // already injected on a prior render of this page

  children.unshift(<OverlayHost key={key} appId={appId} />)
}

let patch: ReturnType<typeof routerHook.addPatch> | null = null

/** Registers the page patch once. Returns nothing — call `unregisterLibraryOverlay()` from the
 * plugin's own `onDismount`, mirroring `routerHook.removeRoute` for the full-screen page, so a plugin
 * reload during development doesn't layer a second patch onto Steam's still-live `renderFunc`. */
export function registerLibraryOverlay(): void {
  if (patch) return

  patch = routerHook.addPatch('/library/app/:appid', (props: any) => {
    const routeProps = findInReactTree(props.children, (x: any) => x?.renderFunc != null)
    if (!routeProps || routeProps.renderFunc.__saveLockerPatched) return props

    const patchHandler = createReactTreePatcher(
      [(tree: any) => findInReactTree(tree, (x: any) => x?.props?.children?.props?.overview != null)?.props?.children],
      (_args: any[], ret: any) => {
        try {
          injectOverlayButtons(ret)
        } catch (err) {
          console.error('[SaveLocker] library overlay patch failed', err)
        }
        return ret
      },
    )
    afterPatch(routeProps, 'renderFunc', patchHandler)
    routeProps.renderFunc.__saveLockerPatched = true
    return props
  })
}

export function unregisterLibraryOverlay(): void {
  if (!patch) return
  routerHook.removePatch('/library/app/:appid', patch)
  patch = null
}
