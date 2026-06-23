/**
 * @ps/core — pure, framework-free domain logic.
 *
 * This package is the home for logic PORTED from the Pochinki trial:
 *   - pricing/      rate-rule resolution + open/prepaid/fixed-match cost (engine, session, segments)
 *   - money         integer piastres (100 = 1 EGP), formatting, Arabic-Indic digits
 *   - time          Africa/Cairo timezone math, weekday/weekend, peak windows
 *   - inventory     stock ledger aggregation (on-hand = sum of deltas), oversell guard
 *   - types         shared domain types (Tenant, Branch, Device, Session, Order, ...)
 *
 * HARD RULES (see ../../CLAUDE.md):
 *   - NO imports from React, React Native, Expo, Next.js, or Supabase. This package must run in plain Node for tests.
 *   - Money is always integer piastres. Never floats.
 *   - Functions are pure: same input -> same output, no I/O, no Date.now() inside cost math (pass timestamps in).
 *
 * Phase 2 (Tenant foundation) ports money/time/inventory/types here.
 * Phase 4 (Devices + Sessions + Pricing) ports the pricing engine here.
 */

export const CORE_PLACEHOLDER = true;
