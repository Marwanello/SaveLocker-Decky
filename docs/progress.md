# SaveLocker-Decky progress

Running log of work done on this plugin. Newest entries at the bottom; each entry is a standalone
summary of one session's work in its own worktree/branch. `docs/session_summary.md` carries the
current session's summary in full.

---

## 2026-10-14 — QAM redesign mockups, settings page Option A implemented (branch `qam-ui-redesign`)

Worktree: `.claude/worktrees/qam-ui-redesign`, based on `b664502` (main). Nothing committed;
changes are `M src/fullPage.tsx`, `M src/index.tsx`, `?? src/stagedUpdate.tsx`,
`?? docs/tasks/qam-ui-redesign/`.

### 1. QAM redesign — research plus a clickable mockup

Research used ground truth, not screenshots: Valve's gamepad-UI stylesheet was extracted from the
installed client (`steamui/css/chunk~2dcc5aaf7.css`), and semantic class names were recovered by
finding their hashes in `steamui/chunk~2dcc5aaf7.js` — the same JS the Decky runtime resolves
`staticClasses` from. Key extracted values:

- QAM panel: 348px visible (854px drawer translated 506px) = 48px vertical tab rail + 300px
  content; solid `#0e141b`; title 22px/700 uppercase with a `0 0 7px 12px #0e141b` glow.
- Sections `padding: 0 16px; margin-bottom: 24px`; row focus `#3d4450`; buttons
  `rgba(255,255,255,.15)` → `#fff`/`#23262e` on focus, primary `#1a9fff`, destructive `#de3618`;
  toggle 38×22 filling `#1a9fff`; modals 660px `#0e141b` with a 2px `#23262e` border over
  `rgba(0,0,0,.85)` + `blur(3px)`; font is Motiva Sans (Steam's own CDN).

Deliverable: `docs/tasks/qam-ui-redesign/mockup.html` — a 1280×800 clickable mockup with six
scenarios (healthy / syncing / attention / update-blocked / offline / empty), Steam context menus,
modals, toasts and gamepad-style focus. Deep links: `#syncing`, `#attention:conflict`,
`#healthy:advanced` etc.

Redesign shape: a status hero, one-row "needs attention" items, a Sync section (target, Sync now,
Advanced, last result), and More; force actions and raw agent output move behind modals; status
colour language reuses `toast.tsx`'s `KIND_STYLE` unchanged.

### 2. Full-screen settings page — three clickable options

Same extraction method for the full-page chrome (page background radial-gradient, the
PagedSettingsDialog page-list values, GamepadTabbedPage pill tabs, the gamepad text input):

- `docs/tasks/qam-ui-redesign/settings-option-a-paged.html` — Valve's settings chrome; left page
  list (Status / Games / Launch options / Activity / Diagnostics); per-game detail in a dialog.
- `settings-option-b-game-first.html` — master–detail; per-game config inline, "This Deck" tab.
- `settings-option-c-cockpit.html` — one page, sticky jump nav, inline game expansion.

All three are clickable and were screenshot-verified headlessly. **Option A was chosen.**

### 3. Option A implemented (the settings page)

- `src/fullPage.tsx` rewritten on `@decky/ui`'s `SidebarNavigation` (Valve's own PagedSettingsDialog
  resolved at runtime): Status, Games, Launch options, Activity, Diagnostics pages. Per-game
  settings live in a `GameSettingsModal` (save folder, pull-before-launch and sync-on-page-open
  toggles, alias editor, conflict policy, on-demand sync check, resolve, one-game sync). The list
  claims no "in sync" chip — that answer costs a save-folder hash and stays on demand (Phase 12
  rule); only a known conflict gets a chip.
- `src/stagedUpdate.tsx` — new leaf module with `describeRestartFailure` and
  `installStagedUpdate` (restart the service, then poll until the staged marker is *gone*;
  same-version return means the updater rolled back). `index.tsx`'s QAM `StagedUpdate` now calls it,
  removing the duplicated polling loop; the settings page's Update row uses the same code.
- The old Decky `Tabs` layout and its transition-killing CSS workaround are gone; the scroll-reset
  shim is kept as a safety net.
- Verified: `npx tsc --noEmit` clean, `npm run build` clean, `dist/index.js` greps for
  `SidebarNavigation` / new strings present and `TabRowTabs` gone. **Unverified on hardware**: that
  Valve's component clears the gamepad header via `--basicui-header-height`, and focus behaviour —
  check with the sibling repo's `testenv.ps1` pipeline.
- The QAM panel itself still has its old layout; only the settings page was implemented from the
  redesign.

### 4. `decky-qam-scrolling` backlog task — planned, then stripped

A carried-over plan (collapse the QAM sync result's ~13 focus stops to 2 via a "Show output"
toggle) was written, then removed as unnecessary: the entry's premise is obsolete (doctor left the
QAM) and the remainder is a subset of what the QAM redesign mockup already designs away. The
sibling backlog copy in `SaveLocker/.claude/worktrees/backlog-plans-testenv-mockup/docs/tasks/`
was left untouched.

### Repo state / next steps

Nothing committed. Next: hardware-verify the settings page via the sibling repo pipeline, and decide
whether/when to implement the QAM panel redesign (mockup only, so far).
