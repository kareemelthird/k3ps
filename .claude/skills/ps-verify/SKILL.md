---
name: ps-verify
description: The definition of "done" for PS-Managment. Run after any change to confirm the monorepo still compiles, tests pass, and both apps build. Use before declaring work complete, before review, and before the human phase gate. Runs typecheck + jest + expo export + next build across the workspace.
allowed-tools: Read, Grep, Glob, Bash
---

# ps-verify

The gate referenced in `CLAUDE.md` §7. Run from repo root (`D:\K3\PS-Managment`). Steps run **in order**; all must pass. **Report exact output for any failure — never declare green on a skipped or failing step.** CI runs the same checks.

## 1. Typecheck — all workspaces
```
npm run typecheck
```
Runs `tsc --noEmit` in every workspace that defines it (`@ps/core` has `noUncheckedIndexedAccess`). Must be **0 errors**.

## 2. Unit + integration tests
```
npm test
```
Runs Jest per workspace. Riskiest logic is `packages/core` (pricing/money/time/inventory) — must be green with **>90%** coverage there:
```
npm --workspace packages/core test -- --coverage
```

## 3. Mobile bundle — only if `apps/mobile` is scaffolded (Phase 3+)
```
npm --workspace apps/mobile run export      # expo export — validates the whole app graph
```
If Metro port 8081 is held by a previous run, free it first. Skip with a logged note pre-Phase-3.

## 4. Web build — only if `apps/web` is scaffolded (Phase 3+)
```
npm --workspace apps/web run build           # next build — production build
```
Skip with a logged note pre-Phase-3.

## Domain sanity (when the change touches these)
- Money asserted as **integer piastres** — a test expecting float money is itself the bug.
- Backend/RLS change → also run `rls-tenant-audit`. Pricing/`@ps/core` change → also run `pricing-engine-guard`. UI change → also run `rtl-i18n-check`.

## Output
End with a table: each step → **PASS / FAIL / SKIPPED (reason)**, core coverage %, and the failing output pasted for every FAIL.
