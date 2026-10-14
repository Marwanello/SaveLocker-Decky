---
description: Multi-angle parallel code review (v2, 10 angles in waves of 2)
agent: review-v2-lead
---

Commits ahead of origin/main:
!`git log origin/main..HEAD --oneline`

Changed files:
!`git diff --stat origin/main`

$ARGUMENTS

Run the v2 parallel review per `.agents/skills/code-review-skill-v2/SKILL.md`:
triage this diff, fan out all ten angles in the fixed five waves of 2 (never
more than 2 angle subagents at once), then return the single synthesized
verdict (Summary, Findings by angle, Verdict: Approve / Comment / Request
Changes). If the current branch is `main` itself, say so and stop instead of
inventing a diff.
