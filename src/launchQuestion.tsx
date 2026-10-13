import { useEffect, useRef, useState } from 'react'
import { DialogButton, Focusable, ModalRoot, ToggleField, showModal } from '@decky/ui'
import { callable } from '@decky/api'
import { saveLockerToast } from './toast'

/** One answer a launch question offers — `LaunchChoice` in the agent's SyncEngine/LaunchQuestions.cs, verbatim. */
export interface LaunchChoice {
  id: string
  label: string
  primary?: boolean
}

/**
 * A question the agent's launch gate asks before a game starts (SaveLocker tasks/emulator-saves Phase 5c): today, which
 * Xenia profile to start as. The agent has ALREADY applied `defaultChoice` when it answers `Ask`, so doing nothing — the
 * timeout, B, a transport failure — launches correctly; only another choice needs a call back.
 */
export interface LaunchQuestion {
  id: string
  kind: string
  title: string
  text: string
  choices: LaunchChoice[]
  defaultChoice: string
  timeoutSeconds: number
  canRemember: boolean
}

type Result<T> = { ok: true; data: T } | { ok: false; reason: string }
const launchAnswer = callable<[string, string, string, boolean], Result<unknown>>('launch_answer')

/**
 * Shows the question over Game Mode and resolves once it is settled: a choice was sent (or the default kept), the
 * countdown ran out, or the modal was closed. Resolves `true` only when a choice other than the default reached the
 * agent. Never rejects — the launch it is holding must always continue.
 */
export function askLaunchQuestion(gameId: string, gameName: string, question: LaunchQuestion): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (changed: boolean) => { if (!settled) { settled = true; resolve(changed) } }
    showModal(<LaunchQuestionModal gameId={gameId} gameName={gameName} question={question} onDone={done} />)
  })
}

function LaunchQuestionModal({ gameId, gameName, question, onDone, closeModal }: {
  gameId: string
  gameName: string
  question: LaunchQuestion
  onDone: (changed: boolean) => void
  closeModal?: () => void
}) {
  const [left, setLeft] = useState(Math.max(5, question.timeoutSeconds))
  const [remember, setRemember] = useState(false)
  const [sending, setSending] = useState(false)
  const finished = useRef(false)

  const finish = (changed = false) => {
    if (finished.current) return
    finished.current = true
    closeModal?.()
    onDone(changed)
  }

  useEffect(() => {
    const tick = setInterval(() => setLeft((s) => s - 1), 1000)
    return () => {
      clearInterval(tick)
      // Closed by B or by Steam: the default is already in place, so the launch simply goes on.
      if (!finished.current) { finished.current = true; onDone(false) }
    }
  }, [])

  useEffect(() => { if (left <= 0 && !sending) finish() }, [left, sending])

  const choose = async (choice: LaunchChoice) => {
    if (sending || finished.current) return
    if (choice.id === question.defaultChoice && !remember) { finish(); return }
    setSending(true)
    const r = await launchAnswer(gameId, question.id, choice.id, remember).catch(() => null)
    const reached = !!r && r.ok
    if (!reached) saveLockerToast('blocked', `${gameName}: your choice didn't reach SaveLocker`, 'Starting with the default instead')
    finish(reached && choice.id !== question.defaultChoice)
  }

  return (
    <ModalRoot closeModal={() => finish()} onCancel={() => finish()} bDisableBackgroundDismiss>
      <div style={{ padding: '20px', maxWidth: '560px' }}>
        <div style={{ fontSize: '11px', letterSpacing: '0.12em', textTransform: 'uppercase', opacity: 0.6 }}>
          SaveLocker · before {gameName} starts
        </div>
        <div style={{ fontSize: '18px', fontWeight: 700, margin: '6px 0 8px' }}>{question.title}</div>
        <div style={{ fontSize: '13px', opacity: 0.8, lineHeight: 1.5, marginBottom: '16px' }}>{question.text}</div>
        <Focusable style={{ display: 'flex', flexDirection: 'column', gap: '8px' }} flow-children="down">
          {question.choices.map((c) => (
            <DialogButton
              key={c.id}
              disabled={sending}
              onClick={() => void choose(c)}
              style={c.primary ? { background: '#1a9fff', color: '#fff' } : undefined}
            >
              {c.label}
            </DialogButton>
          ))}
        </Focusable>
        {question.canRemember && (
          <div style={{ marginTop: '12px' }}>
            <ToggleField label="Don't ask again for this game" checked={remember} onChange={setRemember} />
          </div>
        )}
        <div style={{ fontSize: '12px', opacity: 0.55, marginTop: '10px' }}>
          {sending ? 'Applying your choice…' : `Starting with the first choice in ${Math.max(0, left)} s`}
        </div>
      </div>
    </ModalRoot>
  )
}
