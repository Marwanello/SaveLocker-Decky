import { useEffect, useState } from 'react'
import {
  ConfirmModal, DialogButton, DropdownItem, Focusable, Menu, MenuItem, ModalRoot, showContextMenu, showModal,
} from '@decky/ui'
import { callable } from '@decky/api'
import { FaChevronDown } from 'react-icons/fa'
import { fetchActivity, type ActivityLogEntry, type AgentResult } from './shared'
import { KIND_STYLE, saveLockerToast } from './toast'

/**
 * Playthroughs (SaveLocker tasks/save-playthroughs Phase 8): a game can have several named lines of saves, and
 * each device follows one. This is the Deck's half of it — a dropdown on a Games row and in the Quick Access
 * panel that puts THIS Deck on another one.
 *
 * The plugin decides nothing here. The agent owns the whole switch (it pushes the outgoing save to its own
 * line first, refuses while the game runs or a conflict is open, and restores the target), so this file only
 * asks, shows the steps from the agent's activity feed while it runs, and puts the agent's answer in a dialog.
 * A leaf module (nothing here imports index.tsx or fullPage.tsx), so both can use it.
 */

/** `PlaythroughDto` (`Contracts.cs`), the part this plugin reads. */
export interface Playthrough {
  id: string
  name: string
  isDefault: boolean
  archivedAt: string | null
  head: { createdAt: string; machineName: string } | null
  hasOpenConflict: boolean
}

/** `GamePlaythroughsDto` (`AgentApiServer.Playthroughs.cs`). `playthroughs` is empty when the server could not
 * be reached (`offline`), and the agent can then only switch to a playthrough it holds a copy of. */
export interface GamePlaythroughs {
  selectedId: string | null
  selectedName: string | null
  offline: boolean
  selectPending: boolean
  playthroughs: Playthrough[]
}

/** `SwitchPlaythroughResponse`: the finished result. A refusal is `ok: false` with the reason in `message`. */
export interface SwitchResult {
  ok: boolean
  message: string
  offline: boolean
  playthroughId: string | null
}

const fetchPlaythroughs = callable<[string], AgentResult<GamePlaythroughs>>('playthroughs')
const switchPlaythrough = callable<[string, string], AgentResult<SwitchResult>>('switch_playthrough')

/** What a game needs to be switched: its id and its name (for the dialogs). */
export interface SwitchGame { gameId: string; name: string }

/** A game has a choice to offer once the agent has seen a second playthrough. The count can include an archived
 * one, so the dropdown itself still checks the list. */
export const hasPlaythroughs = (g: { playthroughCount?: number | null }): boolean => (g.playthroughCount ?? 1) > 1

// The list is one agent round trip that itself asks the server, and a Games page can show a dozen dropdowns.
// A short memory means a row does not re-ask while the page redraws; a switch clears it.
const CACHE_MS = 20 * 1000
const cache = new Map<string, { at: number; value: GamePlaythroughs }>()
const inFlight = new Map<string, Promise<GamePlaythroughs | null>>()

function forget(gameId: string) {
  cache.delete(gameId)
  inFlight.delete(gameId)
}

export function loadPlaythroughs(gameId: string, force = false): Promise<GamePlaythroughs | null> {
  const hit = cache.get(gameId)
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit.value)
  const pending = inFlight.get(gameId)
  if (pending) return pending
  const p = fetchPlaythroughs(gameId)
    .then((r) => {
      if (!r.ok) return null
      cache.set(gameId, { at: Date.now(), value: r.data })
      return r.data
    })
    .catch(() => null)
    .finally(() => inFlight.delete(gameId))
  inFlight.set(gameId, p)
  return p
}

/** One game's list, loaded on mount. `reload` skips the memory (after a switch). */
export function usePlaythroughs(gameId: string | null): { list: GamePlaythroughs | null; reload: () => void } {
  const [list, setList] = useState<GamePlaythroughs | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!gameId) { setList(null); return }
    let alive = true
    void loadPlaythroughs(gameId, tick > 0).then((l) => { if (alive) setList(l) })
    return () => { alive = false }
  }, [gameId, tick])
  return { list, reload: () => setTick((t) => t + 1) }
}

/** The playthroughs a device can be put on: archived ones are out of the picker (the console un-archives them). */
export const choices = (l: GamePlaythroughs): Playthrough[] => l.playthroughs.filter((p) => p.archivedAt === null)

const ago = (iso: string | undefined): string => {
  if (!iso) return 'no save yet'
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 48) return `${hrs} h ago`
  return `${Math.round(hrs / 24)} d ago`
}

function reasonText(reason: string): string {
  if (reason === 'no-agent') return 'SaveLocker is not installed on this Deck.'
  if (reason === 'unreachable') return 'The SaveLocker agent is not running.'
  if (reason === 'timeout') return 'The agent did not answer in time. Check the activity page before trying again.'
  // The agent predates playthroughs: the route is simply not there.
  if (reason === 'http-404') return 'This SaveLocker agent is too old to switch playthroughs. Update it first.'
  if (reason === 'http-409') return 'A sync of this game is already running. Try again when it has finished.'
  return `The agent answered with an error (${reason}).`
}

/** The agent's feed lines from this switch on, newest last. The feed is shared with every other sync, so a line
 * is only this switch's if it is newer than the click (with a little slack for clock rounding). */
function stepsSince(entries: ActivityLogEntry[], startedAt: number): string[] {
  return entries
    .filter((e) => new Date(e.timestampUtc).getTime() >= startedAt - 2000)
    .map((e) => e.message)
    .slice(-6)
}

type Phase = 'run' | 'ok' | 'fail'

/**
 * The explicit result dialog for a switch (never a toast: a toast is gone before it can be read on a handheld).
 * It cannot be dismissed while the switch runs — closing a restore's progress would leave no sign of how it ended.
 */
function SwitchModal({ game, from, to, onFinished, closeModal }: {
  game: SwitchGame
  from: string | null
  to: Playthrough
  onFinished: (ok: boolean) => void
  closeModal?: () => void
}) {
  const [phase, setPhase] = useState<Phase>('run')
  const [message, setMessage] = useState('')
  const [steps, setSteps] = useState<string[]>([])

  useEffect(() => {
    const startedAt = Date.now()
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      const a = await fetchActivity()
      if (!alive) return
      if (a.ok) setSteps(stepsSince(a.data.recent, startedAt))
      timer = setTimeout(() => void poll(), 1000)
    }
    void poll()
    void (async () => {
      const r = await switchPlaythrough(game.gameId, to.id)
      if (!alive) return
      forget(game.gameId)
      if (!r.ok) { setPhase('fail'); setMessage(reasonText(r.reason)); onFinished(false); return }
      setPhase(r.data.ok ? 'ok' : 'fail')
      setMessage(r.data.message)
      onFinished(r.data.ok)
    })()
    return () => { alive = false; clearTimeout(timer) }
    // One switch per mount: the dependencies are fixed for the life of the dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const running = phase === 'run'
  const { fg } = KIND_STYLE[phase === 'ok' ? 'success' : phase === 'fail' ? 'error' : 'syncing']
  return (
    <ModalRoot
      closeModal={running ? undefined : closeModal}
      onCancel={running ? undefined : closeModal}
      bCancelDisabled={running}
      bHideCloseIcon={running}
      bDisableBackgroundDismiss={running}
    >
      <div style={{ padding: '20px', maxWidth: '560px' }}>
        <div style={{ fontSize: '16px', fontWeight: 700, marginBottom: '6px', color: fg }}>
          {running ? `Switching to ${to.name}…` : phase === 'ok' ? `Now playing ${to.name}` : 'Could not switch'}
        </div>
        <div style={{ fontSize: '13px', opacity: 0.75, marginBottom: '14px' }}>{game.name}</div>
        {running && (
          <div style={{ fontSize: '13px', opacity: 0.8, lineHeight: 1.5, marginBottom: '12px' }}>
            {from ? `${from} is uploaded to its own playthrough first, then ${to.name} is put in the save folder.` : `Putting ${to.name} in the save folder.`}
          </div>
        )}
        {!running && <div style={{ fontSize: '14px', lineHeight: 1.5, marginBottom: '12px' }}>{message}</div>}
        {steps.length > 0 && (
          <div style={{ fontSize: '12px', opacity: 0.65, lineHeight: 1.6, marginBottom: '14px' }}>
            {steps.map((s, i) => <div key={i}>{s}</div>)}
          </div>
        )}
        {!running && (
          <Focusable style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <DialogButton onClick={closeModal} style={{ width: 'auto', minWidth: 0, padding: '8px 16px' }}>OK</DialogButton>
          </Focusable>
        )}
      </div>
    </ModalRoot>
  )
}

/**
 * Pick-then-switch: ask once, then run the switch behind the progress/result dialog. `onDone` fires when the
 * switch has finished either way, so the caller can redraw (the new name, the dropdown's tick).
 */
export function confirmSwitch(game: SwitchGame, current: Playthrough | null, to: Playthrough, onDone: () => void): void {
  if (to.id === current?.id) return
  const run = () => {
    showModal(<SwitchModal game={game} from={current?.name ?? null} to={to} onFinished={() => onDone()} />)
  }
  showModal(
    <ConfirmModal
      strTitle={`Play ${to.name} on this Steam Deck?`}
      strDescription={current
        ? `${current.name} is uploaded to its own playthrough first, so nothing is lost. Your other devices keep their playthroughs.`
        : 'Your other devices keep their playthroughs.'}
      strOKButtonText="Switch"
      onOK={run}
    />,
  )
}

/** Why a game cannot be switched right now, or null. Only what the list itself shows; the agent still decides. */
function blockedReason(to: Playthrough): string | null {
  if (to.hasOpenConflict) return `${to.name} has an unresolved save conflict.`
  return null
}

/**
 * The small dropdown button on a Games row and under a poster in Grid: the playthrough this Deck plays, a
 * chevron, and a menu of the others. Renders nothing for a game with only one playthrough.
 */
export function PlaythroughButton({ game, count, selectedName, onChanged }: {
  game: SwitchGame
  count: number | null | undefined
  selectedName?: string | null
  onChanged?: () => void
}) {
  const multi = hasPlaythroughs({ playthroughCount: count })
  const { list, reload } = usePlaythroughs(multi ? game.gameId : null)
  if (!multi) return null

  const options = list ? choices(list) : []
  const current = list ? options.find((p) => p.id === list.selectedId) ?? null : null
  const label = current?.name ?? list?.selectedName ?? selectedName ?? 'Playthrough'

  const open = (e: any) => {
    if (!list) return
    if (list.offline || options.length === 0) {
      saveLockerToast('blocked', 'Cannot list playthroughs', 'The server is not reachable from this Deck.')
      return
    }
    showContextMenu(
      <Menu label={`Playthrough · ${game.name}`}>
        {options.map((p) => (
          <MenuItem
            key={p.id}
            selected={p.id === list.selectedId}
            onSelected={() => {
              const why = blockedReason(p)
              if (why) { saveLockerToast('blocked', 'Cannot switch', why); return }
              confirmSwitch(game, current, p, () => { reload(); onChanged?.() })
            }}
          >
            {p.id === list.selectedId ? '✓ ' : ''}{p.name} · {ago(p.head?.createdAt)}
          </MenuItem>
        ))}
      </Menu>,
      e?.currentTarget ?? window,
    )
  }

  return (
    <DialogButton
      onClick={open}
      onOKButton={open}
      style={{ width: 'auto', minWidth: 0, padding: '6px 12px', flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}
    >
      {label}
      <FaChevronDown style={{ fontSize: '10px', opacity: 0.7 }} />
    </DialogButton>
  )
}

/**
 * The same choice as a Steam dropdown, for the Quick Access panel and the Sync options dialog (a row of its
 * own there, so it uses the panel's own DropdownItem). `gameId` null means "all games": there is nothing to pick.
 */
export function PlaythroughDropdown({ game, count, onChanged, disabled }: {
  game: SwitchGame | null
  count: number | null | undefined
  onChanged?: () => void
  disabled?: boolean
}) {
  const multi = game !== null && hasPlaythroughs({ playthroughCount: count })
  const { list, reload } = usePlaythroughs(multi ? game.gameId : null)
  if (!multi || !game || !list) return null
  const options = choices(list)
  if (options.length < 2) return null
  const current = options.find((p) => p.id === list.selectedId) ?? null

  return (
    <DropdownItem
      label="Playthrough"
      description={`${options.length} for this game · switching uploads ${current?.name ?? 'the current one'} first`}
      disabled={disabled || list.offline}
      rgOptions={options.map((p) => ({ data: p.id, label: `${p.name} · ${ago(p.head?.createdAt)}` }))}
      selectedOption={list.selectedId ?? undefined}
      onChange={(o: any) => {
        // Steam's own Dropdown, resolved out of CommonUIModule by shape: accept the option object or a bare value.
        const picked = o && typeof o === 'object' && 'data' in o ? o.data : o
        const to = options.find((p) => p.id === picked)
        if (!to) return
        const why = blockedReason(to)
        if (why) { saveLockerToast('blocked', 'Cannot switch', why); return }
        confirmSwitch(game, current, to, () => { reload(); onChanged?.() })
      }}
    />
  )
}
