---
name: code-review-skill-v2
description: |
  Multi-angle parallel code review orchestrator. Fans out a diff to 10 specialist
  review angles (diff scan, removed-behavior, cross-file trace, language pitfalls,
  proxy correctness, reuse, simplification, efficiency, altitude, conventions) as
  subagents in waves of 2, then synthesizes one severity-labeled verdict.
  Use when: reviewing pull requests, conducting PR reviews, code review, reviewing
  code changes, architecture reviews, security audits, performance reviews.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
  - WebFetch
---

# Code Review Skill v2 — Parallel Angle Orchestrator

Single lead, ten specialist angles, one synthesized verdict. The lead never
reviews in depth itself; it triages, fans out, and merges.

## When to Use This Skill

- Reviewing pull requests and code changes
- Architecture, security, or performance reviews
- Any diff where one sequential pass misses cross-cutting issues

## How It Works

1. **Triage (lead only).** Establish scope before spawning anything:
   - `git diff main...HEAD --stat` for the file list; full diff for the brief.
   - For large diffs, pipe through the v1 analyzer first:
     `git diff main...HEAD | python .agents/skills/code-review-skill/scripts/pr-analyzer.py`
   - Note PR description, linked issue, CI status. Diff >400 lines: ask to split.
2. **Fan out (full crew, waves of 2).** Spawn one subagent per angle below —
   all ten, every review. Never more than **2 angle subagents running at once**,
   in this fixed wave order:
   - Wave 1: A (diff scan) + B (removed behavior)
   - Wave 2: C (cross-file trace) + D (language pitfalls)
   - Wave 3: E (proxy correctness) + F (reuse)
   - Wave 4: G (simplification) + H (efficiency)
   - Wave 5: I (altitude) + J (conventions)
   - Start the next wave only after both reports of the current wave return.
3. **Synthesize (lead only).** Merge the ten reports into one verdict
   (format below). Dedupe overlapping findings, keep the sharpest phrasing,
   preserve every 🔴.

In OpenCode this means two `Task` calls per message per wave; in other runtimes
use that runtime's parallel-subagent mechanism. The companion files
`.opencode/agents/review-v2-*.md` and `.opencode/commands/review-v2.md` wire
this up for OpenCode; the wave plan and angle briefs below are the portable
contract every runtime follows.

## The Ten Angles

Each angle gets: the diff (or its in-scope file subset), one-line context
(branch intent, linked issue), and its brief. Workers load only their listed
guide from `.agents/skills/code-review-skill/reference/`.

- **Angle A — line-by-line diff scan.** Correctness per hunk: edge cases,
  null checks, off-by-one, error paths, race conditions. Guide: none (core skill).
- **Angle B — removed-behavior auditor.** Every deleted branch, flag, route,
  or fallback: is the removal intentional, migrated, and covered? Flag silent
  contract breaks. Here that means the additive-only wire rule: no deleted
  fields on agent- or dashboard-facing DTOs, `HasSteamCloud bool?` null
  semantics preserved, old upload route kept while old agents exist.
- **Angle C — cross-file tracer.** Follow each change along its real call
  chain (push: agent → `POST /api/games/{id}/upload` → `SyncService` →
  `ArchiveStore` + SQLite; pull mirrored; `:5178` proxy → server route) and
  report breaks the hunk alone cannot show.
- **Angle D — language-pitfall specialist.** Idiom traps of the diff's
  language. Load the matching guide: `csharp.md` (C# 12, async, EF Core),
  `typescript.md` + `react.md` (TS strict, hooks, React 19), others per file
  type. Default for this repo: C# + TS.
- **Angle E — wrapper/proxy correctness.** Delegation must preserve
  semantics: errors, retries, timeouts, auth, pins. Watch `ApiClient` /
  `ServerHttp` / `ServerTrust`, `AgentApiServer` proxies, Decky `main.py`
  proxies, chunked-upload retry (transients retried, 409/413 not).
- **Angle F — reuse.** New code an existing helper already covers; search
  adjacent files and shared modules before accepting duplication.
  Guide: `code-quality-universal.md` (reuse audit).
- **Angle G — simplification.** Working but over-complex code, dead code,
  speculative generality. Guide: `code-quality-universal.md`.
- **Angle H — efficiency.** Complexity, N+1 queries, repeated I/O, per-line
  fsync-style costs, double reads. Guide: `performance-review-guide.md`
  (+ `cross-cutting/n-plus-one-queries.md` where stores are touched).
- **Angle I — altitude.** Does the change fit the system's design or fight
  it? Check `docs/Architecture.md` and `docs/Decisions.md`: hub-and-spoke,
  lease model, frozen PBKDF2 `v1:` format, pinned native deps.
  Guide: `architecture-review-guide.md`.
- **Angle J — conventions.** Repo rules: `AGENTS.md` + `docs/CONTEXT.md`
  gotchas (net10.0, `--no-incremental`, dev storage `src/Server/localstate/`,
  openapi + `api-types.ts` regen after API changes, WHY-only comments).

## Worker Contract

Every angle subagent is **read-only** (no edits, no commits) and returns a
terse findings list only — no prose essay. Format per finding:

```markdown
- 🔴 `path/to/file.cs:123` — what breaks, under what condition, and the fix shape
```

Severity tiers: 🔴 blocking (must fix before merge) · 🟡 important (should
fix) · 🟢 nit (optional) · 💡 suggestion · 📚 learning · 🎉 praise.
Silence (no findings) is a valid report — say `No findings.` rather than
inventing nits.

## Lead Synthesis Format

```markdown
### Summary
2–3 sentences on overall quality.

### Findings
Grouped by angle (A–J), deduped, severity-labeled, `file:line` on each.

### Verdict
- ✅ Approve | 💬 Comment | 🔄 Request Changes
- One line per required action, if any.
```

## Cost Note

Ten angles cost roughly ten single reviews in tokens; waves of 2 bound peak
load and context pressure, not total spend. If that is too much for a trivial
diff, say so up front and offer the v1 sequential pass instead — never silently
drop angles.
