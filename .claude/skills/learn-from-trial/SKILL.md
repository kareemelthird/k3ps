---
name: learn-from-trial
description: Learn from the Pochinki trial without replicating it. Use when implementing domain logic (pricing, money, time, inventory, shifts, offline sync) the trial also tackled. The trial is a read-only reference for lessons and sound algorithms — reuse the good ideas, improve them, and build fresh. Never a blueprint or a dependency.
allowed-tools: Read, Write, Edit, Grep, Glob, Bash
---

# learn-from-trial

Pochinki (`D:\K3\Pochinki`, read-only) is a **trial**, not a reference implementation. It proves the domain and surfaces lessons — but PS-Managment is a fresh, more advanced, multi-tenant product. **Learn from it; don't work like it.**

## What's worth reusing (the sound ideas)
The handbook already distilled these so you don't have to spelunk the trial:
- `docs/reference/core-api.md` — the **money model (integer piastres)** and **pricing math** (open/prepaid/fixed-match, rate-rule resolution, round-once-per-segment, prepaid lock). These algorithms are sound — reuse and improve them in `packages/core`.
- `docs/reference/mobile-patterns.md` — the **offline-outbox idea** (idempotent client-UUID + upsert, dead-letter) and timestamp-derived timers. Good concepts; rebuild cleanly.
- `docs/reference/schema-and-rls.md` — the **entity model** (devices/sessions/segments/orders/shifts/…) and what must change for multi-tenancy.

## What NOT to carry over
- **Design / UI / theme** — done fresh via the `ui-ux-pro-max` skill + magic MCP. See `docs/reference/design-approach.md`.
- **Single-café assumptions** — everything is tenant/branch-scoped now.
- **Any code as-is** — never `import` from the trial; never copy a file verbatim. Re-derive in our structure, improve naming/types, add what was missing.

## Procedure
1. Read the relevant handbook section for the lesson/algorithm (not the trial first).
2. Decide: is this a *sound idea to reuse-and-improve* (money/pricing math, outbox concept) or *trial baggage to leave behind* (UI, single-café shortcuts)?
3. For reused logic in `@ps/core`: write it framework-free, integer-piastres, pure (pass `at_iso`/timezone in), with **its own fresh tests** encoding the invariants (prepaid lock, rounding, oversell, Fri/Sat weekend). Improve on the trial where you can.
4. If you consult trial source for a detail, treat it as documentation — adapt, don't transcribe.
5. Verify with the relevant guard (`pricing-engine-guard` / `offline-outbox-guard` / `rls-tenant-audit`) then `ps-verify`.

## Output
What lesson/algorithm you reused, how you improved it, what trial baggage you deliberately left behind, and the fresh tests added. Flag any behavior change worth a spec/ADR note.
