---
name: ps-verify
description: The definition of "done" for PS-Managment. Run after any change to confirm the monorepo still compiles, tests pass, and both apps build. Use before declaring work complete, before review, and before the human phase gate. Runs typecheck + jest + expo export + next build across the workspace.
---

# ps-verify

Run these checks **in order** from the repo root (`D:\K3\PS-Managment`). All must pass before a change is "done". Report exact output for any failure — never declare green on a skipped or failing step.

## 1. Typecheck (all workspaces)
```
npm run typecheck
```
Must report **0 errors**. This runs `tsc --noEmit` in every workspace that defines it (`@ps/core`, apps).

## 2. Unit + integration tests
```
npm test
```
Runs Jest in every workspace. The riskiest logic is `packages/core` (pricing/money/time/inventory) — those tests must be green and coverage should stay **>90%** on those modules.

## 3. Mobile bundle (only if `apps/mobile` exists yet)
```
npm --workspace apps/mobile run export
```
Validates the entire Expo app graph (`expo export`). Skip with a note if the mobile app is not scaffolded yet (pre-Phase 3).

## 4. Web build (only if `apps/web` exists yet)
```
npm --workspace apps/web run build
```
Validates the Next.js production build (`next build`). Skip with a note if web is not scaffolded yet (pre-Phase 3).

## Notes
- If port 8081 (Metro) is busy from a previous run, free it before `expo export`.
- Money is integer **piastres** — a test asserting float money is a bug in the test, not a reason to relax the check.
- This skill is the gate referenced in `CLAUDE.md` §7 and by the `feature` workflow. CI runs the same four steps.

## Output
End with a summary table: each step → PASS / FAIL / SKIPPED (reason), and paste the failing output for any FAIL.
