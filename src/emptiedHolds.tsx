import { useEffect, useState } from 'react'
import { ButtonItem, DialogButton, Focusable, ModalRoot, PanelSection, PanelSectionRow, showModal } from '@decky/ui'
import { callable, toaster } from '@decky/api'
import type { AgentResult } from './shared'
import { ReadOnlyRow } from './shared'

/** A game the agent holds because every save file vanished from its folder here (SaveLocker tasks/empty-save-hold),
 * as `/api/holds/emptied` returns it. Nothing is pushed or pulled for it on this Deck until one of the two choices. */
export interface EmptiedHold {
  gameId: string
  gameName: string
  saveDirectory: string
  lastVersionId: string | null
  heldAt: string
}

type Answer = 'restore-here' | 'delete-everywhere'

const emptiedHolds = callable<[], AgentResult<EmptiedHold[]>>('emptied_holds')
const answerEmptiedHold = callable<[string, Answer], AgentResult<{ message: string }>>('answer_emptied_hold')

/** The held games, polled once a minute — shared by the full page's section below and the QAM's one row per hold. */
export function useEmptiedHolds(): { holds: EmptiedHold[]; refresh: () => Promise<void> } {
  const [holds, setHolds] = useState<EmptiedHold[]>([])

  const refresh = async () => {
    const r = await emptiedHolds()
    setHolds(r.ok ? r.data ?? [] : [])
  }

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 60 * 1000)
    return () => clearInterval(timer)
  }, [])

  return { holds, refresh }
}

// Resolves to the toast body, so both surfaces announce the outcome in the same words. A refusal comes back as
// `http-400`: the agent's sentence is in its log, and the plain reason is enough here.
async function answer(h: EmptiedHold, choice: Answer): Promise<string> {
  const r = await answerEmptiedHold(h.gameId, choice)
  if (r.ok) return r.data.message
  return choice === 'restore-here'
    ? `Couldn't restore ${h.gameName} (${r.reason}). Is ${h.gameName} running?`
    : `Couldn't delete ${h.gameName} everywhere (${r.reason}).`
}

const EXPLAIN = 'It had them when it last synced. Nothing syncs for it on this Deck until you choose, so your other machines keep theirs.'

function EmptiedHoldModal({ hold, onSettled, closeModal }: { hold: EmptiedHold; onSettled: () => void; closeModal?: () => void }) {
  const [busy, setBusy] = useState(false)
  // Delete everywhere removes the save on every machine, so it asks once more.
  const [confirmDelete, setConfirmDelete] = useState(false)

  const act = async (choice: Answer) => {
    setBusy(true)
    try { toaster.toast({ title: 'SaveLocker', body: await answer(hold, choice) }) }
    finally { setBusy(false); onSettled(); closeModal?.() }
  }

  return (
    <ModalRoot closeModal={closeModal} onCancel={closeModal}>
      <div style={{ padding: '20px', maxWidth: '560px' }}>
        <div style={{ fontSize: '16px', fontWeight: 700, marginBottom: '8px' }}>Save files gone — {hold.gameName}</div>
        <div style={{ fontSize: '13px', opacity: 0.75, lineHeight: 1.5, marginBottom: '16px' }}>
          Every save file is gone from {hold.saveDirectory}. {EXPLAIN}
        </div>
        <Focusable style={{ display: 'flex', flexDirection: 'column', gap: '8px' }} flow-children="down">
          {confirmDelete ? (
            <>
              <DialogButton disabled={busy} onClick={() => void act('delete-everywhere')}>
                Yes, delete {hold.gameName}'s save on every machine
              </DialogButton>
              <DialogButton disabled={busy} onClick={() => setConfirmDelete(false)}>Back</DialogButton>
            </>
          ) : (
            <>
              <DialogButton disabled={busy} onClick={() => void act('restore-here')}>
                Restore {hold.gameName} here
              </DialogButton>
              <DialogButton disabled={busy} onClick={() => setConfirmDelete(true)}>
                Delete it everywhere…
              </DialogButton>
              <DialogButton disabled={busy} onClick={closeModal}>Close</DialogButton>
            </>
          )}
        </Focusable>
      </div>
    </ModalRoot>
  )
}

/** The QAM's entry point: one attention row opens this, and the two choices live behind it. */
export function openEmptiedHoldModal(hold: EmptiedHold, onSettled: () => void): void {
  showModal(<EmptiedHoldModal hold={hold} onSettled={onSettled} />)
}

/**
 * "Every save file is gone from this Deck": the full-screen page's Status section renders each held game inline — a
 * read-only line and a button that opens the choice (Delete everywhere asks once more there, so it never sits one
 * press away on a page). The QAM shows the same data as one row per hold (`useEmptiedHolds` + `openEmptiedHoldModal`).
 * Renders nothing when there are no holds.
 */
export function EmptiedHolds() {
  const { holds, refresh } = useEmptiedHolds()

  if (holds.length === 0) return null

  return (
    <PanelSection title="Save files gone">
      {holds.flatMap((h) => [
        <PanelSectionRow key={h.gameId}>
          <ReadOnlyRow>
            <div style={{ fontSize: '0.85em' }}><b>{h.gameName}</b></div>
            <div style={{ opacity: 0.75 }}>Every save file is gone from this Deck. {EXPLAIN}</div>
          </ReadOnlyRow>
        </PanelSectionRow>,
        <PanelSectionRow key={`choose-${h.gameId}`}>
          <ButtonItem layout="below" onClick={() => openEmptiedHoldModal(h, () => void refresh())}>
            Choose for {h.gameName}…
          </ButtonItem>
        </PanelSectionRow>,
      ])}
    </PanelSection>
  )
}
