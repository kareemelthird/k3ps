/**
 * Design tokens — "Calm Operations" dark-first palette.
 * Source of truth: docs/design/design-system.md §2–§4.
 * Never use raw hex in components — always import from here.
 */

// ─── Color: semantic tokens (dark = default) ──────────────────────────────────
export const colors = {
  bg: '#080C13',
  surface: '#0D131D',
  surface2: '#131A26',
  surface3: '#1E293B',
  border: '#22304A',
  borderStrong: '#33476B',
  text: '#EEF2F6',
  textMuted: '#94A3B8',
  textFaint: '#64748B',
  primary: '#14B8A6',
  primaryPress: '#0D9488',
  onPrimary: '#080C13',
  statusFree: '#10B981',
  statusBusy: '#3B82F6',
  statusMaint: '#64748B',
  warning: '#F59E0B',
  danger: '#EF4444',
  info: '#3B82F6',
  scrim: 'rgba(0,0,0,0.6)',
} as const;

// ─── Spacing (4/8pt rhythm) ───────────────────────────────────────────────────
export const spacing = {
  '2xs': 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 20,
  xl: 24,
  '2xl': 32,
  '3xl': 48,
} as const;

// ─── Border radius ────────────────────────────────────────────────────────────
export const radius = {
  xs: 8,   // chip / badge
  sm: 10,  // input / button
  md: 14,  // card
  lg: 20,  // sheet / modal
  pill: 999,
} as const;

// ─── Typography sizes ─────────────────────────────────────────────────────────
export const fontSize = {
  display: 34,
  h1: 26,
  h2: 20,
  h3: 17,
  body: 16,
  label: 14,
  caption: 13,
  micro: 12,
  timer: 28,
  money: 20,
} as const;

export const fontWeight = {
  display: '800' as const,
  h1: '700' as const,
  h2: '700' as const,
  h3: '600' as const,
  body: '400' as const,
  label: '500' as const,
  caption: '500' as const,
  micro: '600' as const,
  timer: '600' as const,
  money: '700' as const,
} as const;

export const lineHeight = {
  display: 40,
  h1: 32,
  h2: 28,
  h3: 24,
  body: 24,
  label: 20,
  caption: 18,
  micro: 16,
  timer: 32,
  money: 28,
} as const;

// ─── Tap target floor ─────────────────────────────────────────────────────────
/** Minimum tap target height (counter-speed floor, design-system §7). */
export const TAP_TARGET = 52;

// ─── Motion ───────────────────────────────────────────────────────────────────
export const duration = {
  instant: 0,
  fast: 150,
  base: 220,
  slow: 320,
} as const;
