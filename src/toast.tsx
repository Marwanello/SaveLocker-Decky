import { toaster } from '@decky/api'
import { FaCheckCircle, FaExclamationTriangle, FaInfoCircle, FaLock, FaSyncAlt, FaTimesCircle } from 'react-icons/fa'

/**
 * One styled toast helper shared by `gamingSync.tsx` and `libraryOverlay.tsx`, so every SaveLocker
 * toast carries the same colored icon-circle language rather than each call site inventing its own.
 * `ToastData.logo` accepts any `ReactNode` (confirmed from `@decky/api`'s real types, not just a
 * string), which is what makes this possible at all — unverified on hardware, though: whether Steam's
 * native toast renderer actually respects an arbitrary React element there, or only ever expected an
 * image URL in practice, needs a real Deck to confirm. If it renders as blank/broken, the toast still
 * shows `title`/`body`/`subtext` (those are definitely just text), so this degrades safely either way.
 */

export type ToastKind = 'syncing' | 'success' | 'blocked' | 'error' | 'warning' | 'info'

/** Exported so `libraryOverlay.tsx`'s status chip can share these exact colors — the chip is meant
 * to read as the same status language as the toasts, not a second palette that happens to be close. */
export const KIND_STYLE: Record<ToastKind, { bg: string; fg: string; Icon: typeof FaSyncAlt }> = {
  syncing: { bg: '#2a3a45', fg: '#7fb8e0', Icon: FaSyncAlt },
  success: { bg: '#1e3a2a', fg: '#6fce9a', Icon: FaCheckCircle },
  blocked: { bg: '#3a2f16', fg: '#e0b355', Icon: FaLock },
  error: { bg: '#3a1e1e', fg: '#e07272', Icon: FaTimesCircle },
  warning: { bg: '#2f2440', fg: '#b596e6', Icon: FaExclamationTriangle },
  info: { bg: '#26292c', fg: '#9a9a96', Icon: FaInfoCircle },
}

function kindLogo(kind: ToastKind) {
  const { bg, fg, Icon } = KIND_STYLE[kind]
  return (
    <div
      style={{
        // Steam's native toast slots `logo` with no gutter of its own — confirmed on hardware: with
        // no margin here the circle sits flush against the toast's top-left corner instead of
        // vertically centered against the title/body text. The margin below is this element
        // providing its own inset rather than assuming the slot has any.
        width: '28px',
        height: '28px',
        margin: '10px 12px',
        borderRadius: '50%',
        background: bg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <Icon style={{ fontSize: '14px', color: fg }} />
    </div>
  )
}

/** Fires a SaveLocker toast with the colored icon-circle matching `kind`. `subtext` is the dimmer
 * third line (e.g. a refusal reason) — omit it for a plain one-line toast. */
export function saveLockerToast(kind: ToastKind, body: string, subtext?: string): void {
  toaster.toast({ title: 'SaveLocker', body, subtext, logo: kindLogo(kind) })
}
