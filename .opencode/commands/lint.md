---
description: Typecheck and build the Decky plugin
---

$ARGUMENTS

There is no linter here (`AGENTS.md`: verification for frontend changes is tsc + build). Run `npm ci` first if `node_modules/` is missing.

Run `npx tsc --noEmit -p tsconfig.json`, then `npm run build` (rollup via `@decky/rollup`). Report type errors and rollup warnings as findings grouped by file, and do not commit anything. Rollup can fail on things tsc does not report — e.g. a named export from `src/index.tsx` (`AGENTS.md`'s frontend build quirks).
