import { useEffect, useState } from 'react'
import { ButtonItem, DialogButton, Focusable, ModalRoot, PanelSection, PanelSectionRow, showModal } from '@decky/ui'
import { callable, toaster } from '@decky/api'
import type { AgentResult } from './shared'
import { ReadOnlyRow } from './shared'

/** One pull the agent's DLC check is holding (SaveLocker tasks/emulator-saves Phase 5c), as `/api/dlc/holds` returns it. */
export interface DlcHold {
  gameId: string
  gameName: string
  missingCount: number
  missingSize: number
  summary: string
  heldAt: string
}

const dlcHolds = callable<[], AgentResult<DlcHold[]>>('dlc_holds')
const dlcHandover = callable<[string], AgentResult<{ fromMachineName: string }>>('dlc_handover')
const dlcPullAnyway = callable<[string], AgentResult<{ message: string }>>('dlc_pull_anyway')

/** The held pulls, polled once a minute — shared by the full page's section below and the QAM's
 * one-row-per-hold "Needs attention" list, which needs the data but not this module's layout. */
export function useDlcHolds(): { holds: DlcHold[]; refresh: () => Promise<void> } {
  const [holds, setHolds] = useState<DlcHold[]>([])

  const refresh = async () => {
    const r = await dlcHolds()
    setHolds(r.ok ? r.data ?? [] : [])
  }

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 60 * 1000)
    return () => clearInterval(timer)
  }, [])

  return { holds, refresh }
}

// The two honest actions a hold offers: ask the machine the save came from to hand the packs over
// (they install by themselves and the pull goes ahead), or pull anyway. Each resolves to the toast
// body, so both surfaces announce the outcome in the same words.
async function handOver(h: DlcHold): Promise<string> {
  const r = await dlcHandover(h.gameId)
  return r.ok
    ? `Asked ${r.data.fromMachineName} for ${h.gameName}'s DLC. It installs here once sent.`
    : `Couldn't ask for ${h.gameName}'s DLC (${r.reason}). The other machine must be on and have the packs.`
}

async function pullAnyway(h: DlcHold): Promise<string> {
  const r = await dlcPullAnyway(h.gameId)
  return r.ok ? r.data.message : `The pull of ${h.gameName} failed (${r.reason}).`
}

function DlcHoldModal({ hold, onSettled, closeModal }: { hold: DlcHold; onSettled: () => void; closeModal?: () => void }) {
  const [busy, setBusy] = useState(false)

  const act = async (work: (h: DlcHold) => Promise<string>) => {
    setBusy(true)
    try { toaster.toast({ title: 'SaveLocker', body: await work(hold) }) }
    finally { setBusy(false); onSettled(); closeModal?.() }
  }

  return (
    <ModalRoot closeModal={closeModal} onCancel={closeModal}>
      <div style={{ padding: '20px', maxWidth: '560px' }}>
        <div style={{ fontSize: '16px', fontWeight: 700, marginBottom: '8px' }}>Waiting for DLC — {hold.gameName}</div>
        <div style={{ fontSize: '13px', opacity: 0.75, lineHeight: 1.5, marginBottom: '16px' }}>
          The newer save needs {hold.summary}. This Deck's save is kept; the pull goes ahead once they're installed.
        </div>
        <Focusable style={{ display: 'flex', flexDirection: 'column', gap: '8px' }} flow-children="down">
          <DialogButton disabled={busy} onClick={() => void act(handOver)}>
            Get {hold.gameName}'s DLC from the other machine
          </DialogButton>
          <DialogButton disabled={busy} onClick={() => void act(pullAnyway)}>
            Pull {hold.gameName} anyway
          </DialogButton>
          <DialogButton disabled={busy} onClick={closeModal}>Close</DialogButton>
        </Focusable>
      </div>
    </ModalRoot>
  )
}

/** The QAM's entry point: one attention row opens this, and the two actions live behind it. */
export function openDlcHoldModal(hold: DlcHold, onSettled: () => void): void {
  showModal(<DlcHoldModal hold={hold} onSettled={onSettled} />)
}

/**
 * "A newer save needs DLC this Deck doesn't have": an Xbox 360 game whose pull the agent held because the latest save
 * was made with packs missing here. The full-screen page's Status section renders it inline — each game gets a
 * read-only line and its two buttons, so with several holds a button sits under its own game. The QAM shows the same
 * data as one row per hold instead (`useDlcHolds` + `openDlcHoldModal`). Renders nothing when there are no holds.
 */
export function DlcHolds() {
  const { holds, refresh } = useDlcHolds()
  const [busy, setBusy] = useState(false)

  if (holds.length === 0) return null

  const act = async (work: () => Promise<string>) => {
    setBusy(true)
    try { toaster.toast({ title: 'SaveLocker', body: await work() }) }
    finally { setBusy(false); void refresh() }
  }

  return (
    <PanelSection title="Waiting for DLC">
      {holds.flatMap((h) => [
        <PanelSectionRow key={h.gameId}>
          <ReadOnlyRow>
            <div style={{ fontSize: '0.85em' }}><b>{h.gameName}</b></div>
            <div style={{ opacity: 0.75 }}>
              The newer save needs {h.summary}. This Deck's save is kept; the pull goes ahead once they're installed.
            </div>
          </ReadOnlyRow>
        </PanelSectionRow>,
        <PanelSectionRow key={`handover-${h.gameId}`}>
          <ButtonItem layout="below" disabled={busy} onClick={() => void act(() => handOver(h))}>
            Get {h.gameName}'s DLC from the other machine
          </ButtonItem>
        </PanelSectionRow>,
        <PanelSectionRow key={`anyway-${h.gameId}`}>
          <ButtonItem layout="below" disabled={busy} onClick={() => void act(() => pullAnyway(h))}>
            Pull {h.gameName} anyway
          </ButtonItem>
        </PanelSectionRow>,
      ])}
    </PanelSection>
  )
}
