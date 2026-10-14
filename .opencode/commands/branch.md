---
description: Create or switch Git branches
---

Existing branches:
!`git branch -a`

Current branch:
!`git branch --show-current`

$ARGUMENTS

If a branch name was given, switch to it (`git switch <name>`).
If not, propose a branch name for the work in progress, confirm with the user, then create it (`git switch -c <name>`).
