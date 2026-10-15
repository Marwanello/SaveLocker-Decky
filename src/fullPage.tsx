import { useRef, useEffect, useState } from 'react'
import {
  DialogButton, DropdownItem, Field, Focusable, GamepadButton, ModalRoot, SidebarNavigation, TextField,
  ToggleField, showModal, type GamepadEvent,
} from '@decky/ui'
import { callable } from '@decky/api'
import { FaGamepad, FaHistory, FaRocket, FaShieldAlt, FaStethoscope } from 'react-icons/fa'
import {
  applyAll, fetchActivity, fetchConflictPolicy, fetchGames, fetchPluginVersion, fetchState, fetchSyncStatus,
  fetchVersion, runDoctor, runSync, setConflictPolicy, shortState, summarise, timeAgo,
  type ActivityDto, type ActivityLogEntry, type AgentResult, type AgentState, type AgentVersion,
  type ConflictPolicyKind, type ConflictPolicySetting, type DoctorResult, type Outcome, type SyncStatus,
  type TrackedGame,
} from './shared'
import { openConflictResolveModal, useOpenConflicts } from './conflicts'
import { persistSyncOnOpen, resolvePullEnabled } from './gamingSync'
import { classifySyncOutput } from './syncStatus'
import { installStagedUpdate } from './stagedUpdate'
import { DlcHolds } from './dlcHolds'
import { KIND_STYLE, saveLockerToast, type ToastKind } from './toast'

/**
 * The full-screen SaveLocker page — everything that was crowding the Quick Access panel (per-game
 * alias/pull settings, the full activity history, doctor's raw output, the launch-options detail
 * list) lives here instead, reachable from the QAM's own "Settings" button (index.tsx's
 * `openSettings`). Registered via `routerHook.addRoute` in index.tsx's `definePlugin`, not here —
 * the route belongs to the plugin's lifetime, not to this component's.
 *
 * The chrome is Valve's own paged-settings component (`SidebarNavigation` in @decky/ui is Steam's
 * PagedSettingsDialog resolved at runtime): title plus page list on the left, one content pane on
 * the right, icons and focus behaviour included. That replaced an earlier Decky `Tabs` layout and
 * with it two workarounds that no longer apply — a CSS block that killed the tab row's scroll
 * transition (which glitched as the row animated under freshly-mounted content) and the
 * `autoFocusContents` entry point (whose focus-driven scroll is why a scroll-reset shim exists
 * below, kept as a harmless safety net for Steam's own route-entry focus restoration).
 *
 * Per-game configuration is a dialog here, opened from a game's row, rather than the dense
 * five-control stacks the old list rendered inline; the row itself carries only what is needed to
 * find the game, and the dialog is where the settings live.
 */
export const SAVELOCKER_PAGE_ROUTE = '/savelocker'

const setAlias = callable<[string, string | null], AgentResult<null>>('set_alias')
const persistPullBeforeLaunch = callable<[string, boolean | null], AgentResult<null>>('set_pull_before_launch')
const fetchSyncOnOpenOverrides = callable<[], Record<string, boolean>>('gaming_sync_on_open_overrides')
const dismissWarning = callable<[string], AgentResult<null>>('dismiss_warning')

/** The three values verbatim (`ConflictPolicy` in `src/Shared/Contracts.cs`) — "Prefer this device"
 * rather than a full machine picker, since a settings row has no fleet-wide machine list to choose
 * from (only the dashboard does); it always targets THIS device's own machine id. */
const CONFLICT_POLICY_OPTIONS: { data: ConflictPolicyKind; label: string }[] = [
  { data: 'Manual', label: 'Ask me every time' },
  { data: 'NewestWins', label: 'Newest save always wins' },
  { data: 'PreferMachine', label: 'Prefer this device' },
]

const DIM = { fontSize: '13px', opacity: 0.7 } as const
const SMALL_BUTTON = { width: 'auto', minWidth: 0, padding: '8px 14px', flexShrink: 0 } as const

/** One full-width section with the gamepad's uppercase header — same title treatment the QAM's
 * PanelSection uses (16px/600, half-white), because this page and the panel are one visual
 * language and drifting them apart would make the plugin feel like two plugins. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '28px' }}>
      <div style={{
        fontSize: '16px', fontWeight: 600, letterSpacing: '0.5px', textTransform: 'uppercase',
        color: 'rgba(255,255,255,0.7)', paddingBottom: '8px',
      }}
      >
        {title}
      </div>
      {children}
    </div>
  )
}

/** A small status chip. Colours come from `toast.tsx`'s KIND_STYLE so a chip, the toast it
 * corresponds to, and the QAM's attention rows all say the same thing the same way. */
function Chip({ kind, children }: { kind: ToastKind; children: React.ReactNode }) {
  const { bg, fg } = KIND_STYLE[kind]
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', fontSize: '11px', fontWeight: 700,
      letterSpacing: '0.5px', textTransform: 'uppercase', padding: '2px 8px', borderRadius: '10px',
      background: bg, color: fg, whiteSpace: 'nowrap',
    }}
    >
      {children}
    </span>
  )
}

/** One stat tile in the Status page's overview strip. */
function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: 'rgba(255,255,255,0.05)', borderRadius: '2px', padding: '12px 14px' }}>
      <div style={{ fontSize: '11px', letterSpacing: '0.5px', textTransform: 'uppercase', color: 'rgba(255,255,255,0.4)' }}>
        {label}
      </div>
      <div style={{ fontSize: '18px', color: '#fff', marginTop: '3px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {value}
      </div>
    </div>
  )
}

/** How far one stick/D-pad press scrolls a `ScrollBlock` — the same 100px Valve's own scrollable
 * dialogs (store artwork, product-key agreement) step by. */
const SCROLL_STEP = 100

function scrollParent(el: Element): HTMLElement | null {
  let node = el.parentElement
  while (node) {
    const overflowY = getComputedStyle(node).overflowY
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node
    node = node.parentElement
  }
  return null
}

/**
 * A run of read-only content the left stick (and D-pad) can scroll through.
 *
 * Steam maps the left stick to the same direction events as the D-pad, and those MOVE FOCUS — so a
 * long block with nothing focusable in it (the activity history, doctor's output, the launch-options
 * results) was a wall: the stick had nowhere to go and the page would not move. This is Valve's own
 * answer to the same problem, copied from its store-artwork and product-key dialogs: the block is
 * one focus stop, and while it holds focus a direction press scrolls the page instead.
 *
 * It scrolls only while there is more of THIS block out of view in that direction, and otherwise
 * returns false so Steam's normal navigation takes over — pressing down past the end of the block
 * moves on to whatever follows it, and up past its start goes back, exactly as if it were a row.
 */
function ScrollBlock({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)

  const onDirection = (e: GamepadEvent): boolean => {
    const el = ref.current
    if (!el) return false
    const scroller = scrollParent(el)
    if (!scroller) return false
    const block = el.getBoundingClientRect()
    const view = scroller.getBoundingClientRect()
    if (e.detail.button === GamepadButton.DIR_DOWN && block.bottom > view.bottom + 2) {
      scroller.scrollBy({ top: SCROLL_STEP, behavior: 'smooth' })
      return true
    }
    if (e.detail.button === GamepadButton.DIR_UP && block.top < view.top - 2) {
      scroller.scrollBy({ top: -SCROLL_STEP, behavior: 'smooth' })
      return true
    }
    return false
  }

  return (
    // `onGamepadDirection` is typed as returning void, but Steam reads the return value: true
    // consumes the press, false lets navigation have it (see Valve's own handlers this mirrors).
    // `focusable` is Valve's own Focusable prop (a Focusable with no handler is otherwise not a
    // navigation target); @decky/ui does not type it, hence the spread.
    <Focusable ref={ref} {...{ focusable: true }} noFocusRing onGamepadDirection={onDirection as (e: GamepadEvent) => void}>
      {children}
    </Focusable>
  )
}

/** `EAnalogInput` value Steam sends for its gamepad-UI scroll binding — the right stick. */
const GAMEPAD_ANALOG_SCROLL = 47
/** Page pixels per unit of stick travel. Measured on a Deck: full deflection advances the running
 * total by ~3,200 units/s, so 0.45 is ~1,450 px/s flat out — a long doctor run in a second or two,
 * while a light push still moves a line at a time. */
const STICK_PX_PER_UNIT = 0.45
/** A jump this large between two messages ~2 ms apart is the total being reset (analog messages
 * re-enabled, controller reconnected), not stick travel — dropped rather than scrolled. */
const STICK_MAX_STEP = 200
/** Which way is up — see `useRightStickScroll`. */
const STICK_UP_IS_POSITIVE = true

/** The scroll container of whichever page is showing — found from its own marker, since Steam's
 * container classes are build-hashed and only the active page's content is mounted. */
function activePageScroller(): HTMLElement | null {
  const marker = Array.from(document.querySelectorAll('.savelocker-page')).find((el) => (el as HTMLElement).offsetParent !== null)
  return marker ? scrollParent(marker) : null
}

/**
 * Right-stick scrolling for the whole page, independent of focus.
 *
 * Steam's navigation only ever turns the LEFT stick into direction presses (its button map has no
 * right-stick directions). In the Steam UI's own controller layout (`basicui_neptune.vdf`) the right
 * stick is a `joystick_mouse` group feeding the "Scroll" analog action, which reaches this JS as
 * `GAMEPAD_ANALOG_SCROLL` messages — only while analog messages are enabled, which Steam does for its
 * own virtual keyboard and nothing else, and which its navigation then ignores. So this page enables
 * them for as long as it is open and scrolls itself. Focus does not move, exactly like a trackpad.
 *
 * Captured on hardware: the messages arrive every ~2 ms and x/y are a RUNNING TOTAL, mouse-style —
 * not a stick position. Holding the stick keeps the total climbing (~3,200 units/s at full tilt),
 * the other way runs it down, and a resting stick stops sending. The scroll is therefore the change
 * between consecutive messages, batched into one `scrollTop` write per frame. (The first version
 * read `y` as a -1..1 position and scaled anything larger down by 32767, which put every real
 * reading under its dead zone — the right stick did nothing at all.)
 *
 * Re-enabled once a second: opening the virtual keyboard (the Games search, an alias edit) turns
 * analog messages ON and closing it turns them OFF again, which would otherwise silently end right-
 * stick scrolling for the rest of the visit. Disabled on leaving, to hand the setting back as found.
 *
 * Direction: the total's sign convention is not documented; `STICK_UP_IS_POSITIVE` follows the
 * capture's first push. Flip it if the stick scrolls the wrong way.
 */
function useRightStickScroll(): void {
  useEffect(() => {
    const input = SteamClient.Input
    if (!input?.RegisterForControllerAnalogInputMessages || !input.EnableControllerAnalogInputMessages) return

    let lastY: number | null = null
    let pending = 0
    let frame: number | null = null

    const flush = () => {
      frame = null
      const units = pending
      pending = 0
      const scroller = activePageScroller()
      if (!scroller || units === 0) return
      const px = units * STICK_PX_PER_UNIT
      scroller.scrollTop += STICK_UP_IS_POSITIVE ? -px : px
    }

    const reg = input.RegisterForControllerAnalogInputMessages((_controller, action, _active, _x, y) => {
      if (action !== GAMEPAD_ANALOG_SCROLL) return
      const prev = lastY
      lastY = y
      if (prev === null) return
      const step = y - prev
      if (Math.abs(step) > STICK_MAX_STEP) return
      pending += step
      if (frame === null) frame = requestAnimationFrame(flush)
    })
    input.EnableControllerAnalogInputMessages(true)
    const keepEnabled = setInterval(() => input.EnableControllerAnalogInputMessages?.(true), 1000)

    return () => {
      clearInterval(keepEnabled)
      if (frame !== null) cancelAnimationFrame(frame)
      try { reg.unregister() } catch { /* already gone */ }
      input.EnableControllerAnalogInputMessages?.(false)
    }
  }, [])
}

/**
 * "Install update now", the full-page half of the QAM's own StagedUpdate.
 *
 * Both surfaces can install now — the staging this row exists for is a file copy the agent has
 * already verified, so the row offers the last step wherever the notice is being read instead of
 * sending the user to the panel. Only ever offered for `stagedVersion` (a merely-available update
 * needs a network round trip that can fail; this one cannot), and a blocked install shows the
 * agent's own reason instead of a button whose whole story is "nothing happened".
 *
 * The install itself (restart + poll until the staged marker is gone) lives in `stagedUpdate.tsx`
 * so this row and the QAM section cannot drift apart on what "success" means.
 */
function StagedUpdateRow({ version, onSettled }: { version: AgentVersion; onSettled: () => void }) {
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null)

  const staged = version.stagedVersion ?? null
  const blocked = version.stagedBlockedReason ?? null
  if (!staged && !outcome) return null

  const install = async () => {
    setBusy(true)
    setOutcome(null)
    try {
      setOutcome(await installStagedUpdate(version.currentVersion))
    } finally {
      setBusy(false)
      onSettled()
    }
  }

  return (
    <Field
      label={staged ? `v${staged} is downloaded and verified` : 'Update'}
      description={
        busy ? 'Installing — the agent restarts, no game is affected.'
          : blocked ?? outcome?.text ?? 'Installing takes a few seconds and restarts the agent. No game is affected.'
      }
      bottomSeparator="standard"
      childrenLayout="inline"
      childrenContainerWidth="min"
    >
      {staged && !blocked && (
        <DialogButton disabled={busy} onClick={() => void install()} style={SMALL_BUTTON}>
          {busy ? 'Installing…' : `Install v${staged} now`}
        </DialogButton>
      )}
    </Field>
  )
}

/**
 * Status — the page the route opens on.
 *
 * Answer order is the point: is this Deck healthy (tiles), is there an update, does anything need
 * a decision (conflicts, leases, DLC holds), and only then the one heavy action (sync everything).
 * The tiles poll at the QAM's own 30-second rhythm scaled up: five seconds is what the old page
 * used and `lastSyncAgo` is the one value a coarser clock visibly lies about.
 */
function StatusPage() {
  const [state, setState] = useState<AgentState | null>(null)
  const [version, setVersion] = useState<AgentVersion | null>(null)
  const [pluginVersion, setPluginVersion] = useState<string | null>(null)
  const [games, setGames] = useState<TrackedGame[]>([])
  const [syncing, setSyncing] = useState(false)
  const conflicts = useOpenConflicts()

  const refresh = async () => {
    const [s, v, g] = await Promise.all([fetchState(), fetchVersion(), fetchGames()])
    if (s.ok) setState(s.data)
    else setState(null)
    if (v.ok) setVersion(v.data)
    if (g.ok) setGames(g.data)
  }

  useEffect(() => {
    void refresh()
    // The plugin's own version never changes at runtime, unlike everything else here — fetched
    // once rather than on every poll tick.
    void fetchPluginVersion().then(setPluginVersion)
    const t = setInterval(() => void refresh(), 5 * 1000)
    return () => clearInterval(t)
  }, [])

  const nameFor = (gameId: string) => games.find((g) => g.gameId === gameId)?.name ?? 'A tracked game'
  const warnings = state?.leaseWarnings ?? []
  const nothingToDo = conflicts.length === 0 && warnings.length === 0

  const dismiss = async (gameName: string) => {
    await dismissWarning(gameName)
    await refresh()
  }

  const syncAll = async () => {
    setSyncing(true)
    try {
      await runSync('pull', null, false)
      await runSync('push', null, false)
      await refresh()
      saveLockerToast('success', 'sync all games finished')
    } finally {
      setSyncing(false)
    }
  }

  // Staged and available are not the same thing and must not read the same. "ready" is only true
  // of a payload that is already here and verified — the one the Update section can install on the
  // spot. This is the same line the QAM's Status section draws, with the same wording.
  const agentValue = version?.stagedVersion
    ? `${version.currentVersion} → ${version.stagedVersion} ready`
    : version?.updateAvailable
      ? `${version.currentVersion} → ${version.latestVersion} available`
      : state?.currentVersion ?? '—'

  return (
    <>
      <Section title="This deck">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '10px' }}>
          <Tile label="Server" value={state ? (state.connected ? state.machineName : 'not connected') : '—'} />
          <Tile label="Games" value={state ? String(state.gamesTracked) : '—'} />
          <Tile label="Last sync" value={state?.lastSyncAgo ?? '—'} />
          <Tile label="Agent" value={agentValue} />
          <Tile label="Plugin" value={pluginVersion ?? '—'} />
        </div>
      </Section>

      {version?.stagedVersion && (
        <Section title="Update">
          <StagedUpdateRow version={version} onSettled={() => void refresh()} />
        </Section>
      )}

      <Section title="Needs attention">
        {nothingToDo && <div style={DIM}>All clear.</div>}
        {conflicts.map((c) => (
          <Field
            key={c.id}
            focusable
            bottomSeparator="standard"
            label={`Save conflict — ${nameFor(c.gameId)}`}
            description={`This Deck and the cloud both changed since the last sync${c.escalated ? ' — unresolved for a while' : ''}.`}
            onActivate={() => openConflictResolveModal(c.id)}
            onClick={() => openConflictResolveModal(c.id)}
          />
        ))}
        {warnings.map((w) => (
          <Field
            key={`lease-${w.gameName}`}
            bottomSeparator="standard"
            label={`Checked out elsewhere — ${w.gameName}`}
            description={`Open on ${w.holderMachine}. Playing here may cause a conflict.`}
            childrenLayout="inline"
            childrenContainerWidth="min"
          >
            {/* Dismiss clears the notice, not the condition — if the lease is still held the agent
                records it again. That is right: the warning exists to be seen before launching. */}
            <DialogButton style={SMALL_BUTTON} onClick={() => void dismiss(w.gameName)}>Dismiss</DialogButton>
          </Field>
        ))}
      </Section>

      {/* DLC holds keep their own QAM-era component: one game, two honest actions, and the logic to
          offer exactly those two lives there; re-rendering the same data as bespoke rows here would
          be a copy that can drift. It renders nothing when there are no holds. */}
      <DlcHolds />

      <Section title="Quick actions">
        <DialogButton
          disabled={syncing}
          onClick={() => void syncAll()}
          style={{ width: '100%', padding: '16px', fontSize: '16px' }}
        >
          {syncing ? 'Syncing…' : 'Sync all games'}
        </DialogButton>
      </Section>
    </>
  )
}

/**
 * Games — search plus the tracked-games list; a game's row opens its settings dialog.
 *
 * The list carries only what identifies a game and its open conflict (a chip). It deliberately
 * does NOT claim "in sync": that answer costs a save-folder hash and is only fetched on demand
 * inside the dialog (the plan's Phase 12 rule — never poll it, the same disk cost a push pays).
 * A green "in sync" beside every row here would be an invention, and one the user would discover
 * was invented the first time a conflict appeared under it.
 */
function GamesPage() {
  const [games, setGames] = useState<TrackedGame[]>([])
  const [machineId, setMachineId] = useState<string | null>(null)
  const [syncOnOpenOverrides, setSyncOnOpenOverrides] = useState<Record<string, boolean>>({})
  const [search, setSearch] = useState('')
  const conflicts = useOpenConflicts()

  const refresh = async () => {
    const [g, s, o] = await Promise.all([fetchGames(), fetchState(), fetchSyncOnOpenOverrides()])
    if (g.ok) setGames(g.data)
    if (s.ok) setMachineId(s.data.machineId)
    setSyncOnOpenOverrides(o)
  }

  useEffect(() => {
    void refresh()
    // Games change rarely (enrolment, alias edits elsewhere); this page only needs to notice a
    // game appearing while it is open, not to chase the QAM's status cadence.
    const t = setInterval(() => void refresh(), 30 * 1000)
    return () => clearInterval(t)
  }, [])

  const query = search.trim().toLowerCase()
  const filtered = query === '' ? games : games.filter((g) => {
    const effective = (g.alias ?? g.name).toLowerCase()
    return g.name.toLowerCase().includes(query) || effective.includes(query)
  })

  const openGame = (game: TrackedGame) => {
    showModal(
      <GameSettingsModal
        game={game}
        machineId={machineId}
        syncOnOpenEnabled={syncOnOpenOverrides[game.gameId] ?? true}
        onSyncOnOpenChanged={(gameId, value) => setSyncOnOpenOverrides((prev) => ({ ...prev, [gameId]: value }))}
        onChanged={() => void refresh()}
      />,
    )
  }

  return (
    <Section title="Games">
      <TextField label="Search games" value={search} onChange={(e: any) => setSearch(e?.target?.value ?? '')} />
      <div style={{ ...DIM, fontSize: '12px', padding: '6px 0 10px' }}>
        {query === '' ? `${games.length} tracked` : `${filtered.length} of ${games.length}`}
      </div>
      {/* flow-children="down": the gamepad must step row-to-row; without a forced vertical flow
          Steam's default navigation considers a row's children (the chip) before moving past the
          row, which turns "down" into an extra stop per game. */}
      <Focusable flow-children="down">
        {filtered.length === 0 && (
          <div style={{ ...DIM, padding: '8px 0' }}>
            {games.length === 0 ? 'No tracked games yet.' : `No games match "${search.trim()}".`}
          </div>
        )}
        {filtered.map((g) => {
          const conflict = conflicts.find((c) => c.gameId === g.gameId)
          return (
            <Field
              key={g.gameId}
              focusable
              bottomSeparator="standard"
              label={g.name}
              description={`alias: ${g.alias ?? g.name} · ${g.hasSteamCloud ? 'Steam Cloud' : 'no Steam Cloud'}`}
              onActivate={() => openGame(g)}
              onClick={() => openGame(g)}
            >
              {conflict && <Chip kind="conflict">Save conflict</Chip>}
            </Field>
          )
        })}
      </Focusable>
    </Section>
  )
}

/**
 * One game's settings — the dialog the Games list opens.
 *
 * Everything the old list crammed into each row lives here at full width: the alias editor, both
 * launch-behaviour toggles, the conflict policy, an on-demand sync check, the conflict resolver,
 * and a one-game sync. The toggle rules below are carried over verbatim in behaviour from that
 * list, including why "Sync on page open" disappears rather than greys out, and why a policy save
 * that would record "prefer this device" without a registered machine is refused up front.
 */
function GameSettingsModal({ game, machineId, syncOnOpenEnabled, onSyncOnOpenChanged, onChanged, closeModal }: {
  game: TrackedGame
  /** This device's own machine id (from `/api/state`), or null before this device has registered. */
  machineId: string | null
  syncOnOpenEnabled: boolean
  onSyncOnOpenChanged: (gameId: string, value: boolean) => void
  onChanged: () => void
  closeModal?: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [pullBusy, setPullBusy] = useState(false)
  const [syncOnOpenBusy, setSyncOnOpenBusy] = useState(false)
  const [policy, setPolicy] = useState<ConflictPolicySetting | null>(null)
  const [policyBusy, setPolicyBusy] = useState(false)
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null)
  const [syncStatusBusy, setSyncStatusBusy] = useState(false)
  const [syncStatusError, setSyncStatusError] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)

  useEffect(() => {
    void fetchConflictPolicy(game.gameId).then((r) => { if (r.ok) setPolicy(r.data) })
  }, [game.gameId])

  // On demand only — the route hashes the whole save folder to answer, the same disk cost a push's
  // own hash pays, so it only runs when this dialog's own button is pressed.
  const checkSyncStatus = async () => {
    setSyncStatusBusy(true)
    setSyncStatusError(null)
    try {
      const r = await fetchSyncStatus(game.gameId)
      if (r.ok) setSyncStatus(r.data)
      else { setSyncStatus(null); setSyncStatusError(r.reason) }
    } finally {
      setSyncStatusBusy(false)
    }
  }

  const changePolicy = async (next: ConflictPolicyKind) => {
    if (next === 'PreferMachine' && machineId === null) {
      // This device hasn't registered with the agent yet, so there is no machine id to prefer —
      // persisting the policy anyway would silently set "Prefer this device" with no device recorded.
      saveLockerToast('blocked', 'Cannot prefer this device yet', 'It has not registered with the agent')
      return
    }
    setPolicyBusy(true)
    try {
      const preferredMachineId = next === 'PreferMachine' ? machineId : null
      const r = await setConflictPolicy(game.gameId, next, preferredMachineId)
      if (r.ok) setPolicy({ policy: next, preferredMachineId })
    } finally {
      setPolicyBusy(false)
    }
  }

  const effective = game.alias ?? game.name
  const pullEnabled = resolvePullEnabled(game)

  const startEdit = () => {
    setDraft(effective)
    setEditing(true)
  }

  const save = async () => {
    setBusy(true)
    try {
      const trimmed = draft.trim()
      const next = trimmed === '' || trimmed === game.name ? null : trimmed
      const r = await setAlias(game.gameId, next)
      if (r.ok) {
        game.alias = next // optimistic, same reasoning as the old QAM picker: onChanged() below refreshes soon
        setEditing(false)
        onChanged()
      }
    } finally {
      setBusy(false)
    }
  }

  const togglePull = async (value: boolean) => {
    setPullBusy(true)
    try {
      // Awaited, then applied optimistically only on success — not fire-and-forget: onChanged()
      // below re-fetches games() almost immediately, and firing the write without waiting for it
      // to land let that re-fetch win the race and read back the value from before this toggle,
      // which is what made this toggle look like it did nothing.
      const r = await persistPullBeforeLaunch(game.gameId, value)
      if (r.ok) {
        game.pullBeforeLaunchEnabled = value
        onChanged()
      }
    } finally {
      setPullBusy(false)
    }
  }

  // No AgentResult here (unlike togglePull above) — `set_gaming_sync_on_open` is a local settings
  // write, not an agent round trip, so there is nothing that can come back `{ ok: false }`.
  const toggleSyncOnOpen = async (value: boolean) => {
    setSyncOnOpenBusy(true)
    try {
      await persistSyncOnOpen(game.gameId, value)
      onSyncOnOpenChanged(game.gameId, value)
    } finally {
      setSyncOnOpenBusy(false)
    }
  }

  // Pull then push, one game — the panel's "sync everything" reduced to a target. Neither leg can
  // lose data without `--force` (which stays a QAM action with its confirmation), so a refused or
  // failed leg does not gate the other; they are classified from the agent's own words afterwards
  // because both exit 0 for refusals too.
  const syncThisGame = async () => {
    setSyncing(true)
    try {
      const pull = await runSync('pull', game.name, false)
      const push = await runSync('push', game.name, false)
      if (!pull.ok && !push.ok) {
        saveLockerToast('blocked', `Could not sync ${game.name}`, pull.reason)
        return
      }
      const pullOutcome = pull.ok ? classifySyncOutput('pull', pull.data.output) : 'blocked'
      const pushOutcome = push.ok ? classifySyncOutput('push', push.data.output) : 'blocked'
      if (pullOutcome === 'blocked' || pushOutcome === 'blocked') {
        saveLockerToast('blocked', `${game.name} finished with issues`, 'See the Quick Access panel for the agent\'s own output')
      } else if (pullOutcome === 'up-to-date' && pushOutcome === 'up-to-date') {
        saveLockerToast('info', `${game.name} is already up to date`)
      } else {
        saveLockerToast('success', `Synced ${game.name}`)
      }
      onChanged()
    } finally {
      setSyncing(false)
    }
  }

  // This can only ever set "prefer THIS device" — there is no fleet-wide machine picker here. If
  // the dashboard or another device already set a DIFFERENT preferred machine, say so rather than
  // silently implying this dropdown already reflects that.
  const prefersOtherDevice = policy?.policy === 'PreferMachine' && policy.preferredMachineId
    && machineId !== null && policy.preferredMachineId !== machineId

  return (
    <ModalRoot closeModal={closeModal} onCancel={closeModal}>
      <div style={{ padding: '20px', maxWidth: '640px' }}>
        <div style={{ fontSize: '16px', fontWeight: 700, marginBottom: '4px' }}>{game.name}</div>
        <div style={{ fontSize: '13px', opacity: 0.75, marginBottom: '16px' }}>
          {game.hasSteamCloud ? 'This title has Steam Cloud saves.' : 'No Steam Cloud saves.'}
        </div>

        <Field
          label="Save folder"
          description={<span style={{ wordBreak: 'break-all' }}>{game.saveDirectory}</span>}
          bottomSeparator="standard"
        />

        <ToggleField
          label="Pull before launch"
          description={game.hasSteamCloud
            ? 'Off by default: Steam Cloud already handles this title.'
            : 'On: the save is current before the game starts.'}
          checked={pullEnabled}
          disabled={pullBusy}
          onChange={(value: boolean) => void togglePull(value)}
        />
        {/* Only shown once "Pull before launch" is on — the setting is meaningless without it, so
            it disappears rather than showing disabled (a disabled control with no visible reason
            why invites poking at it to find out). On by default: see `resolveSyncOnOpenEnabled`. */}
        {pullEnabled && (
          <ToggleField
            label="Sync on page open"
            description="Moves the pull to the library page, so Play starts instantly."
            checked={syncOnOpenEnabled}
            disabled={syncOnOpenBusy}
            onChange={(value: boolean) => void toggleSyncOnOpen(value)}
          />
        )}

        {!editing ? (
          <Field
            label="Alias"
            description="Used when matching a launch to this game."
            bottomSeparator="standard"
            childrenLayout="inline"
            childrenContainerWidth="min"
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ opacity: 0.8, maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {effective}
              </span>
              <DialogButton style={SMALL_BUTTON} onClick={startEdit}>Edit alias</DialogButton>
            </div>
          </Field>
        ) : (
          <div style={{ margin: '10px 0' }}>
            <TextField label="Alias" value={draft} onChange={(e: any) => setDraft(e?.target?.value ?? '')} />
            <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
              <DialogButton disabled={busy} style={SMALL_BUTTON} onClick={() => void save()}>
                {busy ? 'Saving…' : 'Save'}
              </DialogButton>
              <DialogButton disabled={busy} style={SMALL_BUTTON} onClick={() => setEditing(false)}>Cancel</DialogButton>
            </div>
          </div>
        )}

        <div style={{ maxWidth: '320px', marginTop: '12px' }}>
          <DropdownItem
            label="If a save conflict happens"
            rgOptions={CONFLICT_POLICY_OPTIONS}
            selectedOption={policy?.policy ?? 'Manual'}
            disabled={policyBusy}
            onChange={(o: any) => {
              // Steam's own Dropdown, resolved out of CommonUIModule by shape — its callback
              // contract is not ours to assume, so accept either the option object or a bare value.
              const picked = o && typeof o === 'object' && 'data' in o ? o.data : o
              void changePolicy(picked as ConflictPolicyKind)
            }}
          />
          {prefersOtherDevice && (
            <div style={{ fontSize: '10px', opacity: 0.6, marginTop: '2px' }}>
              Currently prefers a different device — set from the dashboard.
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: '10px', marginTop: '14px', alignItems: 'center', flexWrap: 'wrap' }}>
          <DialogButton
            disabled={syncStatusBusy}
            onClick={() => void checkSyncStatus()}
            style={SMALL_BUTTON}
          >
            {syncStatusBusy ? 'Checking…' : 'Check sync status'}
          </DialogButton>
          {syncStatusError && (
            <span style={DIM}>
              {syncStatusError === 'no-agent' ? 'SaveLocker is not installed on this device.'
                : syncStatusError === 'unreachable' ? 'The SaveLocker agent is not running.'
                  : `Could not check (${syncStatusError}).`}
            </span>
          )}
          {syncStatus && !syncStatusError && (
            syncStatus.hasOpenConflict && syncStatus.conflictId ? (
              <DialogButton
                onClick={() => {
                  // Close this dialog first: the resolve popup is its own modal, and two stacked
                  // modals leave the first one's focus handling and backdrop in the way.
                  closeModal?.()
                  openConflictResolveModal(syncStatus.conflictId!, { onClosed: () => onChanged() })
                }}
                style={SMALL_BUTTON}
              >
                Open conflict — resolve
              </DialogButton>
            ) : (
              <Chip kind={syncStatus.inSync ? 'success' : 'blocked'}>
                {syncStatus.inSync ? 'In sync with the cloud' : 'Out of sync with the cloud'}
              </Chip>
            )
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' }}>
          <DialogButton
            disabled={syncing}
            onClick={() => void syncThisGame()}
            style={{ width: 'auto', minWidth: 0, padding: '8px 16px' }}
          >
            {syncing ? 'Syncing…' : 'Sync this game now'}
          </DialogButton>
          <DialogButton onClick={closeModal} style={{ width: 'auto', minWidth: 0, padding: '8px 16px' }}>
            Close
          </DialogButton>
        </div>
      </div>
    </ModalRoot>
  )
}

/**
 * The full check/apply UI, moved off the QAM entirely onto its own page — it was the single largest
 * thing in the panel for the button pressed least often. index.tsx's Content() still runs the
 * automatic dry-run pass every 5 minutes regardless of whether anyone ever opens this page (see its
 * own effect there) — that safety net does not depend on this component existing.
 */
function LaunchOptionsPage() {
  const [outcomes, setOutcomes] = useState<Outcome[]>([])
  const [problem, setProblem] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  // Off on every load, deliberately, and not persisted. Writing to Steam's launch options is the
  // only destructive thing here, and it should be an act rather than a setting someone turned on
  // once. Turn it on after a dry run shows the right values.
  const [write, setWrite] = useState(false)

  const run = async (writeNow: boolean) => {
    setBusy(true)
    try {
      const result = await applyAll(writeNow)
      setOutcomes(result.outcomes)
      setProblem(result.problem)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => { void run(false) }, [])

  // One line the user can read at a glance, so the list below is detail rather than the answer —
  // same mapping the old QAM tab used, chipped so the state reads before the text does.
  const stateChip = (o: Outcome): ToastKind =>
    o.state === 'written' ? 'success'
      : o.state === 'already-correct' ? 'info'
        : o.state === 'would-write' ? 'blocked'
          : 'error'

  return (
    <Section title="Steam launch options">
      <ToggleField
        label="Allow writing to Steam"
        description="Off: read and show what would change. On: actually set launch options."
        checked={write}
        onChange={setWrite}
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '16px 0' }}>
        <DialogButton
          disabled={busy}
          onClick={() => void run(write)}
          style={{ width: 'auto', minWidth: '200px' }}
        >
          {busy ? 'Checking…' : write ? 'Apply now' : 'Check (no changes)'}
        </DialogButton>
      </div>

      {problem === 'no-agent' && <div style={DIM}>SaveLocker is not installed on this device.</div>}
      {problem === 'unreachable' && <div style={DIM}>The SaveLocker agent is not running.</div>}
      {problem && problem !== 'no-agent' && problem !== 'unreachable' && (
        <div style={DIM}>Could not reach the SaveLocker agent ({problem}).</div>
      )}
      {!problem && outcomes.length === 0 && (
        <div style={DIM}>No tracked game launches through Steam.</div>
      )}
      {outcomes.length > 0 && (
        <div style={{ ...DIM, opacity: 0.8, marginBottom: '10px' }}>{summarise(outcomes)}</div>
      )}

      <ScrollBlock>
      {outcomes.map((o) => (
        <Field
          key={o.name}
          bottomSeparator="standard"
          label={
            <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {o.name}
              <Chip kind={stateChip(o)}>{shortState(o)}</Chip>
            </span>
          }
          // The current value is the whole diagnostic on a first run: a game known to carry
          // mangohud that reads back "(empty)" proves the wrong field is being read, and that it
          // must not be allowed to write. Kept verbatim from the old tab.
          description={o.state !== 'already-correct' ? (
            <span style={{ wordBreak: 'break-all' }}>
              <div>now: {o.current === '' ? '(empty)' : o.current}</div>
              <div>target: {o.target}</div>
              {o.detail && <div>error: {o.detail}</div>}
            </span>
          ) : undefined}
        />
      ))}
      </ScrollBlock>
    </Section>
  )
}

/**
 * The agent-wide history `SyncActivityTracker` keeps — every push, pull and refusal from every
 * source on this machine (the QAM's own buttons, Gaming Mode detection, the tray's "Sync All"), not
 * scoped to this plugin's own actions.
 */
function ActivityPage() {
  const [activity, setActivity] = useState<ActivityDto | null>(null)

  useEffect(() => {
    const refresh = async () => {
      const a = await fetchActivity()
      if (a.ok) setActivity(a.data)
    }
    void refresh()
    const t = setInterval(() => void refresh(), 15 * 1000)
    return () => clearInterval(t)
  }, [])

  const entries: ActivityLogEntry[] = activity?.recent ?? []

  return (
    <Section title="Recent activity">
      {entries.length === 0 && <div style={DIM}>Nothing yet.</div>}
      <ScrollBlock>
      {entries.map((e, i) => (
        <Field
          key={i}
          bottomSeparator="standard"
          label={<span style={{ fontSize: '15px' }}>{e.message}</span>}
          description={timeAgo(e.timestampUtc)}
        />
      ))}
      </ScrollBlock>
    </Section>
  )
}

/**
 * `savelocker doctor`, on demand.
 *
 * Doctor is the only diagnostic a Deck has, and reaching it otherwise means Desktop Mode and a
 * terminal. On-demand only: it makes network calls and takes seconds, so it must never sit on a
 * timer behind a page the user opened for something else.
 */
function DiagnosticsPage() {
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

  return (
    <Section title="Doctor">
      <DialogButton
        disabled={busy}
        onClick={() => void run()}
        style={{ width: '100%', padding: '16px', fontSize: '16px', marginTop: '10px', marginBottom: '20px' }}
      >
        {busy ? 'Running doctor…' : 'Run doctor'}
      </DialogButton>

      {problem && (
        <div style={{ ...DIM, marginBottom: '10px' }}>
          {problem === 'no-agent' ? 'SaveLocker is not installed on this device.'
            : problem === 'timeout' ? 'doctor did not finish within 60 seconds.'
              : `Could not run doctor (${problem}).`}
        </div>
      )}

      {result && (
        <ScrollBlock>
          <div style={{ ...DIM, marginBottom: '8px' }}>
            {result.exitCode === 0 ? 'No problems found.' : `Exited ${result.exitCode} — see below.`}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontFamily: 'var(--font-mono, monospace)' }}>
            {/* The agent's own words, verbatim — same principle as Activity and Sync's output. */}
            {result.output.split('\n').filter((l) => l.trim() !== '').map((l, i) => (
              <div key={i} style={{
                background: 'rgba(255,255,255,0.04)', borderRadius: '4px', padding: '5px 8px',
                fontSize: '12px', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
              }}
              >
                {l}
              </div>
            ))}
          </div>
        </ScrollBlock>
      )}
    </Section>
  )
}

/**
 * Bug 2 (kept as a safety net): this route could open scrolled partway down instead of at the top,
 * because Steam's gamepad navigation scrolls whatever holds focus into view on route entry. Rather
 * than guess which Steam-owned ancestor is the actual scrolling element (its class names are
 * build-hashed), this walks every ancestor of the page root and zeroes `scrollTop` on whichever
 * ones are actually scrollable.
 *
 * Run more than once: the focus-driven scroll this is correcting for happens asynchronously (after
 * route entry settles, and again as each page's own data fetch resolves and its content's height
 * changes), so a single reset immediately on mount can be undone a frame or two later by the same
 * thing this is working around.
 */
function resetFullPageScroll(): void {
  const root = document.querySelector('.savelocker-fullpage')
  let node: Element | null = root
  while (node) {
    if (node.scrollHeight > node.clientHeight) node.scrollTop = 0
    node = node.parentElement
  }
}

/**
 * One sub-route per page, under the plugin's own route.
 *
 * Steam's PagedSettingsDialog wrapper is route-driven, not state-driven (read out of the client's
 * own bundle, chunk~2dcc5aaf7.js): it rewrites every page's `identifier` to `link || route`, picks
 * the active page by matching `route` against the current location, and on a press calls
 * `history.replace(route)`. A page with no `route` therefore gets `identifier: undefined`, every
 * press compares `undefined` with `undefined` and returns early — which is exactly how this page
 * shipped first: the list rendered, and pressing any entry did nothing. The `page` /
 * `onPageRequested` props @decky/ui still types are not how the current client decides either.
 *
 * Decky's route for `/savelocker` is not `exact`, so `/savelocker/games` still renders this
 * component; the bare route (what the QAM's Settings row navigates to) matches no page and the
 * dialog falls back to the first one, Status. Decky's own settings page is built the same way.
 *
 * `visible: true` is not optional either, despite reading like a default. The page list keeps a
 * separator only when some page after it has `visible` explicitly truthy, and otherwise drops it —
 * while the highlighted entry is still picked by index into the UNfiltered list. With `visible`
 * unset the separator vanished and every page below it was off by one on hardware: on Activity,
 * Diagnostics lit up; on Diagnostics, nothing did.
 */
const pageRoute = (page: string) => `${SAVELOCKER_PAGE_ROUTE}/${page}`

/** Marks a page's content so `activePageScroller` can find the container that scrolls it. */
const page = (content: React.ReactNode) => <div className="savelocker-page">{content}</div>

export function FullPage() {
  useRightStickScroll()

  useEffect(() => {
    resetFullPageScroll()
    const raf = requestAnimationFrame(resetFullPageScroll)
    const timer = setTimeout(resetFullPageScroll, 300)
    return () => { cancelAnimationFrame(raf); clearTimeout(timer) }
  }, [])

  return (
    <div className="savelocker-fullpage" style={{ height: '100%', minHeight: '100%' }}>
      {/* SidebarNavigation is Steam's own PagedSettingsDialog (see @decky/ui's resolution in
          SidebarNavigation.js): title and page list on the left, the active page's content on the
          right, with Valve's focus/scroll handling. Only the active page's content mounts, so each
          page's polling starts and stops with it. Navigation between pages is by route — see
          `pageRoute` above for why it cannot be anything else. */}
      <SidebarNavigation
        title="SaveLocker"
        showTitle
        pages={[
          { title: 'Status', content: page(<StatusPage />), icon: <FaShieldAlt />, route: pageRoute('status'), visible: true },
          { title: 'Games', content: page(<GamesPage />), icon: <FaGamepad />, route: pageRoute('games'), visible: true },
          { title: 'Launch options', content: page(<LaunchOptionsPage />), icon: <FaRocket />, route: pageRoute('launch'), visible: true },
          'separator',
          { title: 'Activity', content: page(<ActivityPage />), icon: <FaHistory />, route: pageRoute('activity'), visible: true },
          { title: 'Diagnostics', content: page(<DiagnosticsPage />), icon: <FaStethoscope />, route: pageRoute('diagnostics'), visible: true },
        ]}
      />
    </div>
  )
}
