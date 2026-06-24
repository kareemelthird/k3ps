# ADR-0005: Pricing engine — segments, rate-rule boundaries, and the `@ps/core` billing API

- **Status:** Accepted (Phase-4 design gate; human project owner approves at the Phase-4 gate. **`security-reviewer` sign-off required** on Decision 5 — rate-rule audit taxonomy — and on AC 32/40/43 before the build merges.)
- **Date:** 2026-06-24
- **Deciders:** architect (deciding) · product-manager (Open Q4/Q6 business rules) · core-engineer (implements) · mobile-engineer + web-engineer (consume) · `security-reviewer` (audit/RLS sign-off) · human project owner (Phase-4 gate)
- **Builds on:** [ADR-0002 — isolation model](0002-tenant-isolation-model-ratified.md) (Accepted) · [ADR-0004 — schema scoping & keys](0004-tenant-schema-scoping-and-keys.md). Implements the architect decisions the PM deferred in [Phase-4 spec](../specs/phase-4-pricing-engine.md) §6/§7.
- **Reference:** `docs/reference/core-api.md` (pricing + session-pricing sections) · `CLAUDE.md` §2 (non-negotiables), §3 (pricing model), §4 (money/time API).

## Context

Phase 4 builds the pricing engine: the heart of the cash business. Phase 3 faked it with one flat-rate snapshot per session. Phase 4 delivers real rate-rule resolution, three billing modes (open / prepaid / fixed-match), and **segmentation** — a session splits into segments and switching single↔multi or crossing a peak/weekend boundary freezes the current segment's rate snapshot and opens a new one. Every bill, live or closed, must be derived by `@ps/core` from stored rate snapshots in integer piastres and be **reconstructible from snapshots alone** (`CLAUDE.md` §3).

Crucially, in PS-Managment there is **no `peak_windows` setting** (unlike the trial). Peak/off-peak and weekday/weekend boundaries are an emergent property of the tenant's own `rate_rules` set — each rule carries `day_type` + `time_start`/`time_end`. The instants at which the resolved rule for a fixed `(device_type, play_mode, billing_mode)` context changes ARE the boundaries. The engine must therefore derive boundaries from the rule set, not from a separate config.

The PM left 7 hard, hard-to-reverse decisions (they shape the `@ps/core` API surface, the `session_segments` write contract, and the mobile live-cost loop) that must be locked before the core-engineer builds. This ADR resolves all 7 plus the boundary-enumeration algorithm.

**Constraints (hard, from `CLAUDE.md`):** money is integer piastres, round once per segment, never re-round the sum (§2.1); cost math takes instants as arguments — no `Date.now()` inside `@ps/core` (§2.2, §2.4); timezone is Africa/Cairo, weekend = Fri(5)+Sat(6), store UTC compute Cairo (§2.3); `@ps/core` is pure — no React/RN/Expo/Next/Supabase imports (§2.4); every bill reconstructible from snapshots (§3); every money-affecting action writes `audit_log` (§2.7); idempotent client-UUID upserts (§2.8). `@ps/core` already ships `money`, `time` (`dayTypeAt`, `localHm`, `isWithinWindow` end-exclusive + midnight-wrap, `elapsedMinutes`, `nowIso`), and `pricing/open-meter` (`roundUpMinutes`, `billableMinutes`, `openMeterCostPiastres`). The trial at `D:\K3\Pochinki\src\pricing` is a learning reference for the algorithms only — never imported.

**Forces in tension:** write-amplification on mobile (a segment row per boundary, written by a background tick) vs. live-correctness with minimal writes; snapshot/audit fidelity (split whenever the rule changes) vs. fewer segments (split only when the price changes); determinism of multi-window close (a 5-hour session crossing several windows must materialize the same segments every time on any device) vs. simplicity.

---

## Decisions (the 7 open questions, locked)

### Decision 1 — Live boundary-crossing contract: **preview-splits, close-materializes** (Open Q1 → recommend (b), accepted)

The DB holds **one open segment** per logical play period. The engine NEVER requires the client to write a new segment merely because wall-clock time crossed a boundary while the session sat idle.

- **Mobile live view** computes cost by calling a pure core function that, given the open segment's `started_at`, the tenant's active rules, the segment's `(device_type, play_mode)` context, and the render instant `at_iso`, **mathematically splits the open `[started_at, at_iso)` interval at every rule-boundary instant in range** and sums per-sub-interval open-meter costs (each sub-interval billed at the rule resolved for *its own* start instant). No DB write happens on a boundary crossing. The live number is therefore correct under backgrounding/offline (it is recomputed from timestamps at every render — `CLAUDE.md` §2.2) and needs **no background tick** for money correctness (a 30–60s render tick is fine purely to refresh the displayed clock/cost; it must never accumulate money).
- **Session close** (and an explicit operator play-mode switch) is the ONLY thing that **materializes** segments to the DB. At close, the write path asks the core boundary enumerator for the ordered boundary instants in `[segment.started_at, ended_at)` and writes **N `session_segments` rows** — one per sub-interval, each with its own frozen `rate_rule_id` + `price_per_hour_snapshot`, `started_at`/`ended_at` at the boundary instants — so the stored bill is itemized and reconstructible. The stored `time_total` equals the live preview's number for the same instants (proven by AC 25/37/38).
- **Operator play-mode switch** still closes the current open segment at `at_iso` and opens a new one immediately (Decision: a mode switch is an *operator action*, not a clock event — it must be persisted right away so the new `play_mode` is durable). A switch may itself span boundaries: the closed portion is materialized into its constituent boundary sub-segments at switch time using the same enumerator (so a switch never hides a crossed boundary).

**Why:** fewer writes (no per-boundary write while a session idles), no mandatory background timer on mobile (battery + correctness — timestamp-derived math is the §2.2 invariant), and the close path is the single deterministic materializer. The cost is that the close/switch path must split deterministically — which Decision 3 guarantees.

### Decision 2 — Boundary detection key: **split on resolved `rate_rule_id`** (Open Q2 → recommend rule-id, accepted)

Two distinct rules that happen to resolve to the same `price_per_hour` still produce a boundary (a new segment). Rationale: snapshot/audit fidelity — `session_segments.rate_rule_id` is an FK and the bill must show *which rule* governed each sub-interval, not merely the price. A clean audit trail beats minimizing segment count. A `null` resolution (no matching rule) is itself a distinct boundary value (transition rule→no-rule or no-rule→rule is a boundary; rate 0 applies in the no-rule sub-interval per AC 4). Equality is compared on the resolved rule's `id` (with `null` ≠ any id).

### Decision 3 — Boundary enumerator returns the ordered instant list (Open Q3 → accepted)

A pure core helper `rateBoundaryInstants(...)` returns the **ascending, de-duplicated list of instants strictly inside `(startIso, endIso)` at which the resolved rule id changes**, scanning the tenant's active rule set for the fixed context. The close/switch path materializes exactly `boundaries.length + 1` segments deterministically (same input ⇒ same instants on any device). Endpoints `startIso`/`endIso` are NOT in the returned list (they are the outer segment bounds). Algorithm and signature below (§ "Boundary enumeration algorithm").

### Decision 4 — Min-charge on multi-segment bills: **once, at session level, using the FIRST segment's rate** (Open Q4 → recommend first-segment, accepted by PM)

Matches the proven trial algorithm: round each segment's billable minutes individually, sum integer costs; then if total billable minutes `< min_charge_minutes` (taken from the **resolving rule of the first segment** — i.e. the session's anchor modifiers), compute one min-charge cost = `round(min_charge_minutes × first_segment_rate / 60)` and take `max(sumOfSegmentCosts, minChargeCost)`. The min-charge is applied **once**, never per segment, never re-rounded over the sum. Using the first segment's rate (not highest) is intentional: it is the rate the customer started under and is the documented, tested trial behavior; "highest rate" would let an off-peak walk-in be min-charged at a peak rate they never reached. (Revisitable later via a new ADR if owners ask; not this phase.)

### Decision 5 — Rate-rule change auditing: **yes, audit create/update/deactivate/reactivate** (Open Q5 → recommend yes, accepted; **`security-reviewer` signs off**)

Rate-rule mutations affect money indirectly and owners want a pricing change history. The write path (web owner editor / backend) writes one `audit_log` row per mutation. **Taxonomy (locked):**

| action | when | `amount` | `entity` / `entity_id` | `meta` |
|---|---|---|---|---|
| `rate_rule.create` | new rule saved | `null` | `'rate_rule'` / new rule id | full new field snapshot |
| `rate_rule.update` | existing rule edited | `null` | `'rate_rule'` / rule id | `{ before, after }` changed-field diff |
| `rate_rule.deactivate` | `is_active` → false | `null` | `'rate_rule'` / rule id | `{ before: {is_active:true}, after:{is_active:false} }` |
| `rate_rule.reactivate` | `is_active` → false→true | `null` | `'rate_rule'` / rule id | symmetric to deactivate |

`amount = null` (these are config, not money movements — the `audit_log.amount` column is nullable for exactly this). `tenant_id` from the trusted JWT claim; `actor_id = auth.uid()`; `branch_id = null` (rate rules are tenant-scoped, ADR-0004). Owner-only write is already enforced by the Phase-2/3 `rate_rules` RLS policy (`security-reviewer` confirms owner-gate + `WITH CHECK` covers AC 32 — **no new RLS policy needed**, only the audit write). The audit write should occur in the same logical transaction as the mutation where the backend allows it; on the client path it is a follow-on idempotent insert keyed by a client UUID.

### Decision 6 — Prepaid `prepaid_minutes` semantics: **advisory display only; price lock is the invariant** (Open Q6 → recommend advisory, accepted by PM)

`sessions.prepaid_minutes` is **advisory** this phase — it informs the operator how much time the prepaid block nominally covers, but does **not** auto-close the session and does **not** affect the charged amount. The charged amount is `prepaid_total` (the price locked at purchase), full stop. No auto-expiry, no auto-extend, no top-up UI this phase (deferred). The lock invariant (Decision below + AC 14–17) is the only money-bearing rule: a non-null `prepaid_total` (including `0`) is charged exactly and is never reconstructed from current rules; `null` triggers the documented `block_price × max(1, blocks)` legacy fallback.

### Decision 7 — Fixed-match price lock: **lock `fixed_match_price` at start, snapshot on the session's first segment** (Open Q7 → recommend lock-at-start, accepted)

For consistency with the prepaid lock and reconstructibility, `fixed_match_price` is resolved **at session start** (via `resolveRule` for the start instant with `billing_mode='fixed_match'`) and **snapshotted**, not re-resolved at close. **Storage:** the snapshot lives on the session's **first `session_segments` row** in `price_per_hour_snapshot` (re-used as the locked per-match price for fixed-match mode — the column is already `int not null`, semantically "the locked unit price for this segment/mode") and the FK `rate_rule_id` records which rule was locked. Rationale for re-using the segment row rather than adding a session column: no schema change (spec mandates "no new tables"), and the segment is the canonical snapshot carrier the reconstruction helper already reads. Fixed-match sessions therefore have exactly **one** segment (no time-based boundaries apply); `match_count` lives on the session row and scales the locked price linearly. The reconstruction helper reads the locked price from that segment, never from current rules.

---

## Boundary enumeration algorithm (no `peak_windows`; derived from the rule set)

For a fixed context `ctx = { device_type, play_mode, billing_mode }` and interval `[startIso, endIso)`:

1. **Candidate instants** are the rule-set's own transition points expressed in Cairo local time, mapped back to UTC instants within the interval. The transition points are:
   - Each active rule's `time_start` and `time_end` (`'HH:mm'`), for each Cairo calendar day the interval touches (a multi-day session can cross the same `18:00` boundary on consecutive days).
   - **Midnight (`00:00` Cairo)** of each Cairo calendar day in range — because `day_type` (weekday↔weekend) flips at local midnight and that can change which rule resolves even with identical time windows.
2. **Build candidate UTC instants:** for every Cairo day `d` the interval `[startIso, endIso)` overlaps, and every distinct `HH:mm` in {all rules' `time_start`, all rules' `time_end`, `'00:00'`}, compute the UTC instant of `d`+`HH:mm` in `CAFE_TZ`. Keep only instants strictly inside `(startIso, endIso)`.
3. **Filter to real boundaries:** sort candidates ascending; walk them, and at each candidate compute `resolveRule(rules, {...ctx, at_iso: candidate})`. Keep a candidate **iff** the resolved rule **id** differs from the resolved rule id of the immediately preceding kept point (or of the interval start for the first candidate) — Decision 2. This drops candidate instants where resolution does not actually change (e.g. a window edge that does not win priority anyway).
4. **Return** the ascending, de-duplicated list of *kept* instants (UTC ISO strings). Endpoints excluded. `boundaries.length + 1` = number of materialized segments.

This is **pure** (instants passed in; rules passed in; no clock read), **deterministic** (sorted, id-compared, tz-fixed via existing `time` helpers), and **DST-safe** because Cairo→UTC conversion goes through the existing dayjs `tz` helpers used by `dayTypeAt`/`localHm`. Bounded cost: O(days × distinctTimes × rules) — for realistic sessions (hours, a handful of rules) this is trivially small. (Egypt re-introduced DST in 2023; the dayjs `tz` plugin handles the offset, so a boundary landing in a skipped/repeated local hour still maps to a well-defined UTC instant — the engineer must add a test for a session spanning a DST transition.)

---

## Options considered (for the load-bearing choices)

### Live-cost contract (Decision 1)

#### Option A — Preview splits, close materializes — **CHOSEN**
- Pros: no per-boundary DB write while a session idles; no mandatory background tick (timestamp-derived math, §2.2); single deterministic materializer (the close/switch path); fewer rows; live and stored totals provably equal (same enumerator).
- Cons: close/switch path must split deterministically (mitigated by Decision 3); the live function does more work per render (negligible — pure arithmetic over a few sub-intervals).
- Evidence: `CLAUDE.md` §2.2 (timers derive from timestamps, backgrounding must never corrupt a bill) — argues against any write-on-tick; trial's `segmentsToInputs` already computes live cost from timestamps at `atIso` (`D:\K3\Pochinki\src\pricing\session.ts`). Event-sourcing/snapshot guidance: keep the write model minimal and derive read views — https://learn.microsoft.com/azure/architecture/patterns/event-sourcing

#### Option B — Write a new segment on every boundary crossing (background tick materializes)
- Pros: stored segments always current without a close-time split; reconstruction trivially reads rows.
- Cons: requires a reliable background tick on mobile (battery, and a sleeping/offline app would *miss* the write — exactly the §2.2 failure mode); write amplification; non-deterministic timing of the split (depends when the tick fired, not the true boundary instant) unless the tick back-dates to the boundary — at which point you have re-implemented the enumerator anyway, with extra writes. Rejected.
- Evidence: §2.2 (a backgrounded app must never corrupt a bill); idempotency/offline concerns (§2.8) compound with tick-driven writes.

### Boundary detection key (Decision 2)

#### Option A — Compare resolved `rate_rule_id` — **CHOSEN**
- Pros: each segment records the exact governing rule (FK); audit/snapshot fidelity; preview and close agree on segment shape.
- Cons: two same-price windows produce an "extra" segment (harmless; arguably more honest).

#### Option B — Compare resolved `price`
- Pros: fewest segments.
- Cons: loses which rule applied (weaker audit); a future per-rule field change wouldn't split even when the owner intends two distinct rules. Rejected for audit fidelity.

### Min-charge anchor on multi-segment (Decision 4)

#### Option A — First segment's rate, once at session level — **CHOSEN**
- Pros: proven trial behavior (tested invariant); never over-charges a customer who started off-peak; deterministic.
- Cons: a session that started off-peak and ran into peak is min-charged at the off-peak rate (favours the customer — acceptable, and the floor rarely binds for sessions long enough to cross a boundary).
- Evidence: trial `computeOpenMeterCost` min-charge block (`D:\K3\Pochinki\src\pricing\engine.ts` lines 88–105).

#### Option B — Highest-rate segment
- Pros: maximises floor revenue.
- Cons: surprises a customer who never played at peak; not the trial behavior; PM declined. Rejected.

---

## The `@ps/core` API contract (what the core-engineer builds)

All functions live under `packages/core/src/pricing/`, are re-exported via `packages/core/src/pricing/index.ts` and the root `packages/core/src/index.ts`, and obey the hard rules: **pure, integer piastres, no `Date.now()` in cost math, no framework imports, round once per segment, never re-round a sum.** They reuse existing exports (`openMeterCostPiastres`, `roundUpMinutes`, `billableMinutes`, `elapsedMinutes`, `dayTypeAt`, `localHm`, `isWithinWindow`, `sumPiastres`) and existing types (`RateRule`, `SessionSegment`, `Session`, `BillingMode`, `PlayMode`, `Piastres`). Suggested files: `rate-rules.ts` (resolution + boundaries), `session-cost.ts` (aggregator, prepaid, fixed-match, grand total, reconstruction). New tests: `rate-rules.test.ts`, `session-cost.test.ts`; existing `purity.test.ts` extended to cover the new module.

### 1. Rate-rule resolution

```ts
/** Context for resolving a rate rule at one instant. Never reads the clock. */
export interface RuleContext {
  device_type: string;
  play_mode: PlayMode;            // 'single' | 'multi'  (concrete, never 'any')
  billing_mode: BillingMode;      // 'open' | 'prepaid' | 'fixed_match'
  at_iso: string;                 // UTC ISO instant; day_type + window resolved in Cairo
}

/**
 * True iff `rule` is active and every condition matches `ctx`:
 *  - billing_mode equal;
 *  - device_type equal OR rule.device_type === 'any';
 *  - play_mode equal OR rule.play_mode === 'any';
 *  - day_type === dayTypeAt(ctx.at_iso) (Cairo) OR rule.day_type === 'any';
 *  - isWithinWindow(ctx.at_iso, rule.time_start, rule.time_end) (end-exclusive, midnight-wrap, null=all-day).
 * Pure; no clock read.
 */
export function ruleMatches(rule: RateRule, ctx: RuleContext): boolean;

/**
 * Highest-priority active matching rule; ties broken deterministically by `id`
 * (ascending) so the result is independent of input array order. Returns `null`
 * when no rule matches (the documented no-match fallback → callers treat as rate 0).
 * Pure; no clock read; does not mutate `rules`.
 */
export function resolveRule(rules: RateRule[], ctx: RuleContext): RateRule | null;
```
Error behavior: no throws. A malformed `at_iso` flows through the existing `time` helpers (dayjs) and yields a deterministic result for valid ISO; callers pass valid UTC ISO (the write path uses `nowIso()`).

### 2. Boundary enumeration (Decision 3)

```ts
/** Context for boundary enumeration — the fixed dimensions over the interval. */
export interface BoundaryContext {
  device_type: string;
  play_mode: PlayMode;
  billing_mode: BillingMode;
}

/**
 * Ascending, de-duplicated list of UTC-ISO instants STRICTLY inside
 * (startIso, endIso) at which resolveRule(rules, {...ctx, at_iso}) changes
 * resolved rule id (Decision 2). Endpoints excluded. Empty array ⇒ a single
 * segment spans the whole interval. Pure; instants + rules passed in; no clock
 * read. Returns [] when endIso <= startIso. (Algorithm: ADR §"Boundary
 * enumeration algorithm".)
 */
export function rateBoundaryInstants(
  rules: RateRule[],
  ctx: BoundaryContext,
  startIso: string,
  endIso: string,
): string[];

/** One materialized sub-segment plan: a [from,to) with its resolved rule snapshot. */
export interface SegmentPlan {
  started_at: string;
  ended_at: string;
  play_mode: PlayMode;
  rate_rule_id: string | null;          // resolved rule's id at `started_at`, or null
  price_per_hour_snapshot: Piastres;    // resolved rule's price_per_hour, or 0 if null
}

/**
 * Split [startIso, endIso) for a given play_mode into the ordered SegmentPlan[]
 * the close/switch write path materializes (one per sub-interval between
 * boundaries; snapshot resolved at each sub-interval's own start). Pure.
 * Used by the write path; the live preview uses the same boundaries to sum cost
 * without persisting.
 */
export function planSegments(
  rules: RateRule[],
  ctx: BoundaryContext,
  startIso: string,
  endIso: string,
): SegmentPlan[];
```

### 3. Multi-segment open-meter aggregator (Decision 4)

```ts
/** One billed open-meter segment (stored snapshot or planned). */
export interface SegmentCostInput {
  price_per_hour: Piastres;             // the FROZEN snapshot rate for this segment
  started_at: string;
  ended_at: string;                     // for an open segment, pass at_iso (the render/close instant)
}

export interface OpenMeterModifiers {
  rounding_minutes: number;             // from the FIRST segment's resolving rule
  min_charge_minutes: number;           // from the FIRST segment's resolving rule (Decision 4)
}

export interface OpenMeterTotal {
  total: Piastres;                      // Σ per-segment integer costs, min-charge applied once
  billable_minutes: number;
}

/**
 * Sum per-segment open-meter costs (each rounded once at its own snapshot rate via
 * openMeterCostPiastres / roundUpMinutes), then apply min-charge ONCE at session
 * level using the FIRST segment's rate (Decision 4). The sum is NEVER re-rounded.
 * Empty segments ⇒ { total: 0, billable_minutes: 0 }. Pure; instants passed in.
 */
export function aggregateOpenMeter(
  segments: SegmentCostInput[],
  mods: OpenMeterModifiers,
): OpenMeterTotal;
```

### 4. Prepaid (Decision 6 + lock invariant)

```ts
export interface PrepaidCostInput {
  prepaid_total: Piastres | null;       // LOCKED price at purchase; null ⇒ legacy fallback
  block_price?: Piastres | null;        // legacy fallback only (used iff prepaid_total == null)
  blocks?: number;                      // legacy fallback; default 1, floored at 1
}

/**
 * Prepaid time cost. If `prepaid_total` is non-null (INCLUDING 0) → return it
 * EXACTLY; never consult rules (lock invariant, AC 14–16). If null → legacy
 * fallback round(block_price × max(1, blocks)), defaulting block_price to 0.
 * prepaid_minutes is advisory (Decision 6) and is NOT an input here. Pure.
 */
export function computePrepaidCost(input: PrepaidCostInput): Piastres;
```

### 5. Fixed-match (Decision 7)

```ts
export interface FixedMatchCostInput {
  fixed_match_price: Piastres;          // LOCKED at start (snapshot on first segment)
  match_count: number | null;          // floored at 0; null ⇒ 0
}

/** cost = fixed_match_price × max(0, match_count|0). Integer piastres. Pure. */
export function computeFixedMatchCost(input: FixedMatchCostInput): Piastres;
```

### 6. Grand total

```ts
export interface GrandTotalInput {
  time_total: Piastres;                 // from aggregate/prepaid/fixed-match
  orders_total?: Piastres;              // default 0 (Phase 5 supplies real value)
  discount?: Piastres;                  // default 0 (Phase 5 UI; engine accepts now)
}

/** grand_total = time_total + orders_total − discount, clamped >= 0, integer. Pure. */
export function computeGrandTotal(input: GrandTotalInput): Piastres;
```

### 7. Bill reconstruction from snapshots ALONE (AC 25 / 37 / 38)

```ts
export interface ReconstructInput {
  billing_mode: BillingMode;
  segments: SessionSegment[];           // stored rows: play_mode, price_per_hour_snapshot, started_at, ended_at
  /** Session-level locked values (read from the session row / first segment). */
  prepaid_total?: Piastres | null;
  match_count?: number | null;
  /** Modifiers anchored from the FIRST segment's rule, snapshotted at close. */
  modifiers?: OpenMeterModifiers;
  /** Instant for any still-open segment (live); omit at close (segments are closed). */
  at_iso?: string;
}

/**
 * Compute the time cost of a session from STORED snapshots ONLY — never reads
 * current rate_rules (CLAUDE.md §3, AC 25). Open mode → aggregateOpenMeter over
 * the segments' snapshot rates; prepaid → computePrepaidCost(prepaid_total);
 * fixed_match → computeFixedMatchCost(first-segment snapshot × match_count).
 * For an open segment (ended_at == null), bills to `at_iso` (live); at close all
 * segments are closed so the result equals the stored time_total. Pure.
 */
export function reconstructTimeCost(input: ReconstructInput): Piastres;
```

**Live vs. close usage:** the mobile live card calls `planSegments(rules, ctx, openSeg.started_at, at_iso)` → feeds the plans (as `SegmentCostInput` with `ended_at = at_iso` on the last) into `aggregateOpenMeter`, adds prior *closed* segments, then `computeGrandTotal`. The close write path calls the same `planSegments` to materialize rows, stores `time_total` from `aggregateOpenMeter`, then later any auditor calls `reconstructTimeCost` over the stored rows and gets the identical number — proving reconstructibility.

---

## Consequences

- **Becomes easy:**
  - One pure engine drives live preview, close materialization, and audit reconstruction — they cannot disagree (same `planSegments`/`aggregateOpenMeter`).
  - No `peak_windows` config to maintain; boundaries fall out of the rule set; the web preview uses the very `resolveRule` the counter uses (AC 31).
  - Mobile needs no money-bearing timer; a render tick only refreshes display (§2.2 satisfied by construction).
  - Owner-only `rate_rules` RLS from Phase 2/3 covers AC 32 unchanged — only an audit write is added (no new policy).
- **Becomes hard / watch-outs:**
  - The close/switch path MUST call `planSegments` (not write a single naive segment) or a boundary-crossing session would store a wrong, non-reconstructible bill. This is the central correctness contract — gate it in tests.
  - DST: a boundary landing in Cairo's spring-forward/fall-back hour must still map to a defined UTC instant — engineer adds an explicit DST-spanning test.
  - Fixed-match re-uses `price_per_hour_snapshot` as the locked per-match price — document this clearly in code so no one resolves fixed-match from current rules at close.
- **Follow-up / deferred (engine accepts inputs now, UI later):** orders_total + discount UI → Phase 5; prepaid top-up/expiry → later (advisory `prepaid_minutes` only now); per-branch rate overrides → future ADR (ADR-0004 left the door open).
- **Must verify (Phase-4 QA gates):**
  - `pricing-engine-guard`: no `Date.now()` in cost math, no floats, round once per segment, no framework imports.
  - Unit: AC 1–26 (resolution priority + id tie-break + Cairo weekend incl. UTC↔Cairo boundary; end-exclusive + midnight-wrap windows; null-bound all-day; no-match→null; open-meter sum-not-re-rounded; min-charge once at first rate; prepaid lock incl. `0` valid and rate-change-after-start; fixed-match lock; multi-boundary `planSegments` determinism; `reconstructTimeCost` == stored `time_total`) at **>90% line coverage** on `packages/core/src/pricing`.
  - New: a DST-spanning boundary test and a multi-window (off-peak→peak→after-midnight) `rateBoundaryInstants` determinism test.
  - Full `ps-verify` (tsc 0 errors, jest, `expo export`, `next build`).
  - **`security-reviewer` signs off** on Decision 5 (audit taxonomy) and AC 32/40/43 (owner-only rate-rule write + `WITH CHECK`, one audit row per close for all modes, prepaid lock to ledger). Human project owner approves at the Phase-4 gate.
