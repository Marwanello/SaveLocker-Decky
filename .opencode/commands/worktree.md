---
description: Open a branch in a .claude/worktrees worktree
---

Registered worktrees:
!`git worktree list`

All branches:
!`git branch -a`

$ARGUMENTS

$ARGUMENTS is a branch name (e.g. `fix/tray-flicker`). If empty, ask which branch.
1. If the branch already has a worktree under `.claude/worktrees/`, report its path and stop — never create a duplicate.
2. Otherwise create one: slugify the branch (`/` → `-`), then `git worktree add .claude/worktrees/<slug> <branch>` for an existing branch, or add `-b <branch>` to create the branch. Confirm the path with the user first when no explicit name was given.
3. Fresh-worktree setup (the recurring gotcha): run `npm ci` at the repo root — build and tsc both need `node_modules/`. Nothing else is needed (`main.py` is only verifiable on a deck). For hardware testing from a worktree, point the sibling agent repo's `testenv.ps1` at it via `$env:SAVELOCKER_DECKY_PLUGIN_REPO` (`AGENTS.md`'s Deploy/release section).
4. If `.claude/worktrees/` holds directories NOT listed by `git worktree list` (stale checkouts), report them and ask before pruning — never delete unprompted.
