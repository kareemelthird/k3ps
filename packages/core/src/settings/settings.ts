/**
 * settings — pure helpers for the tenant KV settings table (ADR-0012 Decision C1)
 *
 * The existing `public.settings(tenant_id, key, value jsonb)` table is reused
 * as-is (migration 0002, RLS from migration 0004). This module provides:
 *   - A union of well-known key names.
 *   - Typed value interfaces for each key.
 *   - Validators: validateSettings(key, value) → error string | null.
 *   - Safe typed getters with fallback to the per-key default.
 *
 * HARD RULES (CLAUDE.md §4):
 *   - Pure: no I/O, no clock, no React/RN/Expo/Next/Supabase imports.
 *   - The clock is never read here (none of these settings are time-dependent).
 *   - Unknown keys pass through without error (extensible KV store).
 *
 * Well-known keys and their defaults (ADR-0012 §Settings):
 *   | key            | value shape                              | default              |
 *   |----------------|------------------------------------------|----------------------|
 *   | business_day   | { cutover_hour: int 0..23 }             | { cutover_hour: 6 }  |
 *   | inventory      | { low_stock_threshold: int >= 0 }        | { low_stock_threshold: 5 } |
 *   | peak_windows   | { windows: [{start:'HH:mm',end:'HH:mm'}] } | see DEFAULTS below |
 *   | display        | { cafe_name?: string, … }               | {}                   |
 *
 * Note: business_day is already in production use (migration 0007 clamps
 * cutover_hour to [0,23] server-side; the validator here enforces the same range
 * on the write path).
 */

// ─── Key type ────────────────────────────────────────────────────────────────

/** The set of well-known tenant settings keys. Unknown keys are allowed too. */
export type SettingsKey = 'business_day' | 'inventory' | 'peak_windows' | 'display';

// ─── Value interfaces ─────────────────────────────────────────────────────────

/** value for key='business_day' */
export interface BusinessDaySetting {
  /** Hour in Cairo local time (0–23) at which a new business day begins. */
  cutover_hour: number;
}

/** value for key='inventory' */
export interface InventorySetting {
  /** Stock level at or below which a product is considered "low stock". */
  low_stock_threshold: number;
}

/** A single peak window (times are Cairo local wall-clock, HH:mm). */
export interface PeakWindow {
  /** Start time as 'HH:mm' (e.g. '18:00'). May wrap past midnight. */
  start: string;
  /** End time as 'HH:mm' (e.g. '02:00'). */
  end: string;
}

/** value for key='peak_windows' */
export interface PeakWindowsSetting {
  windows: PeakWindow[];
}

/** value for key='display' (extensible; only cafe_name is typed here). */
export interface DisplaySetting {
  cafe_name?: string;
  [key: string]: unknown;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

/**
 * Default values for each well-known key.
 * A UI reads a missing key and falls back to these, matching the existing
 * behaviour in ReportsView.tsx (business_day fallback = 6).
 */
export const SETTINGS_DEFAULTS: {
  readonly business_day: BusinessDaySetting;
  readonly inventory:    InventorySetting;
  readonly peak_windows: PeakWindowsSetting;
  readonly display:      DisplaySetting;
} = {
  business_day: { cutover_hour: 6 },
  inventory:    { low_stock_threshold: 5 },
  peak_windows: { windows: [{ start: '18:00', end: '02:00' }] },
  display:      {},
} as const;

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Validate a settings value for a given key.
 *
 * Returns `null` when the value is valid (or the key is unknown — unknown keys
 * pass through; the KV store is extensible). Returns a non-empty error message
 * string when the value is structurally invalid for the known key.
 *
 * Pure: no I/O.
 */
export function validateSettings(key: string, value: unknown): string | null {
  switch (key) {
    case 'business_day':  return validateBusinessDay(value);
    case 'inventory':     return validateInventory(value);
    case 'peak_windows':  return validatePeakWindows(value);
    case 'display':       return validateDisplay(value);
    default:              return null; // unknown key — extensible, pass through
  }
}

// ─── Typed getters with safe fallback ────────────────────────────────────────

/**
 * Parse a raw settings value as BusinessDaySetting.
 * Falls back to the default when the value is missing or invalid.
 */
export function getBusinessDaySetting(raw: unknown): BusinessDaySetting {
  return validateBusinessDay(raw) === null
    ? (raw as BusinessDaySetting)
    : SETTINGS_DEFAULTS.business_day;
}

/**
 * Parse a raw settings value as InventorySetting.
 * Falls back to the default when the value is missing or invalid.
 */
export function getInventorySetting(raw: unknown): InventorySetting {
  return validateInventory(raw) === null
    ? (raw as InventorySetting)
    : SETTINGS_DEFAULTS.inventory;
}

/**
 * Parse a raw settings value as PeakWindowsSetting.
 * Falls back to the default when the value is missing or invalid.
 */
export function getPeakWindowsSetting(raw: unknown): PeakWindowsSetting {
  return validatePeakWindows(raw) === null
    ? (raw as PeakWindowsSetting)
    : SETTINGS_DEFAULTS.peak_windows;
}

/**
 * Parse a raw settings value as DisplaySetting.
 * Falls back to the default when the value is missing or invalid.
 */
export function getDisplaySetting(raw: unknown): DisplaySetting {
  return validateDisplay(raw) === null
    ? (raw as DisplaySetting)
    : SETTINGS_DEFAULTS.display;
}

// ─── Private validators ───────────────────────────────────────────────────────

function validateBusinessDay(value: unknown): string | null {
  if (!isPlainObject(value)) return 'business_day must be an object';
  const v = value as Record<string, unknown>;
  const h: unknown = v['cutover_hour'];
  if (typeof h !== 'number') return 'business_day.cutover_hour must be a number';
  if (!Number.isInteger(h) || h < 0 || h > 23) {
    return 'business_day.cutover_hour must be an integer in [0, 23]';
  }
  return null;
}

function validateInventory(value: unknown): string | null {
  if (!isPlainObject(value)) return 'inventory must be an object';
  const v = value as Record<string, unknown>;
  const t: unknown = v['low_stock_threshold'];
  if (typeof t !== 'number') return 'inventory.low_stock_threshold must be a number';
  if (!Number.isInteger(t) || t < 0) {
    return 'inventory.low_stock_threshold must be a non-negative integer';
  }
  return null;
}

/** HH:mm 24-hour format; hours 00–23, minutes 00–59. */
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function validatePeakWindows(value: unknown): string | null {
  if (!isPlainObject(value)) return 'peak_windows must be an object';
  const v = value as Record<string, unknown>;
  const windows: unknown = v['windows'];
  if (!Array.isArray(windows)) return 'peak_windows.windows must be an array';
  for (let i = 0; i < windows.length; i++) {
    const w: unknown = windows[i];
    if (!isPlainObject(w)) return `peak_windows.windows[${i}] must be an object`;
    const win = w as Record<string, unknown>;
    const start: unknown = win['start'];
    const end: unknown = win['end'];
    if (typeof start !== 'string' || !TIME_RE.test(start)) {
      return `peak_windows.windows[${i}].start must be in HH:mm format (00:00–23:59)`;
    }
    if (typeof end !== 'string' || !TIME_RE.test(end)) {
      return `peak_windows.windows[${i}].end must be in HH:mm format (00:00–23:59)`;
    }
  }
  return null;
}

function validateDisplay(value: unknown): string | null {
  if (!isPlainObject(value)) return 'display must be an object';
  const v = value as Record<string, unknown>;
  const cafeName: unknown = v['cafe_name'];
  if (cafeName !== undefined && typeof cafeName !== 'string') {
    return 'display.cafe_name must be a string if provided';
  }
  return null;
}

function isPlainObject(v: unknown): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
