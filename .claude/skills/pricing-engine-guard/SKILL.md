---
name: pricing-engine-guard
description: Verify the money/pricing invariants in @ps/core hold after any change to pricing, money, time, or inventory logic. Use when editing packages/core or any code that computes a bill. Checks integer-piastres, rounding, prepaid lock, segment reconstruction, and coverage.
allowed-tools: Read, Grep, Glob, Bash
---

# pricing-engine-guard

Money correctness is the product's trust. These invariants must hold in `@ps/core`. Reference signatures: `docs/reference/core-api.md`.

## Invariants — each must be covered by a test
1. **Integer piastres only.** No float arithmetic on money; conversions go through `egpToPiastres`/`formatEgp`. Grep the diff for `parseFloat`, `* 100`, `/ 100`, `toFixed` on money paths and confirm they're not introducing drift.
2. **Round once per segment.** `roundUpMinutes` and `min_charge_minutes` apply per segment / once at session level — never re-applied on the sum. Total = `Σ rounded segment costs + Σ order items − discount`.
3. **Prepaid lock.** Non-null `prepaid_total` is charged **exactly** (including `0`); a later rate-rule change never re-prices it. There must be an explicit test (trial's `prepaidLock.test.ts` is the model).
4. **Determinism / purity.** No `Date.now()` inside cost math; `at_iso` + timezone are passed in. Same inputs → same output. No React/RN/Expo/Next/Supabase import anywhere in `packages/core`.
5. **Segment reconstruction.** A bill recomputes from stored snapshots (`rate_rule_id` + `price_per_hour_snapshot` + start/end) without the live rules.
6. **Peak / day boundaries.** Crossing a peak window or weekend (Africa/Cairo, **Fri+Sat**) opens a new segment at the correct rate; `isWithinWindow` end is exclusive and wraps past midnight.
7. **Inventory ledger.** On-hand = Σ delta (can go negative = oversell signal); a void reverses the exact movements of its sale; `stockStatus` boundaries (`<=0` out, `<=low` low) hold.
8. **Rule resolution.** Highest `priority` wins, ties broken by id; all of device_type/play_mode/billing_mode/day_type/time-window respected.

## How to run
```
npm --workspace packages/core run typecheck
npm --workspace packages/core test -- --coverage
grep -rnE "no-(framework)-imports" packages/core/src   # sanity: ensure no react/react-native/expo/next/supabase import
```
- Confirm a test exists for each invariant above; a missing one is a gap to report (and ideally add).
- Coverage must stay **>90%** on pricing/money/time/inventory.

## Output
A checklist: each invariant → covered-by-test? PASS/FAIL, plus coverage numbers and any framework-import violations. Flag any invariant lacking a guarding test.
