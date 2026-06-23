---
name: port-from-pochinki
description: Safely port proven logic from the Pochinki trial into PS-Managment instead of rewriting from scratch. Use when implementing pricing, money, time, inventory, shifts, the offline outbox, components, or schema that the trial already solved. Enforces reuse, framework-stripping for @ps/core, and test parity.
allowed-tools: Read, Write, Edit, Grep, Glob, Bash
---

# port-from-pochinki

The trial (`D:\K3\Pochinki`, read-only) already solved most domain logic. **Reuse before writing.** This skill is the procedure for bringing it over cleanly and generalized for multi-tenancy.

## Decide what to port
Consult the handbook first — it already distilled the trial:
- `docs/reference/core-api.md` — money/time/id/pricing/inventory/shifts/debts/types → target `packages/core/src`.
- `docs/reference/mobile-patterns.md` — outbox, stores, query layer, timers, kit, i18n, navigation → `apps/mobile`.
- `docs/reference/schema-and-rls.md` — tables/RLS baseline + tenant deltas → `supabase/`.
- `docs/reference/design-system.md` — tokens & flows → UI.

## Procedure
1. **Locate the source** in the trial (paths are in the handbook). Read it fully.
2. **Copy the logic, not the dependencies.** For `@ps/core`: strip every React/RN/Expo/Next/Supabase import; replace ambient clock reads with passed-in `at_iso`/timezone args; keep money as integer piastres.
3. **Generalize for tenancy/scale**, but keep current behavior: carry `tenant_id`/`branch_id` on data; isolate hardcoded `Africa/Cairo`/EGP behind named constants (don't change behavior yet).
4. **Port the tests too.** Bring over (and extend) the trial's test cases — they encode the invariants (prepaid lock, rounding, oversell, Fri/Sat weekend). Don't ship ported logic without its guarding tests.
5. **Verify:** run `pricing-engine-guard` (for core) / `rls-tenant-audit` (for schema) / `rtl-i18n-check` (for UI), then `ps-verify`.

## Rules / anti-patterns
- Never `import` from `D:\K3\Pochinki` — copy and adapt; the trial is a reference, not a dependency.
- Never weaken a tested invariant during the port. If you must change behavior, raise it as a spec/ADR question, don't silently drop it.
- Don't port the single-café assumptions — every operational entity becomes tenant/branch-scoped.

## Output
List what was ported (source → destination), what was generalized, the tests brought over, and any behavior deltas that need a human/ADR decision.
