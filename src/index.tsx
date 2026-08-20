import { useEffect, useState } from 'react'
import {
  ButtonItem, ConfirmModal, DropdownItem, Focusable, Navigation, PanelSection, PanelSectionRow,
  showModal, staticClasses,
} from '@decky/ui'
import { callable, definePlugin, routerHook, toaster } from '@decky/api'
import { FaGamepad } from 'react-icons/fa'
import { GamingSyncSettings, registerGamingModeSync } from './gamingSync'
import { FullPage, SAVELOCKER_PAGE_ROUTE } from './fullPage'
import {
  ReadOnlyRow, applyAll, fetchActivity, fetchGames, fetchState, fetchVersion, runSync,
  type ActivityDto, type AgentResult, type AgentState, type AgentVersion, type TrackedGame,
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
 */

const dismissWarning = callable<[string], AgentResult<null>>('dismiss_warning')
const restartAgent = callable<[], AgentResult<null>>('restart_agent')

/**
 * "Your other machine has this game checked out."
 *
 * This is the highest-value thing in the panel and the reason the status surface exists at all. The
 * agent records lease warnings durably on disk precisely so they survive to *some* UI, but until now
 * that UI was the agent's web UI or the server console — neither of which anyone is looking at while
 * holding a Deck about to press play. Here it reaches the user at the only moment it can act on.
 */
function LeaseWarnings({ warnings, onDismiss }: {
  warnings: AgentState['leaseWarnings']
  onDismiss: (gameName: string) => void
}) {
  if (warnings.length === 0) return null
  return (
    <PanelSection title="Checked out elsewhere">
      {warnings.map((w) => (
        <PanelSectionRow key={w.gameName}>
          <ReadOnlyRow>
            <div style={{ fontSize: '0.85em' }}><b>{w.gameName}</b></div>
            <div style={{ opacity: 0.75 }}>
              open on {w.holderMachine}. Playing here may cause a conflict.
            </div>
          </ReadOnlyRow>
        </PanelSectionRow>
      ))}
      {warnings.map((w) => (
        <PanelSectionRow key={`dismiss-${w.gameName}`}>
          {/* Dismiss clears the notice, not the condition — if the lease is still held the agent
              records it again. That is right: the warning exists to be seen before launching. */}
          <ButtonItem layout="below" onClick={() => onDismiss(w.gameName)}>
            Dismiss {w.gameName}
          </ButtonItem>
        </PanelSectionRow>
      ))}
    </PanelSection>
  )
}

/**
 * Read-only status.
 *
 * The whole block is ONE Focusable, and that shape is deliberate. Steam's Quick Access panel scrolls
 * by moving focus, so a run of non-focusable rows between focusable ones is a hole the D-pad cannot
 * land in: scrolling up into it reveals a line, finds nothing to focus, and jumps to the back button
 * — leaving the user toggling up/down to inch through. One focusable block is a single stop that
 * scrolls into view whole. Several focusable lines would fix the jumping too, but would make the
 * user press down five times to get past information they only read.
 */
function Status({ state, version }: { state: AgentState | null; version: AgentVersion | null }) {
  if (!state) return null
  const line = (label: string, value: string) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85em', gap: '8px' }}>
      <span style={{ opacity: 0.7 }}>{label}</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
    </div>
  )
  return (
    <PanelSection title="Status">
      <PanelSectionRow>
        <ReadOnlyRow>
          {line('Server', state.connected ? state.machineName : 'not connected')}
          {line('Last sync', state.lastSyncAgo)}
          {line('Games', String(state.gamesTracked))}
          {line('Saves pushed', String(state.savesBacked))}
          {/* Staged and available are not the same thing and must not read the same. "ready" is
              only true of a payload that is already here and verified — the one the Update section
              below can install on the spot. */}
          {version?.stagedVersion
            ? line('Agent', `${version.currentVersion} → ${version.stagedVersion} ready`)
            : version?.updateAvailable
              ? line('Agent', `${version.currentVersion} → ${version.latestVersion} available`)
              : line('Agent', state.currentVersion)}
        </ReadOnlyRow>
      </PanelSectionRow>
    </PanelSection>
  )
}

/**
 * "Install update now" — the only thing on a Deck that can take a waiting update without a terminal.
 *
 * Without this, a staged update says it will be installed "the next time this device starts
 * SaveLocker" and offers nothing. That phrase means the `savelocker.service` systemd `--user` unit
 * starting, which nothing on screen says, so the routes to it are a reboot or a terminal — neither
 * of which is where the notice is being read.
 *
 * **Only ever offered for `stagedVersion`.** A merely-available update needs a network round trip
 * that can fail; this one is a file copy the agent has already verified, so pressing the button is
 * the last step rather than the first.
 *
 * The button destroys the API this panel is talking to. That is not a hazard to work around — it is
 * how the update installs — so `unreachable` during the wait is the expected shape of SUCCESS, and
 * anything that error-toasts on the first failed call reports a working update as a failure.
 */
function StagedUpdate({ version, onSettled }: {
  version: AgentVersion | null
  onSettled: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null)

  const staged = version?.stagedVersion ?? null
  const blocked = version?.stagedBlockedReason ?? null

  // Success REMOVES the thing this section is about: the staged marker is gone the moment the swap
  // lands, so `staged` goes null and this would unmount with the result unread. The outcome keeps
  // the section on screen by itself — a press that ends with a row quietly disappearing is
  // indistinguishable from a press that did nothing.
  if (!staged && !outcome) return null

  const install = async () => {
    const before = version?.currentVersion ?? ''
    setBusy(true)
    setOutcome(null)
    try {
      const restarted = await restartAgent()
      if (!restarted.ok) {
        setOutcome({ ok: false, text: describeRestartFailure(restarted.reason) })
        return
      }

      // systemctl returns once the unit is active, but the agent's HTTP listener comes up a moment
      // after that, so the first few polls legitimately fail. Success is not a version string match
      // — the agent prints Major.Minor.Patch and the server's string need not agree on component
      // count — it is the staged marker being GONE, which only happens once the swap ran.
      const deadline = Date.now() + 120_000
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000))
        const v = await fetchVersion()
        if (!v.ok) continue

        if (v.data.stagedVersion === null) {
          setOutcome(v.data.currentVersion === before
            // Applied, and the agent came back on the version it started on. The updater rolls a
            // version back by itself when it will not start, so this is what that looks like from
            // here — and saying "installed" would be a lie the user finds out about later.
            ? { ok: false, text: `The agent restarted but is still on v${before}. Run doctor.` }
            : { ok: true, text: `Installed. Now running v${v.data.currentVersion}.` })
          return
        }
        // Still staged after a restart means the apply declined, and the agent knows why.
        if (v.data.stagedBlockedReason) {
          setOutcome({ ok: false, text: v.data.stagedBlockedReason })
          return
        }
      }
      setOutcome({ ok: false, text: 'The agent did not come back within two minutes. Run doctor.' })
    } finally {
      setBusy(false)
      onSettled()
    }
  }

  return (
    <PanelSection title="Update">
      {staged && (
        <PanelSectionRow>
          <ReadOnlyRow>
            <div style={{ fontSize: '0.85em' }}>
              <b>v{staged}</b> is downloaded and verified.
            </div>
            <div style={{ opacity: 0.75, fontSize: '0.8em' }}>
              {blocked ?? 'Installing takes a few seconds and restarts the agent. No game is affected.'}
            </div>
          </ReadOnlyRow>
        </PanelSectionRow>
      )}

      {/* Blocked is shown instead of the button, not beside it. Restarting while a game is running
          is harmless and does NOTHING — the agent defers the swap on purpose — and a button whose
          success case is "nothing happened" is worse than no button. The 30 s status poll brings it
          back on its own once the game closes. */}
      {staged && !blocked && (
        <PanelSectionRow>
          <ButtonItem layout="below" disabled={busy} onClick={() => void install()}>
            {busy ? 'Installing…' : `Install v${staged} now`}
          </ButtonItem>
        </PanelSectionRow>
      )}

      {outcome && (
        <PanelSectionRow>
          <ReadOnlyRow>
            <span style={{ fontSize: '0.8em', opacity: outcome.ok ? 0.8 : 1 }}>{outcome.text}</span>
          </ReadOnlyRow>
        </PanelSectionRow>
      )}
    </PanelSection>
  )
}

/**
 * systemctl's failure, in words a Deck owner can act on.
 *
 * The two that matter are named because they are not the same problem: no bus means this plugin's
 * backend has no user session to talk to (and the agent is fine), while a missing unit means the
 * agent was never installed through `install.sh`. Anything else is passed through verbatim rather
 * than flattened into "it failed" — systemctl's own text is the only real diagnostic there is.
 *
 * The missing-unit test is anchored to the unit's own name, not to a bare "not found". A loose match
 * told a Deck whose service was present, enabled and RUNNING that it had never been installed,
 * because the dynamic linker had failed systemctl with `version 'OPENSSL_3.4.0' not found` — a
 * sentence carrying those two words and meaning nothing like it. Advice this confident is earned.
 */
function describeRestartFailure(reason: string): string {
  if (reason === 'timeout') return 'The restart did not finish within two minutes. Run doctor.'
  if (reason === 'exec-failed') return 'systemctl is not available on this device.'
  if (reason.includes('connect to bus'))
    return 'Could not reach this user\'s systemd. Restart your device to install the update.'
  if (reason.includes('savelocker.service not found') ||
      reason.includes('savelocker.service not loaded'))
    return 'savelocker.service is not installed, so there is nothing to restart. '
      + 'Restart your device, or run install.sh from Desktop mode.'
  return `Could not restart the agent: ${reason}`
}

/**
 * Push and pull, for one game or all of them.
 *
 * The plain buttons cannot lose data — the agent refuses a pull while the game is running, refuses
 * one that would overwrite un-pushed local changes, and turns a diverged push into a conflict rather
 * than overwriting the server. `--force` defeats the middle two, and is the only way to lose
 * progress from this panel, so it goes through a confirmation that names the game and says what is
 * lost. Deliberately not a toggle: a toggle left on makes the NEXT press destructive too.
 */
const ALL_GAMES = '__all_games__'

/**
 * The sync target, held at MODULE scope rather than in component state.
 *
 * Opening Steam's dropdown tears down and rebuilds the Quick Access panel content, so a selection
 * made in it is destroyed by the very act of making it — the component remounts and every useState
 * goes back to its initial value. Measured on hardware: the render immediately after a selection
 * reports `games = 0`, i.e. the parent's state reset too, not just this component's.
 *
 * Module scope outlives that remount. It resets if the plugin itself is reloaded, which is correct:
 * this is a transient UI choice, not a setting worth persisting.
 */
let stickyTarget: string | null = null

function Sync({ games, onActionStarted }: { games: TrackedGame[]; onActionStarted: () => void }) {
  const [target, setTargetState] = useState<string | null>(stickyTarget) // null = all games
  const setTarget = (value: string | null) => { stickyTarget = value; setTargetState(value) }
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState<{ label: string; exitCode: number; output: string } | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const targetName = target ?? 'all games'

  const go = async (action: 'push' | 'pull', force: boolean) => {
    const label = `${force ? 'force ' : ''}${action} ${targetName}`
    setBusy(label)
    setProblem(null)
    onActionStarted()
    try {
      const r = await runSync(action, target, force)
      if (r.ok) {
        setResult({ label, exitCode: r.data.exitCode, output: r.data.output })
        // A manual sync is worth announcing even though the result is listed below: it can take a
        // while, and the user may have closed the panel or started a game before it finishes.
        toaster.toast({
          title: 'SaveLocker',
          body: r.data.exitCode === 0 ? `${label} finished` : `${label} failed — see the plugin`,
        })
      } else {
        setResult(null)
        setProblem(r.reason)
      }
    } finally {
      setBusy(null)
    }
  }

  // Pull then push, back to back — a plain "sync it" for someone who doesn't want to think about
  // which direction they need. Both legs are independently safe (neither can lose data without
  // `--force`), so a refused/failed pull does not stop the push attempt: they're reported together,
  // not gated on each other.
  const syncBoth = async () => {
    const label = `sync ${targetName}`
    setBusy(label)
    setProblem(null)
    onActionStarted()
    try {
      const pull = await runSync('pull', target, false)
      onActionStarted() // the push leg starts its own, separate activity phase, worth its own poke
      const push = await runSync('push', target, false)
      if (!pull.ok && !push.ok) {
        setResult(null)
        setProblem(pull.reason)
        return
      }
      const lines = [
        pull.ok ? `pull: exit ${pull.data.exitCode}` : `pull: could not run (${pull.reason})`,
        pull.ok ? pull.data.output : '',
        push.ok ? `push: exit ${push.data.exitCode}` : `push: could not run (${push.reason})`,
        push.ok ? push.data.output : '',
      ].filter((l) => l.trim() !== '')
      const exitCode = (pull.ok ? pull.data.exitCode : 1) || (push.ok ? push.data.exitCode : 1)
      setResult({ label, exitCode, output: lines.join('\n') })
      toaster.toast({
        title: 'SaveLocker',
        body: exitCode === 0 ? `${label} finished` : `${label} finished with issues — see the plugin`,
      })
    } finally {
      setBusy(null)
    }
  }

  const confirmForce = (action: 'push' | 'pull') => {
    const consequence = action === 'push'
      ? `This replaces the server's copy for ${targetName} with this device's save. Every other machine will pull it.`
      : `This discards this device's save for ${targetName} and takes the server's copy. Unsynced progress here is lost.`
    showModal(
      <ConfirmModal
        bDestructiveWarning
        strTitle={`Force ${action} ${targetName}?`}
        strDescription={consequence}
        strOKButtonText={`Force ${action}`}
        onOK={() => void go(action, true)}
      />,
    )
  }

  return (
    <PanelSection title="Sync">
      <PanelSectionRow>
        <DropdownItem
          label="Target"
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

      {/* Push/Force push share a row, Pull/Force pull share a row, and Sync sits alone between
          them — the plain action next to its destructive variant, with the one-click bidirectional
          shortcut set apart rather than buried in the same rank as five other buttons. */}
      <PanelSectionRow>
        <Focusable style={{ display: 'flex', gap: '6px' }}>
          <div style={{ flex: 1 }}>
            <ButtonItem layout="below" disabled={busy !== null} onClick={() => void go('push', false)}>
              {busy === `push ${targetName}` ? 'Pushing…' : 'Push'}
            </ButtonItem>
          </div>
          <div style={{ flex: 1 }}>
            <ButtonItem layout="below" disabled={busy !== null} onClick={() => confirmForce('push')}>
              Force push…
            </ButtonItem>
          </div>
        </Focusable>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" disabled={busy !== null} onClick={() => void syncBoth()}>
          {busy === `sync ${targetName}` ? 'Syncing…' : `Sync ${targetName}`}
        </ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <Focusable style={{ display: 'flex', gap: '6px' }}>
          <div style={{ flex: 1 }}>
            <ButtonItem layout="below" disabled={busy !== null} onClick={() => void go('pull', false)}>
              {busy === `pull ${targetName}` ? 'Pulling…' : 'Pull'}
            </ButtonItem>
          </div>
          <div style={{ flex: 1 }}>
            <ButtonItem layout="below" disabled={busy !== null} onClick={() => confirmForce('pull')}>
              Force pull…
            </ButtonItem>
          </div>
        </Focusable>
      </PanelSectionRow>

      {problem && (
        <PanelSectionRow>
          <ReadOnlyRow>
            {problem === 'no-agent' ? 'SaveLocker is not installed on this device.'
              : problem === 'timeout' ? 'The sync did not finish within 10 minutes.'
                : `Could not run it (${problem}).`}
          </ReadOnlyRow>
        </PanelSectionRow>
      )}

      {result && (
        <PanelSectionRow>
          <Focusable style={{ display: 'flex', flexDirection: 'column' }}>
            <ReadOnlyRow>
              <span style={{ fontSize: '0.8em', opacity: 0.8 }}>
                {result.label} — {result.exitCode === 0 ? 'ok' : `exit ${result.exitCode}`}
              </span>
            </ReadOnlyRow>
            {/* The agent's own words, not a summary of them: a refusal explains itself ("X is
                running — pull refused"), and paraphrasing that would lose the reason. */}
            {result.output.split('\n').filter((l) => l.trim() !== '').slice(-12).map((l, i) => (
              <ReadOnlyRow key={i}>
                <span style={{ fontSize: '0.72em', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{l}</span>
              </ReadOnlyRow>
            ))}
          </Focusable>
        </PanelSectionRow>
      )}
    </PanelSection>
  )
}

/**
 * What the agent is doing right now, right under Status — the "is something happening" answer.
 * Hidden entirely at Idle: an empty bar is worse than no bar, since it invites checking whether it's
 * stuck. The full history (ActivityLog) lives on the full-screen page now, not here.
 */
function Progress({ activity }: { activity: ActivityDto | null }) {
  const current = activity?.current
  if (!current || current.phase === 'Idle') return null

  // Byte progress only ever exists for a push (the agent only reports it on the upload chunk loop) —
  // pulling and the post-game settle wait get an indeterminate bar rather than a fabricated percent.
  const pct = current.phase === 'Pushing' && current.bytesTotal > 0
    ? Math.min(100, Math.round((current.bytesDone / current.bytesTotal) * 100))
    : null

  return (
    <PanelSection title="Syncing">
      <PanelSectionRow>
        <ReadOnlyRow>
          <div style={{ fontSize: '0.85em', marginBottom: '4px' }}>
            {(current.gameName ?? 'a game') + ' — ' + current.phase.toLowerCase()}
            {pct !== null && ` (${pct}%)`}
          </div>
          <div style={{ background: 'rgba(255,255,255,0.15)', borderRadius: '3px', height: '5px', overflow: 'hidden' }}>
            <div style={{
              background: 'rgba(255,255,255,0.6)',
              height: '100%',
              width: pct !== null ? `${pct}%` : '35%',
              opacity: pct !== null ? 1 : 0.7,
            }} />
          </div>
        </ReadOnlyRow>
      </PanelSectionRow>
    </PanelSection>
  )
}

function Content() {
  const [state, setState] = useState<AgentState | null>(null)
  const [version, setVersion] = useState<AgentVersion | null>(null)
  const [games, setGames] = useState<TrackedGame[]>([])
  const [activity, setActivity] = useState<ActivityDto | null>(null)
  // Which warnings have already been toasted, so a standing warning is announced once rather than
  // every refresh. A panel that toasts the same thing every minute gets uninstalled.
  const [toasted, setToasted] = useState<Set<string>>(new Set())

  const refreshStatus = async () => {
    const [s, v, g] = await Promise.all([fetchState(), fetchVersion(), fetchGames()])
    if (v.ok) setVersion(v.data)
    if (g.ok) setGames(g.data)
    if (!s.ok) { setState(null); return }
    setState(s.data)

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

  // The 2s interval below is fine for a sync already in flight, but a press-and-wait for the next
  // tick means a short pull/push can finish before the bar ever shows up at all. Poll right away
  // when something is KNOWN to have just started, plus once more shortly after — the agent's own
  // SyncActivityTracker.Begin() call happens a beat after the CLI process spawns, not the instant
  // this plugin's subprocess call returns, so a single immediate poll can still land just before it.
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
    // is what makes re-running it free. Nothing in the QAM shows its result any more (LaunchOptions,
    // on the full-screen page, is the interactive surface for that now) so the outcome is discarded
    // here; `report()` inside applyAll is what makes doctor able to answer for a game regardless of
    // whether this fire-and-forget call is ever looked at.
    void applyAll(false)
    void refreshStatus()
    void refreshActivity()
    const timer = setInterval(() => void applyAll(false), 5 * 60 * 1000)
    // Status is cheap and time-sensitive in a way launch options are not: a lease taken on another
    // machine while this panel is open is exactly what the warning is for.
    const statusTimer = setInterval(() => void refreshStatus(), 30 * 1000)
    // Activity is an in-memory read on the agent's side, meant to be polled far more often than
    // state — this is what makes the progress bar below look live rather than stepped.
    const activityTimer = setInterval(() => void refreshActivity(), 2 * 1000)
    return () => { clearInterval(timer); clearInterval(statusTimer); clearInterval(activityTimer) }
  }, [])

  return (
    <>
    <LeaseWarnings warnings={state?.leaseWarnings ?? []} onDismiss={(g) => void dismiss(g)} />
    <Status state={state} version={version} />
    <Progress activity={activity} />
    <StagedUpdate version={version} onSettled={() => void refreshStatus()} />
    <Sync games={games} onActionStarted={pokeActivity} />
    <GamingSyncSettings />
    <PanelSection title="More">
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={openSettings}>Settings</ButtonItem>
      </PanelSectionRow>
    </PanelSection>
    </>
  )
}

export default definePlugin(() => {
  // Wired once, at plugin load, rather than from Content()'s mount — see registerGamingModeSync's
  // own doc comment in gamingSync.tsx for why that timing matters.
  registerGamingModeSync()
  routerHook.addRoute(SAVELOCKER_PAGE_ROUTE, FullPage)
  return {
    name: 'SaveLocker',
    titleView: <div className={staticClasses.Title}>SaveLocker</div>,
    content: <Content />,
    icon: <FaGamepad />,
    onDismount() {
      // The interval is owned by Content's effect; the route is owned by the plugin's own lifetime,
      // not any one component's, so it is removed here rather than in a component's own cleanup.
      routerHook.removeRoute(SAVELOCKER_PAGE_ROUTE)
    },
  }
})
