---
name: pricing-engine-guard
description: Verify the money/pricing invariants in @ps/core hold after any change to pricing, money, time, or inventory logic. Use when editing packages/core or any code that computes a bill. Checks integer-piastres, rounding, prepaid lock, segment reconstruction, and coverage.
allowed-tools: Read, Grep, Glob, Bash
---

# pricing-engine-guard

Money correctness is the product's trust. These invariants must hold in `@ps/core`.

## Invariants to check
1. **Integer piastres only.** No float arithmetic on money; no `parseFloat`/`*100` rounding hacks that can drift. Conversions go through the shared `toPiastres`/`formatEGP` helpers.
2. **Round once per segment.** Rounding (to `rounding_minutes`) and `min_charge` are applied per segment, not re-applied on the sum. The total is `Σ rounded segment costs + Σ order items − discount`.
3. **Prepaid is locked.** Once a prepaid block is purchased, its price is immutable — a later rate-rule change does not re-price it. There must be a test asserting this.
4. **Determinism / purity.** No `Date.now()` inside cost math; timestamps and timezone are passed in. Same inputs → same output.
5. **Segment reconstruction.** A bill can be recomputed from stored snapshots (rule id + price snapshot + start/end) without the live rate rules.
6. **Peak / day boundaries.** Crossing a peak window or weekend (Africa/Cairo, Fri/Sat) opens a new segment with the correct rate.
7. **Inventory ledger.** On-hand = Σ deltas; oversell is guarded; a void reverses the exact movements it created.

## How to run
```
npm --workspace packages/core test
npm --workspace packages/core run typecheck
```
- Confirm tests exist for each invariant above; if one is missing, that is a gap to report (and ideally to add).
- Check coverage stays **>90%** on pricing/money/time/inventory.

## Output
A checklist: each invariant → covered-by-test? PASS/FAIL, plus coverage numbers. Flag any invariant lacking a guarding test.
