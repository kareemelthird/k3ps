/**
 * @ps/core — pure, framework-free domain logic.
 *
 * Phase 2 (Tenant foundation) ships:
 *   - money      integer piastres (100 = 1 EGP), formatting, Arabic-Indic digits
 *   - time       Africa/Cairo timezone math, weekday/weekend, peak windows
 *   - id         client-generated UUID v4 for idempotent / offline-safe writes
 *   - inventory  stock ledger (on-hand = Σ deltas), oversell signal, valuation
 *   - types      shared multi-tenant domain types (Tenant, Branch, TenantMember,
 *                operational entities with tenant_id / branch_id)
 *
 * Phase 3 adds the open-meter cost helper under pricing/ so the counters bill
 * through @ps/core (integer piastres) instead of inline floats. Phase 4 will
 * extend pricing/ with rate-rule resolution + the multi-segment session engine,
 * consuming the money/time primitives above with no API churn.
 *
 * HARD RULES (CLAUDE.md §2, §4):
 *   - NO imports from React, React Native, Expo, Next.js, or Supabase.
 *   - Money is always integer piastres. Never floats.
 *   - Pure: same input -> same output, no I/O. Timestamps are passed in as
 *     arguments; only nowIso() reads the system clock, and it must never be
 *     called from inside cost-relevant math.
 */

export * from './money';
export * from './time';
export * from './id';
export * from './inventory';
export * from './pricing';
export * from './orders';
export * from './shifts';
export * from './reports';
export * from './outbox';
export * from './types';
