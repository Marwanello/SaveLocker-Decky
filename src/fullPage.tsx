import { useEffect, useState } from 'react'
import {
  DialogButton, DropdownItem, Focusable, PanelSection, PanelSectionRow, Tabs, TextField, ToggleField,
} from '@decky/ui'
import { callable } from '@decky/api'
import {
  ReadOnlyRow, applyAll, shortState, summarise, timeAgo,
  fetchConflictPolicy, fetchGames, fetchState, fetchVersion, fetchActivity, fetchPluginVersion,
  fetchSyncStatus, runDoctor, runSync, setConflictPolicy,
  type ActivityDto, type ActivityLogEntry, type AgentResult, type AgentState, type AgentVersion,
  type ConflictPolicyKind, type ConflictPolicySetting, type DoctorResult, type Outcome,
  type SyncStatus, type TrackedGame,
} from './shared'
import { openConflictResolveModal } from './conflicts'
import { persistSyncOnOpen, resolvePullEnabled } from './gamingSync'

/** The three values verbatim (`ConflictPolicy` in `src/Shared/Contracts.cs`) — "Prefer this device"
 * rather than a full machine picker, since a Decky settings row has no fleet-wide machine list to
 * choose from (only the dashboard does); it always targets THIS device's own machine id. */
const CONFLICT_POLICY_OPTIONS: { data: ConflictPolicyKind; label: string }[] = [
  { data: 'Manual', label: 'Ask me every time' },
  { data: 'NewestWins', label: 'Newest save always wins' },
  { data: 'PreferMachine', label: 'Prefer this device' },
]

/**
 * The full-screen SaveLocker page — everything that was crowding the Quick Access panel (per-game
 * alias/pull settings, the full activity history, doctor's raw output, the launch-options detail
 * list) moved here instead, reachable from the QAM's own "Settings" button (index.tsx's
 * `openSettings`). Registered via `routerHook.addRoute` in index.tsx's `definePlugin`, not here —
 * the route belongs to the plugin's lifetime, not to this component's.
 */
export const SAVELOCKER_PAGE_ROUTE = '/savelocker'

const setAlias = callable<[string, string | null], AgentResult<null>>('set_alias')
const persistPullBeforeLaunch = callable<[string, boolean | null], AgentResult<null>>('set_pull_before_launch')
const fetchSyncOnOpenOverrides = callable<[], Record<string, boolean>>('gaming_sync_on_open_overrides')

/**
 * One game's row in the Overview tab's list: name, the effective alias (defaulting to the game's
 * own name, same as the old QAM picker did), and the pull-before-launch toggle — all inline, no
 * dropdown, so there's nothing here that depends on the QAM's own dropdown-remounts-the-panel quirk.
 */
function GameRow({ game, syncOnOpenEnabled, machineId, onChanged, onSyncOnOpenChanged }: {
  game: TrackedGame
  syncOnOpenEnabled: boolean
  /** This device's own machine id (from `/api/state`), or null before this device has registered. */
  machineId: string | null
  onChanged: () => void
  onSyncOnOpenChanged: (gameId: string, value: boolean) => void
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

  useEffect(() => {
    void fetchConflictPolicy(game.gameId).then((r) => { if (r.ok) setPolicy(r.data) })
  }, [game.gameId])

  // On demand only — plan.md Phase 12 is explicit that this must never run on a timer or a passive
  // list refresh: the route hashes the whole save folder to answer, the same disk cost a push's own
  // hash pays, so it only runs when this row's own button is pressed.
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

  return (
    <Focusable
      style={{
        background: 'rgba(255,255,255,0.04)', borderRadius: '8px', padding: '10px 14px',
        marginBottom: '6px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 140px', minWidth: 0 }}>
          <div style={{ fontSize: '15px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {game.name}
          </div>
          {!editing && (
            <div style={{
              fontSize: '12px', opacity: 0.65, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
            >
              alias: {effective} · {game.hasSteamCloud ? 'Steam Cloud' : 'no Steam Cloud'}
            </div>
          )}
        </div>
        {!editing && (
          // flow-children="right": the pull toggle and the edit-alias button are two controls
          // side by side in the same row — without this they inherit the list's vertical "down"
          // flow, so left/right would fall through this row's boundary before ever switching
          // between them, instead of picking one and reserving down for the next game.
          //
          // flexShrink: 0 + flexWrap: 'nowrap' here, and a fixed width on each ToggleField's own
          // wrapper below: Steam's `ToggleField` (pulled from CommonUIModule, not this plugin's own
          // component) lays itself out to fill 100% of whatever it's given rather than sizing to its
          // label, so left unconstrained inside a flex row it claims far more width than the visible
          // switch+label need — enough that adding the second toggle overflowed this row and pushed
          // the OUTER row (the one with the game name) to wrap onto a new line entirely, rather than
          // just this inner row reflowing on its own. Each toggle's fixed-width wrapper below caps
          // that 100% against something narrow instead of the page.
          <Focusable
            flow-children="right"
            style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'nowrap', flexShrink: 0 }}
          >
            <div style={{ width: '200px', flexShrink: 0 }}>
              <ToggleField
                label="Pull before launch"
                checked={pullEnabled}
                disabled={pullBusy}
                onChange={(value: boolean) => void togglePull(value)}
              />
            </div>
            {/* Only shown once "Pull before launch" is on — the setting is meaningless without it,
                so it disappears rather than showing disabled (a disabled control with no visible
                reason why invites poking at it to find out). On by default: see
                `resolveSyncOnOpenEnabled` in gamingSync.tsx.

                This MOVES the pull rather than adding a second one: with it on, opening the game's
                library page pulls (and the page's status chip reports it), and pressing Play then
                launches straight through instead of pulling again. `gamingSync.tsx` still falls back
                to pulling at launch if no page-open pull actually happened — launching from a
                collection or the Recents row never opens the page at all. */}
            {pullEnabled && (
              <div style={{ width: '180px', flexShrink: 0 }}>
                <ToggleField
                  label="Sync on page open"
                  checked={syncOnOpenEnabled}
                  disabled={syncOnOpenBusy}
                  onChange={(value: boolean) => void toggleSyncOnOpen(value)}
                />
              </div>
            )}
            <DialogButton
              onClick={startEdit}
              style={{ width: 'auto', minWidth: 0, padding: '8px 14px', flexShrink: 0 }}
            >
              Edit alias
            </DialogButton>
          </Focusable>
        )}
      </div>
      {editing && (
        <Focusable style={{ display: 'flex', gap: '8px', marginTop: '8px', alignItems: 'center' }}>
          <div style={{ flex: 1 }}>
            <TextField value={draft} onChange={(e: any) => setDraft(e?.target?.value ?? '')} />
          </div>
          <DialogButton disabled={busy} onClick={() => void save()} style={{ width: 'auto', minWidth: 0 }}>
            {busy ? 'Saving…' : 'Save'}
          </DialogButton>
          <DialogButton disabled={busy} onClick={() => setEditing(false)} style={{ width: 'auto', minWidth: 0 }}>
            Cancel
          </DialogButton>
        </Focusable>
      )}
      {!editing && (
        <Focusable style={{ marginTop: '6px', maxWidth: '280px' }}>
          <DropdownItem
            label="If a save conflict happens"
            rgOptions={CONFLICT_POLICY_OPTIONS}
            selectedOption={policy?.policy ?? 'Manual'}
            disabled={policyBusy}
            onChange={(o: any) => {
              const picked = o && typeof o === 'object' && 'data' in o ? o.data : o
              void changePolicy(picked as ConflictPolicyKind)
            }}
          />
          {/* This device can only ever set "prefer THIS device" (there is no fleet-wide machine
              picker here) — if the dashboard or another device already set a DIFFERENT preferred
              machine, say so rather than silently implying this dropdown already reflects that. */}
          {policy?.policy === 'PreferMachine' && policy.preferredMachineId
            && machineId !== null && policy.preferredMachineId !== machineId && (
            <div style={{ fontSize: '10px', opacity: 0.6, marginTop: '2px' }}>
              Currently prefers a different device — set from the dashboard.
            </div>
          )}
        </Focusable>
      )}
      {!editing && (
        <Focusable style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '8px' }}>
          <DialogButton
            disabled={syncStatusBusy}
            onClick={() => void checkSyncStatus()}
            style={{ width: 'auto', minWidth: 0, padding: '8px 14px', flexShrink: 0 }}
          >
            {syncStatusBusy ? 'Checking…' : 'Check sync status'}
          </DialogButton>
          {syncStatusError && (
            <span style={{ fontSize: '12px', opacity: 0.7 }}>
              {syncStatusError === 'no-agent' ? 'SaveLocker is not installed on this device.'
                : syncStatusError === 'unreachable' ? 'The SaveLocker agent is not running.'
                  : `Could not check (${syncStatusError}).`}
            </span>
          )}
          {syncStatus && !syncStatusError && (
            syncStatus.hasOpenConflict && syncStatus.conflictId ? (
              <DialogButton
                onClick={() => openConflictResolveModal(syncStatus.conflictId!)}
                style={{ width: 'auto', minWidth: 0, padding: '8px 14px', flexShrink: 0 }}
              >
                Open conflict — resolve
              </DialogButton>
            ) : (
              <span style={{ fontSize: '12px', opacity: 0.8 }}>
                {syncStatus.inSync ? 'In sync with the cloud.' : 'Out of sync with the cloud.'}
              </span>
            )
          )}
        </Focusable>
      )}
    </Focusable>
  )
}

function OverviewTab() {
  const [state, setState] = useState<AgentState | null>(null)
  const [version, setVersion] = useState<AgentVersion | null>(null)
  const [pluginVersion, setPluginVersion] = useState<string | null>(null)
  const [games, setGames] = useState<TrackedGame[]>([])
  const [activity, setActivity] = useState<ActivityDto | null>(null)
  const [search, setSearch] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [syncOnOpenOverrides, setSyncOnOpenOverrides] = useState<Record<string, boolean>>({})

  const refresh = async () => {
    const [s, v, g, a, o] = await Promise.all([
      fetchState(), fetchVersion(), fetchGames(), fetchActivity(), fetchSyncOnOpenOverrides(),
    ])
    if (s.ok) setState(s.data)
    if (v.ok) setVersion(v.data)
    if (g.ok) setGames(g.data)
    if (a.ok) setActivity(a.data)
    setSyncOnOpenOverrides(o)
  }

  useEffect(() => {
    void refresh()
    // The plugin's own version never changes at runtime, unlike everything else here — fetched once
    // rather than on every poll tick.
    void fetchPluginVersion().then(setPluginVersion)
    // Same cadence as the QAM's own Status/Activity polling (index.tsx's Content()) — this page
    // polls independently rather than sharing that timer, since it can be open at the same time as
    // (or instead of) the QAM.
    const t = setInterval(() => void refresh(), 5 * 1000)
    return () => clearInterval(t)
  }, [])

  const query = search.trim().toLowerCase()
  const filtered = query === '' ? games : games.filter((g) => {
    const effective = (g.alias ?? g.name).toLowerCase()
    return g.name.toLowerCase().includes(query) || effective.includes(query)
  })

  const syncAll = async () => {
    setSyncing(true)
    try {
      await runSync('pull', null, false)
      await runSync('push', null, false)
      await refresh()
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '16px' }}>
        <DialogButton disabled={syncing} onClick={() => void syncAll()} style={{ width: 'auto', minWidth: 0 }}>
          {syncing ? 'Syncing…' : 'Sync all games'}
        </DialogButton>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '10px', marginBottom: '20px' }}>
        {[
          ['Server', state ? (state.connected ? state.machineName : 'not connected') : '—'],
          ['Games', state ? String(state.gamesTracked) : '—'],
          ['Last sync', state ? state.lastSyncAgo : '—'],
          ['Agent', state ? state.currentVersion : '—'],
          ['Plugin', pluginVersion ?? '—'],
        ].map(([label, value]) => (
          <div key={label} style={{ background: 'rgba(255,255,255,0.04)', borderRadius: '8px', padding: '10px' }}>
            <div style={{ fontSize: '11px', opacity: 0.6 }}>{label}</div>
            <div style={{ fontSize: '15px' }}>{value}</div>
          </div>
        ))}
      </div>
      {version?.stagedVersion && (
        <div style={{ opacity: 0.75, fontSize: '13px', marginBottom: '16px' }}>
          v{version.stagedVersion} is downloaded and verified — install it from the Quick Access panel.
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '8px' }}>
        <span style={{ fontSize: '13px', opacity: 0.6, letterSpacing: '0.04em' }}>GAMES</span>
        <span style={{ fontSize: '12px', opacity: 0.6 }}>
          {query === '' ? `${games.length} total` : `${filtered.length} of ${games.length}`}
        </span>
      </div>
      <div style={{ marginBottom: '10px' }}>
        <TextField label="Search games" value={search} onChange={(e: any) => setSearch(e?.target?.value ?? '')} />
      </div>
      {/* flow-children="down": without it, D-pad down from a row's toggle can land on that same
          row's "Edit alias" button instead of the next game — Panorama's default flow considers
          both of a row's controls before moving past the row, since a plain wrapped flex layout
          gives it no other ordering to go on. Forcing a vertical flow at the list level makes down
          always step row-to-row regardless of which control inside a row currently has focus. */}
      <Focusable flow-children="down" style={{ maxHeight: '320px', overflowY: 'auto', marginBottom: '24px' }}>
        {filtered.length === 0 && (
          <div style={{ opacity: 0.6, fontSize: '13px', padding: '8px 2px' }}>
            {games.length === 0 ? 'No tracked games yet.' : `No games match "${search.trim()}".`}
          </div>
        )}
        {filtered.map((g) => (
          <GameRow
            key={g.gameId}
            game={g}
            syncOnOpenEnabled={syncOnOpenOverrides[g.gameId] ?? true}
            machineId={state?.machineId ?? null}
            onChanged={() => void refresh()}
            onSyncOnOpenChanged={(gameId, value) => {
              // Optimistic, same reasoning as togglePull's onChanged(): don't wait out the next
              // 5s poll to see the toggle you just flipped reflect back.
              setSyncOnOpenOverrides((prev) => ({ ...prev, [gameId]: value }))
            }}
          />
        ))}
      </Focusable>

      <div style={{ fontSize: '13px', opacity: 0.6, letterSpacing: '0.04em', marginBottom: '8px' }}>ACTIVITY</div>
      <ActivityLog entries={activity?.recent ?? []} />
    </div>
  )
}

/**
 * The agent-wide history `SyncActivityTracker` keeps — every push, pull and refusal from every
 * source on this machine (the QAM's own buttons, Gaming Mode detection, the tray's "Sync All"), not
 * scoped to this plugin's own actions.
 */
function ActivityLog({ entries }: { entries: ActivityLogEntry[] }) {
  return (
    <PanelSection title="Activity">
      {entries.length === 0 && (
        <PanelSectionRow><ReadOnlyRow>Nothing yet.</ReadOnlyRow></PanelSectionRow>
      )}
      {entries.map((e, i) => (
        <PanelSectionRow key={i}>
          <ReadOnlyRow>
            <div style={{ fontSize: '0.8em' }}>
              <div style={{ opacity: 0.7 }}>{timeAgo(e.timestampUtc)}</div>
              {/* The agent's own words, verbatim — same "don't paraphrase a refusal" principle the
                  Sync panel's own output already follows. */}
              <div style={{ wordBreak: 'break-word' }}>{e.message}</div>
            </div>
          </ReadOnlyRow>
        </PanelSectionRow>
      ))}
    </PanelSection>
  )
}

/**
 * `savelocker doctor`, on demand.
 *
 * Doctor is the only diagnostic a Deck has, and reaching it otherwise means Desktop Mode and a
 * terminal. On-demand only: it makes network calls and takes seconds, so it must never sit on a
 * timer behind a panel the user opened for something else.
 */
function Diagnostics() {
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
    <div>
      <div style={{ marginTop: '10px', marginBottom: '20px' }}>
        <DialogButton
          disabled={busy}
          onClick={() => void run()}
          style={{ width: '100%', padding: '16px', fontSize: '16px' }}
        >
          {busy ? 'Running doctor…' : 'Run doctor'}
        </DialogButton>
      </div>
      {problem && (
        <div style={{ opacity: 0.75, fontSize: '13px', marginBottom: '10px' }}>
          {problem === 'no-agent' ? 'SaveLocker is not installed on this device.'
            : problem === 'timeout' ? 'doctor did not finish within 60 seconds.'
              : `Could not run doctor (${problem}).`}
        </div>
      )}
      {result && (
        <div>
          <div style={{ opacity: 0.75, fontSize: '13px', marginBottom: '8px' }}>
            {result.exitCode === 0 ? 'No problems found.' : `Exited ${result.exitCode} — see below.`}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontFamily: 'var(--font-mono, monospace)' }}>
            {/* The agent's own words, verbatim — same principle as ActivityLog and Sync's output. */}
            {result.output.split('\n').filter((l) => l.trim() !== '').map((l, i) => (
              <div key={i} style={{
                background: 'rgba(255,255,255,0.04)', borderRadius: '4px', padding: '5px 8px',
                fontSize: '12px', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
              }}>
                {l}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The full check/apply UI, moved off the QAM entirely onto its own tab here — it was the single
 * largest thing in the panel for the button pressed least often. index.tsx's Content() still runs
 * the automatic dry-run pass every 5 minutes regardless of whether anyone ever opens this tab (see
 * its own effect there) — that safety net does not depend on this component existing.
 */
function LaunchOptions() {
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

  return (
    <div>
      <ToggleField
        label="Allow writing to Steam"
        description="Off: read and show what would change. On: actually set launch options."
        checked={write}
        onChange={setWrite}
      />
      <div style={{ margin: '14px 0' }}>
        <DialogButton disabled={busy} onClick={() => void run(write)} style={{ width: 'auto', minWidth: 0 }}>
          {busy ? 'Checking…' : write ? 'Apply now' : 'Check (no changes)'}
        </DialogButton>
      </div>

      {problem === 'no-agent' && (
        <div style={{ opacity: 0.75, fontSize: '13px' }}>SaveLocker is not installed on this device.</div>
      )}
      {problem === 'unreachable' && (
        <div style={{ opacity: 0.75, fontSize: '13px' }}>The SaveLocker agent is not running.</div>
      )}
      {problem && problem !== 'no-agent' && problem !== 'unreachable' && (
        <div style={{ opacity: 0.75, fontSize: '13px' }}>Could not reach the SaveLocker agent ({problem}).</div>
      )}
      {!problem && outcomes.length === 0 && (
        <div style={{ opacity: 0.75, fontSize: '13px' }}>No tracked game launches through Steam.</div>
      )}
      {outcomes.length > 0 && (
        <div style={{ opacity: 0.8, fontSize: '13px', marginBottom: '10px' }}>{summarise(outcomes)}</div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {outcomes.map((o) => (
          <div key={o.name} style={{ background: 'rgba(255,255,255,0.04)', borderRadius: '6px', padding: '8px 10px', fontSize: '13px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '6px' }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.name}</span>
              <span style={{ flexShrink: 0, opacity: 0.75 }}>{shortState(o)}</span>
            </div>
            {/* The current value is the whole diagnostic on a first run: a game known to carry
                mangohud that reads back "(empty)" proves the wrong field is being read, and that it
                must not be allowed to write. */}
            {o.state !== 'already-correct' && (
              <div style={{ opacity: 0.7, wordBreak: 'break-all', marginTop: '2px', fontSize: '12px' }}>
                <div>now: {o.current === '' ? '(empty)' : o.current}</div>
                <div>target: {o.target}</div>
                {o.detail && <div>error: {o.detail}</div>}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Steam's Tabs component (`TabRowTabs`) animates its header row's horizontal scroll position
 * whenever the active tab changes, so the row can bring an off-screen header into view — with the
 * default transition, switching to a tab whose header sits further right (the third one, here)
 * visibly glitches as the row animates under the newly-mounted content. Killing that transition/
 * animation (borrowed from a fix used by more than one other Decky plugin shipping a Tabs-based
 * full page — Freedeck and its forks) leaves the row jumping straight to position instead, and
 * forces its scroll panels to lay out immediately rather than mid-animation.
 *
 * The `[class*="…"]` selectors match on a substring of Steam's build-hashed CSS module class names
 * (e.g. `TabRowTabs_a1b2c3`), which is stable across Steam client updates in a way a full class name
 * isn't — the same technique `@decky/ui` itself uses internally to locate these components.
 */
const tabStabilityCss = `
  .savelocker-fullpage [class*="TabContentsScroll"],
  .savelocker-fullpage [class*="TabContents"],
  .savelocker-fullpage [class*="ScrollPanel"] {
    overflow-y: auto !important;
  }
  .savelocker-fullpage [class*="TabHeaderRowWrapper"],
  .savelocker-fullpage [class*="TabRowTabs"],
  .savelocker-fullpage [class*="TabsRowScroll"],
  .savelocker-fullpage [class*="TabRow"] {
    transition: none !important;
    animation: none !important;
    scroll-behavior: auto !important;
  }
`

export function FullPage() {
  const [activeTab, setActiveTab] = useState('overview')

  const tabs = [
    { id: 'overview', title: 'Overview', content: <OverviewTab /> },
    { id: 'diagnostics', title: 'Diagnostics', content: <Diagnostics /> },
    { id: 'launch', title: 'Launch options', content: <LaunchOptions /> },
  ]

  return (
    <div className="savelocker-fullpage" style={{ paddingTop: '48px', minHeight: '100%', boxSizing: 'border-box' }}>
      <style>{tabStabilityCss}</style>
      {/* autoFocusContents: without it nothing on the page is focused on mount, so the gamepad has no
          entry point into it at all and L1/R1 (which Steam routes to whatever holds focus) never
          reaches the Tabs component — matches the same prop used by SteamGridDB's own Tabs-based
          full page, one of the most-used Decky plugins, for the identical layout shape. */}
      <Tabs autoFocusContents activeTab={activeTab} onShowTab={setActiveTab} tabs={tabs} />
    </div>
  )
}
