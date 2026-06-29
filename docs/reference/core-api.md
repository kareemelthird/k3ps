# Reference: `@ps/core` — sound logic to learn from the trial

The Pochinki trial is a **learning input, not a blueprint**. Its money/time/pricing **algorithms and invariants are sound** — reuse them in `packages/core/src`, but write a **fresh, cleaner API**, improve where you can, and **never import from the trial**. Source for lessons only: `D:\K3\Pochinki\src`. Money is integer **piastres** (100 = 1 EGP) everywhere.

> Localization note: treat `Africa/Cairo` / EGP as the current default behind named constants, so multi-currency/timezone can be added later without touching call sites.

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

## Phase-4 pricing engine (LOCKED — see [ADR-0005](../adr/0005-pricing-engine-segments-and-boundaries.md))

The Phase-4 surface added under `packages/core/src/pricing` (re-exported from the root). Decisions: live **preview-splits / close-materializes** (no money-bearing mobile tick); boundaries split on resolved **`rate_rule_id`**; boundaries are **derived from the rule set** (no `peak_windows`); min-charge **once at session level at the first segment's rate**; rate-rule changes are **audited** (`rate_rule.create|update|deactivate|reactivate`, `amount=null`); prepaid `prepaid_minutes` is **advisory only** (price lock is the invariant); fixed-match price is **locked at start on the first segment's `price_per_hour_snapshot`**.

```ts
// resolution
interface RuleContext { device_type: string; play_mode: PlayMode; billing_mode: BillingMode; at_iso: string }
ruleMatches(rule: RateRule, ctx: RuleContext): boolean
resolveRule(rules: RateRule[], ctx: RuleContext): RateRule | null   // highest priority; id tie-break; null = no rule (rate 0)

// boundaries (no peak_windows; derived from rules — ADR-0005 algorithm)
interface BoundaryContext { device_type: string; play_mode: PlayMode; billing_mode: BillingMode }
rateBoundaryInstants(rules, ctx, startIso, endIso): string[]        // ascending UTC ISO, strictly inside (start,end); split on rule-id change
interface SegmentPlan { started_at; ended_at; play_mode: PlayMode; rate_rule_id: string|null; price_per_hour_snapshot: Piastres }
planSegments(rules, ctx, startIso, endIso): SegmentPlan[]           // boundaries.length+1 plans; snapshot resolved at each sub-interval start

// open-meter aggregator (round once per segment; min-charge once @ first rate; never re-round the sum)
interface SegmentCostInput { price_per_hour: Piastres; started_at: string; ended_at: string }   // open seg → ended_at = at_iso
interface OpenMeterModifiers { rounding_minutes: number; min_charge_minutes: number }            // from FIRST segment's rule
aggregateOpenMeter(segments: SegmentCostInput[], mods: OpenMeterModifiers): { total: Piastres; billable_minutes: number }

// prepaid (lock invariant: non-null prepaid_total incl. 0 → charge exactly; null → block_price×max(1,blocks) fallback)
computePrepaidCost(input: { prepaid_total: Piastres|null; block_price?: Piastres|null; blocks?: number }): Piastres
// fixed-match (price locked at start)
computeFixedMatchCost(input: { fixed_match_price: Piastres; match_count: number|null }): Piastres
// grand total (orders + −discount, clamp >=0)
computeGrandTotal(input: { time_total: Piastres; orders_total?: Piastres; discount?: Piastres }): Piastres
// reconstruction from STORED snapshots ONLY (never reads current rate_rules — CLAUDE.md §3)
reconstructTimeCost(input: { billing_mode; segments: SessionSegment[]; prepaid_total?; match_count?; modifiers?: OpenMeterModifiers; at_iso? }): Piastres
```
**Live vs. close:** mobile live = `planSegments(open seg)` → `aggregateOpenMeter` (+ prior closed segs) → `computeGrandTotal`. Close = same `planSegments` materializes the rows; stored `time_total` later equals `reconstructTimeCost` over those rows (reconstructibility).

## entitlements (Phase 9 — SaaS billing)

Pure module `packages/core/src/entitlements/` (re-exported from core root). Resolves a tenant's feature access and limits from plan + subscription status, with the current timestamp passed in as an argument (never `Date.now()` in decisions — §2.4).

```ts
type PlanTier = 'trial' | 'starter' | 'pro' | 'enterprise'
type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled' | 'comped'
interface Entitlements {
  limits: { max_branches: number; max_devices: number; max_staff: number }
  features: Record<string, boolean>
  isReadOnly: boolean        // past_due after grace OR canceled → UI blocks writes; billing always reachable
  graceUntil: string | null  // ISO timestamp for past_due grace period end
}
resolveEntitlements(plan: PlanTier, status: SubscriptionStatus, nowIso: string): Entitlements
```
**States:** `trialing`/`active` = full access; `past_due`-within-grace = full access + banner; `past_due`-after-grace / `canceled` = `isReadOnly:true` (billing path always reachable); `comped` = plan overrides payment requirement. `security-reviewer` SIGN-OFF on entitlement enforcement boundary.

## observability scrubber (Phase 10 — `@ps/core/observability`)

Pure module `packages/core/src/observability/` (re-exported from core root). The **single audited source of truth** for the `beforeSend`/`beforeBreadcrumb` redaction policy that both the Next.js and Expo Sentry adapters delegate to. No `@sentry/*` import; operates on structural types only. Never throws (malformed/adversarial input degrades safely). Returns scrubbed copies; input is never mutated.

**Why it lives in core:** the scrubbing policy is security-critical and identical on both surfaces. One unit-tested implementation fed adversarial payloads is the single artifact the `security-reviewer` signs off, instead of two drifting per-app copies.

```ts
/** Sentry-shaped structural types — no @sentry import. */
interface SentryLikeBreadcrumb { type?; category?; message?; data?: Record<string,unknown>; level? }
interface SentryLikeEvent {
  message?; request?: { url?; query_string?; headers?; data?; cookies? };
  tags?: Record<string,unknown>; extra?; contexts?;
  breadcrumbs?: SentryLikeBreadcrumb[]; user?: Record<string,unknown>;
  [k: string]: unknown;   // exception/stacktrace are intentionally preserved
}

export const REDACTED = '[redacted]'

/** Key-substring denylist (case-insensitive): token, authorization, apikey, api_key, secret,
 *  password, cookie, email, phone, card, cvc, pan, dsn, service_role, jwt,
 *  access_token, refresh_token, signing, whsec */
export const SENSITIVE_KEY_PATTERNS: readonly string[]

/** Value-pattern denylist (regardless of key): JWT-shaped, sk_/rk_/whsec_-prefixed,
 *  13-19-digit card-like runs, email-shaped strings, bearer tokens, long hex. */
export const SENSITIVE_VALUE_PATTERNS: readonly RegExp[]

/** Tags permitted to leave the device. Everything else is stripped from event.tags. */
export const SAFE_TAG_KEYS: readonly string[]
// ['tenant_id', 'role', 'release', 'environment', 'route', 'screen']
// NOTE: email / name / phone are NOT on this list. No Sentry.setUser() is called.

export interface RedactOptions { maxDepth?: number }  // default 8 — no unbounded recursion

/** Deep clone + redact: keys matching SENSITIVE_KEY_PATTERNS → REDACTED;
 *  string values matching SENSITIVE_VALUE_PATTERNS → REDACTED. Pure, bounded. */
export function redactValue(value: unknown, opts?: RedactOptions): unknown

/** Strip tokens/credentials from a URL or query string. */
export function scrubUrl(url: string): string

/** Drop any tag whose key is not in SAFE_TAG_KEYS; redact remaining values defensively. */
export function scrubTags(tags: Record<string, unknown> | undefined): Record<string, unknown>

/** The `beforeSend` hook delegates to this. Redacts request/extra/contexts/breadcrumbs,
 *  scrubs request.url + query_string, enforces tag allowlist, removes user PII.
 *  Preserves exception type + stack frames (code locations, not data). */
export function scrubEvent(event: SentryLikeEvent, opts?: RedactOptions): SentryLikeEvent

/** The `beforeBreadcrumb` hook delegates to this. Returns null to drop an inherently
 *  sensitive crumb (e.g. auth/xhr body); otherwise redacts data/message. */
export function scrubBreadcrumb(crumb: SentryLikeBreadcrumb): SentryLikeBreadcrumb | null
```

**Adversarial-payload jest suite** asserts that none of the following survive `scrubEvent`/`scrubBreadcrumb`: a JWT in `extra`, an email in a breadcrumb message, a `sk_` Stripe key in `request.data`, a `grand_total` money row, an `Authorization` header, a token in the URL query string, a disallowed `customer_email` tag. It also asserts that `tenant_id`/`role`/`release` tags and exception stack frames **do** survive.

**DSN gating (both apps):** each runtime reads its publishable DSN env (`NEXT_PUBLIC_SENTRY_DSN` / `EXPO_PUBLIC_SENTRY_DSN`). If falsy the app does **not** call `Sentry.init` at all (`if (!dsn) return;`) — zero instrumentation overhead, zero network, zero console noise in dev/CI/contributor builds. `SENTRY_AUTH_TOKEN` (source-map upload) is server/CI-only, never committed, never in any bundle; its absence is gracefully skipped.

## Hard rules (enforced by `pricing-engine-guard`)
- Never `Date.now()` inside cost math or entitlement decisions — pass `at_iso`/`nowIso`. Never floats for money. Round once per segment.
- No React/RN/Expo/Next/Supabase imports in `@ps/core`. Target **>90%** line coverage on all modules.
- The scrubber additionally: never throws; never mutates input; operates on structural types (no `@sentry/*` import).
