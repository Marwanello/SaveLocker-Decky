# SaveLocker-Decky session summary

Branch: `qam-ui-redesign`
Worktree: `D:\Projects\SaveLocker\SaveLocker-Decky\.claude\worktrees\qam-ui-redesign`
Based on: `b664502` (main). Status: uncommitted; verification is tsc + build only (see below).

This session did four things: a QAM redesign (research + clickable mockup), a full-screen settings
redesign as three clickable options, the implementation of the chosen Option A settings page in
`src/`, and the planning-then-removal of the `decky-qam-scrolling` backlog task. A running-log copy
of this summary is in `docs/progress.md`.

## 1. QAM redesign — research + clickable mockup

Research was done against ground truth rather than screenshots. Valve's gamepad-UI stylesheet was
located in the installed client (`Program Files (x86)/Steam/steamui/css/chunk~2dcc5aaf7.css`) and
semantic class names were recovered by finding their runtime hashes in
`steamui/chunk~2dcc5aaf7.js` — the same JS Decky's own `staticClasses` resolves from at runtime
(e.g. `quickaccesscontrols_PanelSection` → `._2WRf66Xzh8kEeWw4zIogSl`). Values used by the mockup,
verbatim from those rules:

- QAM panel: **348px** visible (an 854px drawer translated 506px right) = **48px vertical tab rail**
  + 300px content column; solid `#0e141b`.
- Title bar: 22px/700 uppercase, letter-spacing 1px, `padding: 6px 0 0 16px`, background `#0e141b`,
  `box-shadow: 0 0 7px 12px #0e141b` (masks rows scrolling beneath it).
- Sections: `padding: 0 16px; margin: 0 0 24px`; section titles uppercase 16px/600,
  `rgba(255,255,255,.7)`, padding-bottom 8px.
- Field rows: column-gap 12px, radius 2px, 12px vertical padding, separators 1px
  `rgba(255,255,255,.1)`; **focus = background `#3d4450`**, text `#fff`, no outline.
- Dialog buttons: `rgba(255,255,255,.15)` → hover `.2`; focus/active `#fff` + `#23262e` text;
  primary focus `#1a9fff`; destructive focus `#de3618`; disabled = `.4` opacity on `#131418`.
- Toggle: 38×22, track `hsla(0,0%,100%,.15)` → `#1a9fff` on, white 22px knob translating 16px.
- Modals: scrim `rgba(0,0,0,.85)` + `backdrop-filter: blur(3px)`; dialog `#0e141b`, 2px `#23262e`
  border, 660px wide, slide-in `.5s cubic-bezier(.16,.86,.43,.99)`.
- Font: Motiva Sans (loaded from Steam's public font CDN, same files the web client uses).

Deliverable: **`docs/tasks/qam-ui-redesign/mockup.html`** — a 1280×800 clickable mockup with six
scenarios (healthy / syncing / attention / update-blocked / offline / empty), Steam context menus,
modals, toasts, and gamepad-style focus (arrow keys + Enter, B/Esc backs out). Deep links:
`#syncing`, `#attention:conflict`, `#healthy:advanced`, `#healthy:menu` etc. Verified with headless
Chrome screenshots against the extracted values.

Redesign shape (for future implementation): status hero (or live progress / offline state) → a
single-row-per-item "Needs attention" section (conflicts, leases, DLC holds, staged update) → Sync
(target, Sync now, Advanced, last result) → More (Gaming Mode toggle, Settings link). Force actions
and raw agent output move behind modals; the status colour language reuses `toast.tsx`'s
`KIND_STYLE` unchanged so panel and toasts stay one language.

## 2. Full-screen settings redesign — three clickable options

Same extraction method supplied the full-page chrome values (page background
`radial-gradient(155.42% 100% at 0% 0%, #060a0e 0%, #0e141b 100%)`; PagedSettingsDialog page-list
values — column `#2b2d33`, active `rgba(26,159,255,.22)` gradient, focus `.4` gradient + 2px
`#1a9fff` left border; GamepadTabbedPage pill tabs; the gamepad `BasicTextInput`).

- `docs/tasks/qam-ui-redesign/settings-option-a-paged.html` — Valve's settings chrome: left page
  list (Status / Games / Launch options / Activity / Diagnostics), per-game detail in a dialog.
- `settings-option-b-game-first.html` — master–detail: game list + inline per-game configuration;
  global material on a "This Deck" tab.
- `settings-option-c-cockpit.html` — one page, sticky jump-nav chips, inline game expansion.

All three are fully clickable (search, toggles, dropdowns, alias editing, simulated
sync/check/install/doctor runs, cross-links to each other) and were screenshot-verified. **Option A
was chosen and implemented.**

## 3. Option A implemented (`src/fullPage.tsx`, `src/stagedUpdate.tsx`, `src/index.tsx`)

- **`src/fullPage.tsx` rewritten** on `@decky/ui`'s `SidebarNavigation` — Valve's own
  PagedSettingsDialog, resolved at runtime — with five pages:
  - *Status*: five stat tiles; staged-update row with **Install now**; conflict rows (resolve) and
    lease rows (dismiss); `DlcHolds` reused verbatim; "Sync all games".
  - *Games*: search + tracked-games list; each row opens a `GameSettingsModal` with save folder,
    pull-before-launch and sync-on-page-open toggles, alias editor, conflict-policy dropdown,
    on-demand sync check, conflict resolve, and a per-game pull+push sync. The list deliberately
    shows **no "in sync" chip** — that answer costs a save-folder hash and is on-demand only (the
    plan's Phase 12 rule); only a known conflict gets a chip.
  - *Launch options / Activity / Diagnostics*: the previous pages' logic, retokened; chips reuse
    `KIND_STYLE`.
- **`src/stagedUpdate.tsx` (new leaf module)**: `describeRestartFailure` plus
  `installStagedUpdate(beforeVersion)` — restart the service, then poll until the staged marker is
  *gone*; returning the same version means the updater rolled back and is reported as a failure.
  `index.tsx`'s QAM `StagedUpdate` was refactored onto it (duplicated polling removed); the
  settings page's Update row uses the same code.
- The old Decky `Tabs` layout and its tab-transition-killing CSS workaround are gone from
  `fullPage.tsx`; the ancestor scroll-reset shim is kept as a safety net.
- **Verified**: `npx tsc --noEmit -p tsconfig.json` clean; `npm run build` (rollup) clean;
  `dist/index.js` contains `SidebarNavigation`, `Sync this game now`, the install strings, and no
  `TabRowTabs`. **Unverified on hardware**: whether Valve's component clears the gamepad header via
  `--basicui-header-height` (one style tweak if not), and general focus behaviour — test with the
  sibling repo's `testenv.ps1` (`SAVELOCKER_DECKY_PLUGIN_REPO` pointed at this worktree).
- The QAM panel itself still has its old layout; only the settings page was implemented from the
  redesign, per the user's instruction.

## 4. `decky-qam-scrolling` backlog task — planned, then stripped

The backlog entry ("left-stick scrolling in the QAM is steppy"; doctor output one focus target per
line) was first planned as a carried-over implementation doc: collapse the QAM's sync-result output
(~13 focus stops → 2) behind a `Show output · N lines` toggle, auto-collapse on new sync, and expand
automatically when the run failed. That plan was then removed as unnecessary: the entry's premise is
already obsolete (doctor no longer renders in the QAM) and what remains is a strict subset of what
the QAM redesign mockup already designs away. Removed from this repo; the original backlog copy in
`SaveLocker/.claude/worktrees/backlog-plans-testenv-mockup/docs/tasks/decky-qam-scrolling/` was left
untouched (outside this repo).

## Repo state

```
 M src/fullPage.tsx
 M src/index.tsx
?? src/stagedUpdate.tsx
?? docs/tasks/qam-ui-redesign/
```

Nothing committed (the user has not asked for a commit). The mockups and docs are design artifacts;
the `src/` changes are the implementation.

## Not done / next steps

- Hardware verification of the settings page (and the uncommitted QAM `StagedUpdate` refactor) via
  the sibling repo's test pipeline; the header-clearance check above is the one open unknown.
- The QAM panel redesign itself is **mockup only** — decide whether/when to implement it (the
  `decky-qam-scrolling` decision assumed it will eventually happen).
- Commit(s) when asked.
