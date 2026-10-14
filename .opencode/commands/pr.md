---
description: Draft a pull request description against origin
---

Target remote (ALWAYS origin, never upstream):
!`git remote get-url origin`

Commits ahead of origin/main:
!`git log origin/main..HEAD --oneline`

Changed files:
!`git diff --stat origin/main`

$ARGUMENTS

Write a PR description with: summary, key changes, verification evidence (`npm ci` + `npx tsc --noEmit` + `npm run build`; note Deck-only status for `main.py` changes), related issues. Follow conventional commits tone. Output markdown only. If the current branch is `main` itself, say so and stop instead of inventing a diff.
When asked to open the PR with gh: derive OWNER/REPO from the origin URL above and run `gh pr create --repo OWNER/REPO --base main --head <branch>`. Never use upstream as base or repo — upstream (SkorcherX) is read-only for us; origin is the Marwanello fork.
