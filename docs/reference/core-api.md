# Reference: `@ps/core` port targets (from Pochinki trial)

The trial's pure logic is proven and tested. **Port and generalize** it into `packages/core/src`; do not import from the trial. Source: `D:\K3\Pochinki\src`. Money is integer **piastres** (100 = 1 EGP) everywhere.

> Generalization note: where the trial hardcodes `Africa/Cairo` / EGP, keep that behavior for now (Phase 1 decision) but isolate it behind a constant so multi-currency/timezone can be added later without touching call sites.

## money (port from `src/lib/money.ts`)
```ts
type Piastres = number              // integer
toArabicDigits(input: string): string          // '12345' -> '١٢٣٤٥' (display only)
egpToPiastres(egp: number): Piastres            // Math.round, no float drift
piastresToEgp(piastres: Piastres): number
formatEgp(piastres: Piastres, withSuffix = true): string   // '125٬000 ج.م'; omits .00 for whole pounds; handles negatives
sumPiastres(amounts: Piastres[]): Piastres
```
Constants: Arabic digits `٠١٢٣٤٥٦٧٨٩`, currency suffix `ج.م`, thousands sep `٬`.
Extra display helpers from `src/lib/format.ts`: `formatEgpCompact`, `formatPercent`, `formatInt`, `formatDurationMin`, `formatRelative`, `formatDate`, `formatTime`.

## time (port from `src/lib/time.ts`)
```ts
const CAFE_TZ = 'Africa/Cairo'
type DayType = 'weekday' | 'weekend'            // Fri(5)+Sat(6) = weekend, computed in CAFE_TZ
nowIso(): string                                 // UTC ISO
elapsedMinutes(startIso, endIso?): number        // clamps negative -> 0
elapsedSeconds(startIso, endIso?): number
formatClock(totalSeconds): string                // 'HH:MM:SS'
dayTypeAt(iso): DayType
localHm(iso): string ; localHour(iso): number
isWithinWindow(iso, start: 'HH:mm'|null, end: 'HH:mm'|null): boolean   // [start,end) END EXCLUSIVE; wraps past midnight if start>end; null bounds = all-day
```

## id (port from `src/lib/id.ts`)
```ts
uuidv4(): string     // client-generated UUIDs for idempotent writes
```

## pricing engine (port from `src/pricing/engine.ts`)
```ts
interface RuleContext { device_type: string; play_mode: 'single'|'multi'; billing_mode: BillingMode; at_iso: string }
ruleMatches(rule: RateRule, ctx: RuleContext): boolean
resolveRule(rules: RateRule[], ctx: RuleContext): RateRule | null   // matches device_type/play_mode/billing_mode/day_type/time-window; HIGHEST priority wins; ties broken by id
roundUpMinutes(minutes, increment): number                          // Math.ceil(min/incr)*incr; 0 incr -> ceil to whole min; <=0 -> 0
openSegmentCost(elapsedMinutes, pricePerHour, roundingMinutes): Piastres
computeOpenMeterCost(segments: SegmentInput[], mods: { rounding_minutes; min_charge_minutes }): { total; billable_minutes }
computePrepaidCost(blockPrice, blocks=1): Piastres
computeFixedMatchCost(fixedMatchPrice, matchCount): Piastres
computeOrdersTotal(items: {qty; unit_price}[]): Piastres
computeGrandTotal(input): Piastres
```
Algorithm: **round per segment, apply min-charge once at session level**, then `grand_total = time_total + orders_total − discount`.

## session pricing (port from `src/pricing/session.ts`)
```ts
modifiersFromRule(rule): { rounding_minutes; min_charge_minutes }
segmentsToInputs(segments, atIso?): SegmentInput[]
computeTimeCost(input: TimeCostInput): Piastres
timeCostFromSession(session, segments, rule, atIso?): Piastres
```
**Prepaid lock (critical invariant):** if `prepaid_total` is non-null, charge it EXACTLY — never reconstruct from current rules. `prepaid_total: 0` is valid (not "missing"). Legacy fallback: `blockPrice × blocks`. Open segments use `atIso` (default now); closed use `ended_at`.

## inventory (port from `src/features/inventory/stock.ts`)
```ts
const LOW_STOCK_DEFAULT = 5
type StockStatus = 'untracked'|'out'|'low'|'ok'
isTracked(product): boolean                       // stock !== null
computeLevels(movements): Record<productId, number>   // on-hand = Σ delta; CAN go negative (oversell signal)
offsettingVoids(sales): {product_id; delta}[]     // exact reversal of recorded sales
stockStatus(onHand, low=5): StockStatus           // <=0 out, <=low low (inclusive), else ok
inventoryValue(products, levels): number          // Σ onHand×cost for tracked, costed, positive
```

## shifts (port from `src/features/shifts/money.ts`)
```ts
summarizeShift(sessions: RevRow[], walkins: WalkinRow[], debtCollected=0): ShiftSummary
breakdownPayments(sessions, walkins): PaymentBreakdown   // cash/wallet/other/debt
```
**Rules:** walk-ins count in `totalSales`; debt collections raise `cashSales` (drawer) but NOT `totalSales` (no double count); null payment_method defaults to `cash` for walk-ins, `other` for sessions.

## debts (port from `src/features/debts/debt.ts`)
```ts
paidByDebt(payments): Record<debtId, number>
withRemaining(debts, paid): DebtWithRemaining[]    // remaining = max(0, amount − paid)
totalOutstanding(list): number
```

## Domain enums (port from `src/lib/types.ts`)
`Role` owner|manager (NEW: super_admin) · `PermissionKey` restock|void|manageDebts|discount · `DeviceStatus` free|busy|maintenance · `PlayMode` single|multi (+`'any'` for rules) · `BillingMode` open|prepaid|fixed_match · `DayTypeRule` weekday|weekend|any · `SessionStatus` active|closed|void · `PaymentMethod` cash|wallet|other|debt · `OrderStatus` open|paid|void · `StockReason` initial|restock|adjust|sale|void · `ShiftStatus` open|closed.

## Hard rules (enforced by `pricing-engine-guard`)
- Never `Date.now()` inside cost math — pass `at_iso`. Never floats for money. Round once per segment.
- No React/RN/Expo/Next/Supabase imports in `@ps/core`. Target **>90%** line coverage.
