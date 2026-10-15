import { callable } from '@decky/api'
import { fetchVersion, type AgentResult } from './shared'

/**
 * The staged-update install, shared by the Quick Access panel's Update section (index.tsx) and the
 * full-screen page's Status page (fullPage.tsx).
 *
 * It lives in its own leaf module for the same reason `syncStatus.tsx` does: two surfaces need it
 * and either owning it would make them circular or force a copy, and the polling rules below are
 * exactly the kind of thing a second copy would get subtly wrong.
 *
 * The button this backs destroys the API the caller is talking to. That is not a hazard to work
 * around — it is how the update installs — so `unreachable` during the wait is the expected shape
 * of SUCCESS, and anything that error-toasts on the first failed call reports a working update as
 * a failure.
 */

const restartAgent = callable<[], AgentResult<null>>('restart_agent')

export interface InstallOutcome {
  ok: boolean
  /** The sentence to show, already prepared for display. */
  text: string
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
export function describeRestartFailure(reason: string): string {
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
 * Restarts `savelocker.service` and waits for the swap to actually land.
 *
 * Success is not a version string match — the agent prints Major.Minor.Patch and the server's
 * string need not agree on component count — it is the staged marker being GONE, which only
 * happens once the swap ran. systemctl returns once the unit is active, but the agent's HTTP
 * listener comes up a moment after that, so the first few polls legitimately fail and are retried.
 *
 * A marker still present after the restart means the apply declined, and the agent says why
 * (`stagedBlockedReason`) — that reason is returned verbatim, per this plugin's standing rule that
 * a refusal explains itself and paraphrasing it would lose the reason.
 *
 * `beforeVersion` is the version the caller observed before installing. When the swap lands but
 * the agent comes back on that same version, the updater rolled back by itself (it does that when
 * the new build will not start), and claiming "installed" would be a lie the user finds out about
 * later — so that case reports a failure with doctor advice instead.
 */
export async function installStagedUpdate(beforeVersion: string): Promise<InstallOutcome> {
  const restarted = await restartAgent()
  if (!restarted.ok) return { ok: false, text: describeRestartFailure(restarted.reason) }

  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000))
    const v = await fetchVersion()
    if (!v.ok) continue

    if (v.data.stagedVersion === null) {
      return v.data.currentVersion === beforeVersion
        ? { ok: false, text: `The agent restarted but is still on v${beforeVersion}. Run doctor.` }
        : { ok: true, text: `Installed. Now running v${v.data.currentVersion}.` }
    }
    if (v.data.stagedBlockedReason) {
      return { ok: false, text: v.data.stagedBlockedReason }
    }
  }
  return { ok: false, text: 'The agent did not come back within two minutes. Run doctor.' }
}
