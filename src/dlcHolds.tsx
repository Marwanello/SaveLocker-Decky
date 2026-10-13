import { useEffect, useState } from 'react'
import { ButtonItem, PanelSection, PanelSectionRow } from '@decky/ui'
import { callable, toaster } from '@decky/api'
import type { AgentResult } from './shared'
import { ReadOnlyRow } from './shared'

/** One pull the agent's DLC check is holding (SaveLocker tasks/emulator-saves Phase 5c), as `/api/dlc/holds` returns it. */
interface DlcHold {
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

/**
 * "A newer save needs DLC this Deck doesn't have": an Xbox 360 game whose pull the agent held because the latest save
 * was made with packs missing here. Shown in the QAM because a held pull is otherwise only visible in the agent UI,
 * which nobody opens in Game Mode. Each game gets a read-only line and two buttons — ask the machine the save came from
 * to hand the packs over (they install by themselves and the pull goes ahead), or pull anyway. Same row shape as
 * `LeaseWarnings`, for Steam's D-pad scrolling.
 */
export function DlcHolds() {
  const [holds, setHolds] = useState<DlcHold[]>([])
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    const r = await dlcHolds()
    setHolds(r.ok ? r.data ?? [] : [])
  }

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 60 * 1000)
    return () => clearInterval(timer)
  }, [])

  if (holds.length === 0) return null

  const act = async (work: () => Promise<string>) => {
    setBusy(true)
    try { toaster.toast({ title: 'SaveLocker', body: await work() }) }
    finally { setBusy(false); void refresh() }
  }

  const handOver = (h: DlcHold) => act(async () => {
    const r = await dlcHandover(h.gameId)
    return r.ok
      ? `Asked ${r.data.fromMachineName} for ${h.gameName}'s DLC. It installs here once sent.`
      : `Couldn't ask for ${h.gameName}'s DLC (${r.reason}). The other machine must be on and have the packs.`
  })

  const pullAnyway = (h: DlcHold) => act(async () => {
    const r = await dlcPullAnyway(h.gameId)
    return r.ok ? r.data.message : `The pull of ${h.gameName} failed (${r.reason}).`
  })

  return (
    <PanelSection title="Waiting for DLC">
      {holds.map((h) => (
        <PanelSectionRow key={h.gameId}>
          <ReadOnlyRow>
            <div style={{ fontSize: '0.85em' }}><b>{h.gameName}</b></div>
            <div style={{ opacity: 0.75 }}>
              The newer save needs {h.summary}. This Deck's save is kept; the pull goes ahead once they're installed.
            </div>
          </ReadOnlyRow>
        </PanelSectionRow>
      ))}
      {holds.map((h) => (
        <PanelSectionRow key={`handover-${h.gameId}`}>
          <ButtonItem layout="below" disabled={busy} onClick={() => void handOver(h)}>
            Get {h.gameName}'s DLC from the other machine
          </ButtonItem>
        </PanelSectionRow>
      ))}
      {holds.map((h) => (
        <PanelSectionRow key={`anyway-${h.gameId}`}>
          <ButtonItem layout="below" disabled={busy} onClick={() => void pullAnyway(h)}>
            Pull {h.gameName} anyway
          </ButtonItem>
        </PanelSectionRow>
      ))}
    </PanelSection>
  )
}
