import { useEffect, useRef, useState } from 'react'
import {
  ButtonItem, ConfirmModal, DialogButton, DropdownItem, Field, Focusable, ModalRoot, Navigation, PanelSection,
  PanelSectionRow, showModal, staticClasses,
} from '@decky/ui'
import { callable, definePlugin, routerHook, toaster, useQuickAccessVisible } from '@decky/api'
import { FaChevronRight, FaGamepad } from 'react-icons/fa'
import { GamingSyncToggle, registerGamingModeSync, setConflictHooks, unregisterGamingModeSync } from './gamingSync'
import { classifySyncOutput } from './syncStatus'
import { registerLibraryOverlay, unregisterLibraryOverlay } from './libraryOverlay'
import {
  getOpenConflictForGame, openConflictResolveModal, refreshConflictsSoon, registerConflictPolling,
  unregisterConflictPolling, useOpenConflicts,
} from './conflicts'
import { FullPage, SAVELOCKER_PAGE_ROUTE } from './fullPage'
import { openDlcHoldModal, useDlcHolds } from './dlcHolds'
import { openEmptiedHoldModal, useEmptiedHolds } from './emptiedHolds'
import { installStagedUpdate } from './stagedUpdate'
import { PlaythroughDropdown } from './playthroughs'
import { KIND_STYLE, saveLockerToast, type ToastKind } from './toast'
import {
  applyAll, fetchActivity, fetchGames, fetchState, fetchVersion, runDoctor, runSync, timeAgo,
  type ActivityDto, type AgentResult, type AgentState, type AgentVersion, type DoctorResult, type TrackedGame,
} from './shared'

/**
 * SaveLocker's Decky plugin — the Quick Access panel half. The full-screen settings page lives in
 * fullPage.tsx; types/callables/helpers both files need live in shared.tsx, not here — Decky's build
 * (`@decky/rollup`) requires this ENTRY file to have exactly one export, the plugin definition
 * itself (`output.exports: 'default'`), so nothing else may import a named export from this file.
 *
 * It sets the Steam launch options SaveLocker needs, which the agent cannot do itself: Steam holds
 * localconfig.vdf / shortcuts.vdf in memory and rewrites them on exit, so an agent-side edit is
 * discarded. This runs inside Steam's own JS context, so `SteamClient.Apps.SetAppLaunchOptions`
 * persists through Steam's normal path.
 *
 * It deliberately knows NOTHING about what a launch option should look like. It reads current
 * values out of Steam, asks the agent to merge them, and writes back what it is told. The rule
 * lives in the agent (`LaunchOptions.cs`), where it is tested without Steam or hardware, so the
 * command can change without a plugin release. See shared.tsx's `applyAll` for that whole pass.
 *
 * Panel layout (docs/tasks/qam-ui-redesign/mockup.html): a status hero that answers "is it working"
 * in one stop, then "Needs attention" only when something does (one row per item; its actions sit
 * behind the row in a dialog), then Sync (target, Sync now, last result, Advanced) and More. The
 * old panel stacked ~9 sections and ~20 focus stops, most of them per-item button pairs and raw
 * agent output; every one of those still exists, one press deeper.
 */

const dismissWarning = callable<[string], AgentResult<null>>('dismiss_warning')

/** A status dot in the toast palette — the hero, the attention rows, the library chip and the
 * toasts all say "conflict" or "blocked" in the same colour. */
function Dot({ kind }: { kind: ToastKind }) {
  return (
    <span style={{
      display: 'inline-block', flexShrink: 0, width: '9px', height: '9px', borderRadius: '50%',
      background: KIND_STYLE[kind].fg,
    }}
    />
  )
}

/**
 * One row that opens something: a dialog, a menu, the full page.
 *
 * A focusable `Field` rather than a button, because the row carries a label and a description and a
 * button cannot without looking like a wall of text — and a chevron says "this goes somewhere" the
 * way Steam's own settings rows do. `onActivate` is the gamepad's A, `onClick` a touch or mouse.
 */
function NavRow({ label, description, dot, onOpen, chevron = true }: {
  label: string
  description?: React.ReactNode
  dot?: ToastKind
  onOpen: () => void
  chevron?: boolean
}) {
  return (
    <PanelSectionRow>
      <Field
        focusable
        highlightOnFocus
        bottomSeparator="none"
        label={(
          <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {dot && <Dot kind={dot} />}
            {label}
          </span>
        )}
        description={description}
        childrenLayout="inline"
        childrenContainerWidth="min"
        onActivate={onOpen}
        onClick={onOpen}
      >
        {chevron && <FaChevronRight style={{ fontSize: '12px', color: '#8b929a' }} />}
      </Field>
    </PanelSectionRow>
  )
}

/** The plain dialog shell every QAM dialog below shares: title, one paragraph, then its controls. */
function QamDialog({ title, sub, closeModal, children }: {
  title: string
  sub?: React.ReactNode
  closeModal?: () => void
  children: React.ReactNode
}) {
  return (
    <ModalRoot closeModal={closeModal} onCancel={closeModal}>
      <div style={{ padding: '20px', maxWidth: '560px' }}>
        <div style={{ fontSize: '16px', fontWeight: 700, marginBottom: '8px' }}>{title}</div>
        {sub && <div style={{ fontSize: '13px', opacity: 0.75, lineHeight: 1.5, marginBottom: '16px' }}>{sub}</div>}
        {children}
      </div>
    </ModalRoot>
  )
}

/** The agent's own output, verbatim. Read-only and not a focus stop — the dialog's buttons are. */
function AgentOutput({ text }: { text: string }) {
  const lines = text.split('\n').filter((l) => l.trim() !== '').slice(-30)
  return (
    <div style={{
      background: 'rgba(0,0,0,0.35)', borderRadius: '2px', padding: '8px 10px', marginBottom: '16px',
      fontFamily: 'var(--font-mono, monospace)', fontSize: '12px', lineHeight: 1.45,
      whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    }}
    >
      {lines.length > 0 ? lines.join('\n') : '(no output)'}
    </div>
  )
}

/**
 * The sync in flight and the last one's result, held at MODULE scope with a listener set rather than
 * in component state.
 *
 * Opening Steam's dropdown tears down and rebuilds the Quick Access panel content, so anything held
 * in a component's state is destroyed by the very act of picking a target — measured on hardware:
 * the render immediately after a selection reports `games = 0`. Syncs now also start from dialogs,
 * which outlive the panel content that opened them. A module-level store survives both, and every
 * mounted panel instance re-renders from it. Same shape as conflicts.tsx's open-conflict store.
 */
interface SyncResult {
  label: string
  at: string
  kind: ToastKind
  summary: string
  output: string
}

interface SyncRun {
  /** The running action's label ("sync all games"), or null when idle. */
  busy: string | null
  last: SyncResult | null
  /** True while a staged update installs — the agent restarts underneath every other action. */
  installing: boolean
}

let syncRun: SyncRun = { busy: null, last: null, installing: false }
const syncListeners = new Set<(s: SyncRun) => void>()

function setSyncRun(patch: Partial<SyncRun>): void {
  syncRun = { ...syncRun, ...patch }
  for (const l of syncListeners) l(syncRun)
}

function useSyncRun(): SyncRun {
  const [state, setState] = useState(syncRun)
  useEffect(() => {
    syncListeners.add(setState)
    setState(syncRun)
    return () => { syncListeners.delete(setState) }
  }, [])
  return state
}

/** The sync target (a game name, or null for all games) — module scope for the same remount reason. */
const ALL_GAMES = '__all_games__'
let stickyTarget: string | null = null

function problemText(reason: string): string {
  return reason === 'no-agent' ? 'SaveLocker is not installed on this device.'
    : reason === 'timeout' ? 'The sync did not finish within 10 minutes.'
      : `Could not run it (${reason}).`
}

/**
 * Push, pull, or both, for one game or all of them.
 *
 * The plain actions cannot lose data — the agent refuses a pull while the game is running, refuses
 * one that would overwrite un-pushed local changes, and turns a diverged push into a conflict rather
 * than overwriting the server. `force` defeats the middle two and is only ever reached through
 * `confirmForce`'s dialog, which names the game and says what is lost.
 *
 * "sync" is pull then push, back to back. Both legs are independently safe, so a refused pull does
 * not stop the push: they're reported together, not gated on each other.
 *
 * Exit codes lie — the CLI exits 0 for up-to-date, refused and blocked alike — so the toast and the
 * result row are classified from the agent's own words (`classifySyncOutput`). `force` skips the
 * agent's hash diff and always writes, so the up-to-date distinction only applies to a plain run.
 */
async function runSyncAction(action: 'sync' | 'push' | 'pull', target: string | null, force: boolean, onStarted: () => void) {
  if (syncRun.busy) return
  const targetName = target ?? 'all games'
  const label = `${force ? 'force ' : ''}${action} ${targetName}`
  setSyncRun({ busy: label })
  onStarted()
  const finish = (kind: ToastKind, summary: string, output: string, toastBody: string) => {
    setSyncRun({ last: { label, at: new Date().toISOString(), kind, summary, output } })
    saveLockerToast(kind, toastBody)
  }
  try {
    if (action === 'sync') {
      const pull = await runSync('pull', target, false)
      onStarted() // the push leg starts its own activity phase, worth its own poke
      const push = await runSync('push', target, false)
      if (!pull.ok && !push.ok) {
        finish('error', problemText(pull.reason), problemText(pull.reason), `Could not ${label}`)
        return
      }
      const output = [
        pull.ok ? `pull: exit ${pull.data.exitCode}` : `pull: could not run (${pull.reason})`,
        pull.ok ? pull.data.output : '',
        push.ok ? `push: exit ${push.data.exitCode}` : `push: could not run (${push.reason})`,
        push.ok ? push.data.output : '',
      ].filter((l) => l.trim() !== '').join('\n')
      // "Changed" wins over "up to date" if either leg did real work — one leg doing something is
      // the more useful headline than the other leg having nothing to do.
      const pullOutcome = pull.ok ? classifySyncOutput('pull', pull.data.output) : 'blocked'
      const pushOutcome = push.ok ? classifySyncOutput('push', push.data.output) : 'blocked'
      if (pullOutcome === 'blocked' || pushOutcome === 'blocked') {
        finish('blocked', 'Finished with issues', output, `${label} finished with issues — see Last sync`)
      } else if (pullOutcome === 'up-to-date' && pushOutcome === 'up-to-date') {
        finish('info', 'Already up to date', output, `${targetName} is already up to date`)
      } else {
        finish('success', 'Synced', output, `${label} finished`)
      }
      return
    }

    const r = await runSync(action, target, force)
    if (!r.ok) {
      finish('error', problemText(r.reason), problemText(r.reason), `Could not ${label}`)
      return
    }
    const outcome = force ? null : classifySyncOutput(action, r.data.output)
    if (outcome === 'blocked') finish('blocked', 'Blocked', r.data.output, `${label} was blocked — see Last sync`)
    else if (outcome === 'up-to-date') finish('info', 'Already up to date', r.data.output, `${targetName} is already up to date`)
    else finish('success', r.data.exitCode === 0 ? 'Done' : `Exited ${r.data.exitCode}`, r.data.output, `${label} finished`)
  } finally {
    setSyncRun({ busy: null })
  }
}

function confirmForce(action: 'push' | 'pull', target: string | null, onStarted: () => void) {
  const targetName = target ?? 'all games'
  const consequence = action === 'push'
    ? `This replaces the server's copy for ${targetName} with this device's save. Every other machine will pull it.`
    : `This discards this device's save for ${targetName} and takes the server's copy. Unsynced progress here is lost.`
  showModal(
    <ConfirmModal
      bDestructiveWarning
      strTitle={`Force ${action} ${targetName}?`}
      strDescription={consequence}
      strOKButtonText={`Force ${action}`}
      onOK={() => void runSyncAction(action, target, true, onStarted)}
    />,
  )
}

/** "Advanced" — the one-direction and force actions, one press below the panel's single Sync now. */
function SyncOptionsModal({ target, game, onStarted, onSwitched, closeModal }: {
  target: string | null
  game: TrackedGame | null
  onStarted: () => void
  onSwitched: () => void
  closeModal?: () => void
}) {
  const run = (action: 'sync' | 'push' | 'pull') => {
    closeModal?.()
    void runSyncAction(action, target, false, onStarted)
  }
  // Close first, then open the confirmation: two stacked modals leave the first one's focus
  // handling and backdrop in the way (same reason conflicts.tsx closes before resolving).
  const force = (action: 'push' | 'pull') => {
    closeModal?.()
    confirmForce(action, target, onStarted)
  }
  const half = { flex: 1, minWidth: 0 } as const
  return (
    <QamDialog title="Sync options" sub={target ?? 'All games'} closeModal={closeModal}>
      <Focusable style={{ display: 'flex', flexDirection: 'column', gap: '10px' }} flow-children="down">
        <PlaythroughDropdown game={game} count={game?.playthroughCount} onChanged={onSwitched} />
        <DialogButton onClick={() => run('sync')}>Sync now (pull, then push)</DialogButton>
        <Focusable style={{ display: 'flex', gap: '10px' }} flow-children="right">
          <DialogButton style={half} onClick={() => run('push')}>Push only</DialogButton>
          <DialogButton style={half} onClick={() => run('pull')}>Pull only</DialogButton>
        </Focusable>
        <div style={{ fontSize: '12px', opacity: 0.6, marginTop: '6px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Force — replaces one side completely
        </div>
        <Focusable style={{ display: 'flex', gap: '10px' }} flow-children="right">
          <DialogButton style={half} onClick={() => force('push')}>Force push…</DialogButton>
          <DialogButton style={half} onClick={() => force('pull')}>Force pull…</DialogButton>
        </Focusable>
        <DialogButton style={{ marginTop: '6px' }} onClick={closeModal}>Close</DialogButton>
      </Focusable>
    </QamDialog>
  )
}

/** The last sync's verbatim output: a refusal explains itself ("X is running — pull refused"), and
 * paraphrasing that would lose the reason. */
function LastSyncModal({ result, closeModal }: { result: SyncResult; closeModal?: () => void }) {
  return (
    <QamDialog title="Last sync" sub={`${result.label} · ${timeAgo(result.at)} · ${result.summary}`} closeModal={closeModal}>
      <AgentOutput text={result.output} />
      <DialogButton onClick={closeModal}>Close</DialogButton>
    </QamDialog>
  )
}

/** "Your other machine has this game checked out." Dismiss clears the notice, not the condition —
 * if the lease is still held the agent records it again. That is right: the warning exists to be
 * seen before launching. */
function LeaseModal({ gameName, holder, onDismiss, closeModal }: {
  gameName: string
  holder: string
  onDismiss: () => void
  closeModal?: () => void
}) {
  return (
    <QamDialog
      title={`Checked out elsewhere — ${gameName}`}
      sub={`Open on ${holder}. Playing here may cause a conflict. Dismissing only hides the notice — if the lease is still held, SaveLocker records it again.`}
      closeModal={closeModal}
    >
      <Focusable style={{ display: 'flex', gap: '10px' }} flow-children="right">
        <DialogButton style={{ flex: 1 }} onClick={() => { closeModal?.(); onDismiss() }}>Dismiss notice</DialogButton>
        <DialogButton style={{ flex: 1 }} onClick={closeModal}>Close</DialogButton>
      </Focusable>
    </QamDialog>
  )
}

/**
 * `savelocker doctor`, for the one state where the panel itself cannot help: the agent is not
 * answering. Runs once on open (that is what the row promises) and again only on request — it makes
 * network calls and takes seconds.
 */
function DoctorModal({ closeModal }: { closeModal?: () => void }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<DoctorResult | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const run = async () => {
    setBusy(true)
    setProblem(null)
    try {
      const r = await runDoctor()
      if (r.ok) setResult(r.data)
      else { setResult(null); setProblem(r.reason) }
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => { void run() }, [])

  return (
    <QamDialog
      title="Check this device"
      sub="SaveLocker's doctor looks at what the plugin cannot reach and says what is wrong."
      closeModal={closeModal}
    >
      {busy && <div style={{ fontSize: '13px', opacity: 0.75, marginBottom: '16px' }}>Running doctor…</div>}
      {!busy && problem && (
        <div style={{ fontSize: '13px', opacity: 0.75, marginBottom: '16px' }}>
          {problem === 'no-agent' ? 'SaveLocker is not installed on this device. Run install.sh from Desktop mode.'
            : problem === 'timeout' ? 'doctor did not finish within 60 seconds.'
              : `Could not run doctor (${problem}).`}
        </div>
      )}
      {!busy && result && <AgentOutput text={result.output} />}
      <Focusable style={{ display: 'flex', gap: '10px' }} flow-children="right">
        <DialogButton style={{ flex: 1 }} disabled={busy} onClick={() => void run()}>Run again</DialogButton>
        <DialogButton style={{ flex: 1 }} onClick={closeModal}>Close</DialogButton>
      </Focusable>
    </QamDialog>
  )
}

/**
 * "Install update now" — the only thing on a Deck that can take a waiting update without a terminal.
 * Only ever offered for `stagedVersion`: a merely-available update needs a network round trip that
 * can fail, while this one is a file copy the agent has already verified.
 *
 * The wait itself lives in `stagedUpdate.tsx`, shared with the full-screen page so the two surfaces
 * cannot disagree about what success looks like. The result is a toast because success REMOVES the
 * row it was started from (the staged marker is gone the moment the swap lands).
 */
function confirmInstall(version: AgentVersion, onSettled: () => void) {
  const staged = version.stagedVersion
  if (!staged) return
  showModal(
    <ConfirmModal
      strTitle={`Install v${staged} now?`}
      strDescription="It is already downloaded and verified. Installing restarts the agent — it takes a few seconds and no game is affected."
      strOKButtonText="Install now"
      strCancelButtonText="Later"
      onOK={() => {
        void (async () => {
          setSyncRun({ installing: true })
          try {
            const outcome = await installStagedUpdate(version.currentVersion)
            saveLockerToast(outcome.ok ? 'success' : 'error', outcome.text)
          } finally {
            setSyncRun({ installing: false })
            onSettled()
          }
        })()
      }}
    />,
  )
}

type Reach = { kind: 'loading' } | { kind: 'ok' } | { kind: 'down'; reason: string }

/**
 * The hero: the one always-on answer to "is SaveLocker working", above everything else.
 *
 * Exactly one state wins, in order: not reachable, syncing (the agent's own activity feed, or this
 * panel's own run before the agent reports it), not connected to the server, nothing tracked, fine.
 * One focusable block, same reason the old Status block was one: the QAM scrolls by moving focus,
 * and a non-focusable block at the top is a hole the D-pad cannot land in.
 */
function Hero({ reach, state, version, activity, busy, heroRef }: {
  heroRef: React.RefObject<HTMLDivElement | null>
  reach: Reach
  state: AgentState | null
  version: AgentVersion | null
  activity: ActivityDto | null
  busy: string | null
}) {
  const current = activity?.current
  const active = current && current.phase !== 'Idle' ? current : null
  // Byte progress only exists for a push (the agent reports it on the upload chunk loop) — pulling
  // and the post-game settle wait get an indeterminate bar rather than a fabricated percent.
  const pct = active && active.phase === 'Pushing' && active.bytesTotal > 0
    ? Math.min(100, Math.round((active.bytesDone / active.bytesTotal) * 100))
    : null

  let kind: ToastKind
  let headline: string
  let sub: string
  let bar = false
  if (reach.kind === 'loading') {
    kind = 'info'; headline = 'Checking SaveLocker…'; sub = 'Asking the agent on this device.'
  } else if (reach.kind === 'down' || !state) {
    kind = 'error'
    headline = 'SaveLocker is not responding'
    sub = reach.kind === 'down' && reach.reason === 'no-agent'
      ? 'SaveLocker is not installed on this device.'
      : 'The agent on this device is not reachable.'
  } else if (active || busy) {
    kind = 'syncing'
    bar = true
    headline = active ? `Syncing ${active.gameName ?? 'a game'}` : `Running ${busy}`
    sub = active ? `${active.phase.toLowerCase()}${pct !== null ? ` · ${pct}%` : ''}` : 'Starting…'
  } else if (!state.connected) {
    kind = 'blocked'
    headline = 'Not connected to the server'
    sub = `${state.gamesTracked} games · last sync ${state.lastSyncAgo}`
  } else if (state.gamesTracked === 0) {
    kind = 'info'
    headline = 'No games tracked yet'
    sub = 'Track games in the SaveLocker dashboard and they appear here.'
  } else {
    kind = 'success'
    headline = 'SaveLocker is running'
    sub = `${state.machineName} · ${state.gamesTracked} games · synced ${state.lastSyncAgo}`
  }

  // Available is not staged, and is not actionable from here (see AgentVersion's doc comment), so
  // it is a line in the hero rather than an attention row with nothing behind it.
  const available = reach.kind === 'ok' && version?.updateAvailable && !version.stagedVersion
    ? `Agent ${version.currentVersion} → ${version.latestVersion} available`
    : null

  return (
    <PanelSection>
      <PanelSectionRow>
        <Field
          ref={heroRef}
          focusable
          preferredFocus
          bottomSeparator="none"
          childrenLayout="below"
          childrenContainerWidth="max"
        >
          <div style={{ background: '#23262e', borderRadius: '2px', padding: '12px 14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '9px' }}>
              <Dot kind={kind} />
              <div style={{ flex: 1, fontSize: '16px', lineHeight: '21px', fontWeight: 700, color: '#fff' }}>{headline}</div>
            </div>
            <div style={{ fontSize: '12px', lineHeight: '16px', color: 'rgba(255,255,255,0.6)', marginTop: '3px' }}>{sub}</div>
            {available && (
              <div style={{ fontSize: '12px', lineHeight: '16px', color: 'rgba(255,255,255,0.6)', marginTop: '2px' }}>{available}</div>
            )}
            {bar && (
              <div style={{ marginTop: '9px', height: '4px', borderRadius: '2px', background: 'rgba(255,255,255,0.15)', overflow: 'hidden' }}>
                <div style={{
                  height: '100%', borderRadius: '2px', background: '#1a9fff',
                  width: pct !== null ? `${pct}%` : '35%', opacity: pct !== null ? 1 : 0.7,
                }}
                />
              </div>
            )}
          </div>
        </Field>
      </PanelSectionRow>
    </PanelSection>
  )
}

/**
 * Every time the panel opens, start at the top: focus on the hero, every scrollable ancestor at 0.
 *
 * Decky keeps this content mounted while the QAM is closed, and Steam restores focus to whatever
 * was focused last when the panel reopens — usually the bottom row, because "Settings and
 * diagnostics" is the last thing pressed before leaving. The panel then opened scrolled to its end
 * (reported on hardware). `preferredFocus` on the hero covers entry with no remembered focus; this
 * covers the restore. The focus move goes through the DOM — Steam's gamepad navigation follows
 * DOM focus — and the scroll reset runs again a frame and a beat later, because the restore that
 * it is undoing lands asynchronously after the visibility change.
 */
function resetQamToTop(hero: HTMLDivElement | null): void {
  if (!hero) return
  const target = hero.matches('[tabindex]') ? hero : hero.querySelector<HTMLElement>('[tabindex]')
  if (target && !target.contains(hero.ownerDocument.activeElement)) target.focus({ preventScroll: true })
  let node: Element | null = hero.parentElement
  while (node) {
    if (node.scrollHeight > node.clientHeight) node.scrollTop = 0
    node = node.parentElement
  }
}

function Content() {
  const [state, setState] = useState<AgentState | null>(null)
  const [reach, setReach] = useState<Reach>({ kind: 'loading' })
  const [version, setVersion] = useState<AgentVersion | null>(null)
  const [games, setGames] = useState<TrackedGame[]>([])
  const [activity, setActivity] = useState<ActivityDto | null>(null)
  const [target, setTargetState] = useState<string | null>(stickyTarget) // null = all games
  const setTarget = (value: string | null) => { stickyTarget = value; setTargetState(value) }
  // Which warnings have already been toasted, so a standing warning is announced once rather than
  // every refresh. A panel that toasts the same thing every minute gets uninstalled.
  const [toasted, setToasted] = useState<Set<string>>(new Set())
  const run = useSyncRun()
  const conflicts = useOpenConflicts()
  const { holds, refresh: refreshHolds } = useDlcHolds()
  const { holds: emptied, refresh: refreshEmptied } = useEmptiedHolds()
  const heroRef = useRef<HTMLDivElement>(null)
  const qamVisible = useQuickAccessVisible()

  useEffect(() => {
    if (!qamVisible) return
    resetQamToTop(heroRef.current)
    const raf = requestAnimationFrame(() => resetQamToTop(heroRef.current))
    const timer = setTimeout(() => resetQamToTop(heroRef.current), 150)
    return () => { cancelAnimationFrame(raf); clearTimeout(timer) }
  }, [qamVisible])

  const refreshStatus = async () => {
    const [s, v, g] = await Promise.all([fetchState(), fetchVersion(), fetchGames()])
    if (v.ok) setVersion(v.data)
    if (g.ok) setGames(g.data)
    if (!s.ok) { setState(null); setReach({ kind: 'down', reason: s.reason }); return }
    setState(s.data)
    setReach({ kind: 'ok' })

    const fresh = s.data.leaseWarnings.filter((w) => !toasted.has(w.gameName))
    if (fresh.length > 0) {
      for (const w of fresh) {
        toaster.toast({
          title: 'SaveLocker',
          body: `${w.gameName} is checked out on ${w.holderMachine}`,
        })
      }
      setToasted((prev) => new Set([...prev, ...fresh.map((w) => w.gameName)]))
    }
  }

  const refreshActivity = async () => {
    const a = await fetchActivity()
    if (a.ok) setActivity(a.data)
  }

  // The adaptive poll below can be 10 s away when a press starts a sync, and a short pull/push can
  // finish before the hero ever shows it. Poll right away when something is KNOWN to have just
  // started, plus once more shortly after — the agent's SyncActivityTracker.Begin() lands a beat
  // after the CLI process spawns, so a single immediate poll can still arrive just before it.
  const pokeActivity = () => {
    void refreshActivity()
    setTimeout(() => void refreshActivity(), 400)
  }

  const dismiss = async (gameName: string) => {
    await dismissWarning(gameName)
    // Forget it here too, or the same warning could never be announced again this session.
    setToasted((prev) => {
      const next = new Set(prev)
      next.delete(gameName)
      return next
    })
    await refreshStatus()
  }

  const openSettings = () => {
    // CloseSideMenus first, or the QAM overlay stays on top of the freshly-navigated page — the
    // exact sequence real Decky plugins with a full-page settings screen use (confirmed against
    // bash-shortcuts' own onClick: CloseSideMenus() then Navigate(), not the reverse).
    Navigation.CloseSideMenus()
    Navigation.Navigate(SAVELOCKER_PAGE_ROUTE)
  }

  useEffect(() => {
    // The automatic pass NEVER writes — it is a slow safety net, and idempotence on the agent side
    // is what makes re-running it free. Nothing in the QAM shows its result (the full-screen
    // page's Launch options is the interactive surface for that), so the outcome is discarded here;
    // `report()` inside applyAll is what lets doctor answer for a game whether or not this
    // fire-and-forget call is ever looked at.
    void applyAll(false)
    void refreshStatus()
    const timer = setInterval(() => void applyAll(false), 5 * 60 * 1000)
    // Status is cheap and time-sensitive in a way launch options are not: a lease taken on another
    // machine while this panel is open is exactly what the warning is for.
    const statusTimer = setInterval(() => void refreshStatus(), 30 * 1000)

    // Adaptive, not a flat setInterval: Decky keeps a QAM plugin's content mounted for as long as
    // the plugin is loaded, not just while the panel is open, so this effect runs for the whole
    // time Steam is up — including an entire play session. 2 s only matters while something is
    // mid-sync, to keep the hero's bar live; the rest of the time this only needs to notice a
    // Gaming-Mode-triggered sync starting, so it backs off rather than polling every 2 s forever.
    let activityTimeout: ReturnType<typeof setTimeout>
    let cancelled = false
    const scheduleActivity = async () => {
      const a = await fetchActivity()
      if (cancelled) return
      if (a.ok) setActivity(a.data)
      const idle = !a.ok || a.data.current.phase === 'Idle'
      activityTimeout = setTimeout(() => void scheduleActivity(), idle ? 10 * 1000 : 2 * 1000)
    }
    void scheduleActivity()

    return () => {
      cancelled = true
      clearInterval(timer)
      clearInterval(statusTimer)
      clearTimeout(activityTimeout)
    }
  }, [])

  const nameFor = (gameId: string) => games.find((g) => g.gameId === gameId)?.name ?? 'A tracked game'
  const warnings = state?.leaseWarnings ?? []
  const staged = version?.stagedVersion ?? null
  const stagedBlocked = version?.stagedBlockedReason ?? null
  const down = reach.kind === 'down'
  const targetName = target ?? 'all games'
  const targetGame = target ? games.find((g) => g.name === target) ?? null : null
  // A sync needs a reachable agent and something to sync; an install restarts the agent under it.
  const syncDisabled = run.busy !== null || run.installing || down || reach.kind === 'loading'
    || (state !== null && state.gamesTracked === 0)

  const attention = conflicts.length + emptied.length + warnings.length + holds.length + (staged ? 1 : 0) + (down ? 1 : 0)

  return (
    <>
      <Hero heroRef={heroRef} reach={reach} state={state} version={version} activity={activity} busy={run.busy} />

      {/* Only exists when something does. Each item is ONE focus stop whose press opens its own
          flow — the old panel gave every item a read-only row plus a button row, and listed the
          rows of all items before any of their buttons. */}
      {attention > 0 && (
        <PanelSection title="Needs attention">
          {down && (
            <NavRow
              dot="error"
              label="SaveLocker agent not reachable"
              description="Run a check to see what is wrong."
              onOpen={() => showModal(<DoctorModal />)}
            />
          )}
          {conflicts.map((c) => (
            <NavRow
              key={c.id}
              dot="conflict"
              label={`Save conflict — ${nameFor(c.gameId)}`}
              description={`This Deck and the cloud both changed since the last sync${c.escalated ? ' — unresolved for a while' : ''}. Pick which save to keep.`}
              onOpen={() => openConflictResolveModal(c.id)}
            />
          ))}
          {emptied.map((h) => (
            <NavRow
              key={`emptied-${h.gameId}`}
              dot="conflict"
              label={`Save files gone — ${h.gameName}`}
              description="Every save file is gone from this Deck. Nothing syncs for it until you restore it or delete it everywhere."
              onOpen={() => openEmptiedHoldModal(h, () => { void refreshEmptied(); void refreshStatus() })}
            />
          ))}
          {warnings.map((w) => (
            <NavRow
              key={`lease-${w.gameName}`}
              dot="warning"
              label={`Checked out elsewhere — ${w.gameName}`}
              description={`Open on ${w.holderMachine}. Playing here may cause a conflict.`}
              onOpen={() => showModal(
                <LeaseModal gameName={w.gameName} holder={w.holderMachine} onDismiss={() => void dismiss(w.gameName)} />,
              )}
            />
          ))}
          {holds.map((h) => (
            <NavRow
              key={`dlc-${h.gameId}`}
              dot="warning"
              label={`Waiting for DLC — ${h.gameName}`}
              description={`The newer save needs ${h.summary}. The pull is held.`}
              onOpen={() => openDlcHoldModal(h, () => { void refreshHolds(); void refreshStatus() })}
            />
          ))}
          {/* Blocked keeps the row but drops the chevron: restarting while a game runs is harmless
              and does NOTHING (the agent defers the swap on purpose), and a dialog whose success
              case is "nothing happened" is worse than none. Pressing it says why instead. The 30 s
              status poll brings the installable row back by itself once the game closes. */}
          {staged && version && (
            <NavRow
              dot="syncing"
              label={run.installing ? `Installing v${staged}…` : `Update v${staged} ready`}
              description={run.installing ? 'The agent is restarting. No game is affected.'
                : stagedBlocked ?? 'Installs in a few seconds and restarts the agent. No game is affected.'}
              chevron={!stagedBlocked && !run.installing}
              onOpen={() => {
                if (run.installing) return
                if (stagedBlocked) saveLockerToast('blocked', `v${staged} installs later`, stagedBlocked)
                else confirmInstall(version, () => void refreshStatus())
              }}
            />
          )}
        </PanelSection>
      )}

      <PanelSection title="Sync">
        <PanelSectionRow>
          <DropdownItem
            label="Games"
            disabled={run.busy !== null}
            rgOptions={[
              { data: ALL_GAMES, label: 'All games' },
              ...games.map((g) => ({ data: g.name, label: g.name })),
            ]}
            selectedOption={target ?? ALL_GAMES}
            onChange={(o: any) => {
              // Steam's own Dropdown, resolved out of CommonUIModule by shape — its callback contract
              // is not ours to assume, so accept either the option object or a bare value.
              const picked = o && typeof o === 'object' && 'data' in o ? o.data : o
              setTarget(picked === ALL_GAMES || picked == null ? null : String(picked))
            }}
          />
        </PanelSectionRow>
        {targetGame && (
          <PanelSectionRow>
            <PlaythroughDropdown
              game={targetGame}
              count={targetGame.playthroughCount}
              disabled={run.busy !== null || run.installing || down}
              onChanged={() => void refreshStatus()}
            />
          </PanelSectionRow>
        )}
        <PanelSectionRow>
          <ButtonItem layout="below" disabled={syncDisabled} onClick={() => void runSyncAction('sync', target, false, pokeActivity)}>
            {run.busy ? 'Syncing…' : target ? `Sync ${targetName}` : 'Sync now'}
          </ButtonItem>
        </PanelSectionRow>
        {run.last && (
          <NavRow
            dot={run.last.kind}
            label={`Last sync · ${timeAgo(run.last.at)}`}
            description={`${run.last.label} — ${run.last.summary}`}
            onOpen={() => { if (syncRun.last) showModal(<LastSyncModal result={syncRun.last} />) }}
          />
        )}
        {!down && (
          <NavRow
            label="Advanced"
            description="Push or pull one direction, force actions"
            onOpen={() => {
              if (syncDisabled) return
              showModal(<SyncOptionsModal target={target} game={targetGame} onStarted={pokeActivity} onSwitched={() => void refreshStatus()} />)
            }}
          />
        )}
      </PanelSection>

      <PanelSection title="More">
        <PanelSectionRow>
          <GamingSyncToggle />
        </PanelSectionRow>
        <NavRow
          label="Settings and diagnostics"
          description="Games, launch options, activity, doctor"
          onOpen={openSettings}
        />
      </PanelSection>
    </>
  )
}

export default definePlugin(() => {
  // gamingSync.tsx's launch gate (Phase 11) needs conflicts.tsx's open-conflict lookup and resolve
  // popup, but conflicts.tsx already imports gameIdToAppId FROM gamingSync.tsx — importing back
  // would make the two modules circular. Wiring the two functions in here, at the one place that
  // already imports both, avoids that; see gamingSync.tsx's own ConflictHooks doc comment.
  setConflictHooks({ getOpenConflictForGame, openConflictResolveModal, refreshConflictsSoon })
  // Wired once, at plugin load, rather than from Content()'s mount — see registerGamingModeSync's
  // own doc comment in gamingSync.tsx for why that timing matters. registerConflictPolling shares
  // that reasoning: a conflict found while no relevant page is open should still have the QAM badge
  // lit and the library chip painted the moment one opens, not only once Content() itself mounts.
  registerGamingModeSync()
  registerLibraryOverlay()
  registerConflictPolling()
  routerHook.addRoute(SAVELOCKER_PAGE_ROUTE, FullPage)
  return {
    name: 'SaveLocker',
    titleView: <div className={staticClasses.Title}>SaveLocker</div>,
    content: <Content />,
    icon: <FaGamepad />,
    onDismount() {
      // The route, the library-page patch, the Gaming Mode launch/close listeners, and the conflict
      // poller are all owned by the plugin's own lifetime, not any one component's, so all four are
      // torn down here rather than in a component's own cleanup — otherwise a plugin reload leaves
      // the old listeners firing alongside the freshly-registered ones. (Content's own polling
      // intervals are owned by its effect.)
      routerHook.removeRoute(SAVELOCKER_PAGE_ROUTE)
      unregisterLibraryOverlay()
      unregisterGamingModeSync()
      unregisterConflictPolling()
    },
  }
})
