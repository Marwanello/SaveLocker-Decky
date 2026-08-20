import { useEffect, useState } from 'react'
import {
  DialogButton, Focusable, PanelSection, PanelSectionRow, Tabs, TextField, ToggleField,
} from '@decky/ui'
import { callable } from '@decky/api'
import {
  ReadOnlyRow, applyAll, shortState, summarise, timeAgo,
  fetchGames, fetchRows, fetchState, fetchVersion, fetchActivity, runDoctor, runSync,
  type ActivityDto, type ActivityLogEntry, type AgentResult, type AgentState, type AgentVersion,
  type DoctorResult, type Outcome, type Row, type TrackedGame,
} from './shared'
import { resolvePullEnabled } from './gamingSync'

/**
 * The full-screen SaveLocker page — everything that was crowding the Quick Access panel (per-game
 * alias/pull settings, the full activity history, doctor's raw output, the launch-options detail
 * list) moved here instead, reachable from the QAM's own "Settings" button (index.tsx's
 * `openSettings`). Registered via `routerHook.addRoute` in index.tsx's `definePlugin`, not here —
 * the route belongs to the plugin's lifetime, not to this component's.
 */
export const SAVELOCKER_PAGE_ROUTE = '/savelocker'

const setAlias = callable<[string, string | null], AgentResult<null>>('set_alias')
const persistPullEnabled = callable<[string, boolean | null], void>('set_gaming_pull_enabled')
const fetchPullOverrides = callable<[], Record<string, boolean>>('gaming_pull_overrides')

/**
 * One game's row in the Overview tab's list: name, the effective alias (defaulting to the game's
 * own name, same as the old QAM picker did), and the pull-before-launch toggle — all inline, no
 * dropdown, so there's nothing here that depends on the QAM's own dropdown-remounts-the-panel quirk.
 */
function GameRow({ game, isSteamGame, pullEnabled, onChanged }: {
  game: TrackedGame
  isSteamGame: boolean
  pullEnabled: boolean
  onChanged: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const effective = game.alias ?? game.name

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

  const togglePull = (value: boolean) => {
    void persistPullEnabled(game.gameId, value)
    onChanged()
  }

  return (
    <Focusable
      style={{
        background: 'rgba(255,255,255,0.04)', borderRadius: '8px', padding: '10px 14px',
        marginBottom: '6px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 220px', minWidth: 0 }}>
          <div style={{ fontSize: '15px' }}>{game.name}</div>
          {!editing && (
            <div style={{ fontSize: '12px', opacity: 0.65 }}>
              alias: {effective} · {isSteamGame ? 'Steam App ID resolved' : 'no Steam App ID'}
            </div>
          )}
        </div>
        {!editing && (
          <>
            <ToggleField label="Pull before launch" checked={pullEnabled} onChange={togglePull} />
            <DialogButton onClick={startEdit} style={{ width: 'auto', minWidth: 0, padding: '8px 14px' }}>
              Edit alias
            </DialogButton>
          </>
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
    </Focusable>
  )
}

function OverviewTab() {
  const [state, setState] = useState<AgentState | null>(null)
  const [version, setVersion] = useState<AgentVersion | null>(null)
  const [games, setGames] = useState<TrackedGame[]>([])
  const [rows, setRows] = useState<Row[]>([])
  const [activity, setActivity] = useState<ActivityDto | null>(null)
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})
  const [search, setSearch] = useState('')
  const [syncing, setSyncing] = useState(false)

  const refresh = async () => {
    const [s, v, g, r, a, o] = await Promise.all([
      fetchState(), fetchVersion(), fetchGames(), fetchRows(), fetchActivity(), fetchPullOverrides(),
    ])
    if (s.ok) setState(s.data)
    if (v.ok) setVersion(v.data)
    if (g.ok) setGames(g.data)
    if (r.ok) setRows(r.data)
    if (a.ok) setActivity(a.data)
    setOverrides(o)
  }

  useEffect(() => {
    void refresh()
    // Same cadence as the QAM's own Status/Activity polling (index.tsx's Content()) — this page
    // polls independently rather than sharing that timer, since it can be open at the same time as
    // (or instead of) the QAM.
    const t = setInterval(() => void refresh(), 5 * 1000)
    return () => clearInterval(t)
  }, [])

  const steamGameIds = new Set(rows.map((r) => r.gameId))
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

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px', marginBottom: '20px' }}>
        {[
          ['Server', state ? (state.connected ? state.machineName : 'not connected') : '—'],
          ['Games', state ? String(state.gamesTracked) : '—'],
          ['Last sync', state ? state.lastSyncAgo : '—'],
          ['Agent', state ? state.currentVersion : '—'],
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
      <div style={{ maxHeight: '320px', overflowY: 'auto', marginBottom: '24px' }}>
        {filtered.length === 0 && (
          <div style={{ opacity: 0.6, fontSize: '13px', padding: '8px 2px' }}>
            {games.length === 0 ? 'No tracked games yet.' : `No games match "${search.trim()}".`}
          </div>
        )}
        {filtered.map((g) => (
          <GameRow
            key={g.gameId}
            game={g}
            isSteamGame={steamGameIds.has(g.gameId)}
            pullEnabled={resolvePullEnabled(overrides, g.gameId, steamGameIds.has(g.gameId))}
            onChanged={() => void refresh()}
          />
        ))}
      </div>

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
      <div style={{ marginBottom: '14px' }}>
        <DialogButton disabled={busy} onClick={() => void run()} style={{ width: 'auto', minWidth: 0 }}>
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

export function FullPage() {
  const [activeTab, setActiveTab] = useState('overview')

  const tabs = [
    { id: 'overview', title: 'Overview', content: <OverviewTab /> },
    { id: 'diagnostics', title: 'Diagnostics', content: <Diagnostics /> },
    { id: 'launch', title: 'Launch options', content: <LaunchOptions /> },
  ]

  return (
    // marginTop clears Steam's own window chrome above a routed full page — matched to what other
    // Decky plugins with a settings route use; needs hardware verification, not something checkable
    // outside Steam's own JS context.
    <div style={{ marginTop: '40px', height: 'calc(100% - 40px)' }}>
      <Tabs activeTab={activeTab} onShowTab={setActiveTab} tabs={tabs} />
    </div>
  )
}
