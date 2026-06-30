/**
 * Tests for the pure settings validator + typed getters (ADR-0012 Decision C1).
 *
 * Covers:
 *   - validateSettings: each well-known key (valid + invalid inputs)
 *   - validateSettings: unknown keys pass through
 *   - getXxxSetting typed getters: valid value returned, invalid falls back
 *   - SETTINGS_DEFAULTS shape
 */

import {
  validateSettings,
  getBusinessDaySetting,
  getInventorySetting,
  getPeakWindowsSetting,
  getDisplaySetting,
  SETTINGS_DEFAULTS,
} from './settings';

// ─── SETTINGS_DEFAULTS shape ──────────────────────────────────────────────────

describe('SETTINGS_DEFAULTS', () => {
  it('business_day default has cutover_hour=6', () => {
    expect(SETTINGS_DEFAULTS.business_day).toEqual({ cutover_hour: 6 });
  });

  it('inventory default has low_stock_threshold=5', () => {
    expect(SETTINGS_DEFAULTS.inventory).toEqual({ low_stock_threshold: 5 });
  });

  it('peak_windows default has one window 18:00–02:00', () => {
    expect(SETTINGS_DEFAULTS.peak_windows).toEqual({
      windows: [{ start: '18:00', end: '02:00' }],
    });
  });

  it('display default is empty object', () => {
    expect(SETTINGS_DEFAULTS.display).toEqual({});
  });
});

// ─── validateSettings — unknown key ──────────────────────────────────────────

describe('validateSettings — unknown key', () => {
  it('unknown key passes through (extensible KV store)', () => {
    expect(validateSettings('cafe_name', '"Alpha Café"')).toBeNull();
    expect(validateSettings('currency', '"EGP"')).toBeNull();
    expect(validateSettings('future_feature', { anything: true })).toBeNull();
    expect(validateSettings('schema_version', 2)).toBeNull();
  });
});

// ─── validateSettings — business_day ─────────────────────────────────────────

describe('validateSettings — business_day', () => {
  it('valid: cutover_hour=6 (common default)', () => {
    expect(validateSettings('business_day', { cutover_hour: 6 })).toBeNull();
  });

  it('valid: boundary 0 (midnight cutover)', () => {
    expect(validateSettings('business_day', { cutover_hour: 0 })).toBeNull();
  });

  it('valid: boundary 23', () => {
    expect(validateSettings('business_day', { cutover_hour: 23 })).toBeNull();
  });

  it('invalid: cutover_hour=24 (out of range)', () => {
    const err = validateSettings('business_day', { cutover_hour: 24 });
    expect(err).not.toBeNull();
    expect(err).toContain('[0, 23]');
  });

  it('invalid: cutover_hour=-1', () => {
    expect(validateSettings('business_day', { cutover_hour: -1 })).not.toBeNull();
  });

  it('invalid: cutover_hour is float', () => {
    expect(validateSettings('business_day', { cutover_hour: 6.5 })).not.toBeNull();
  });

  it('invalid: cutover_hour is string', () => {
    const err = validateSettings('business_day', { cutover_hour: '6' });
    expect(err).not.toBeNull();
    expect(err).toContain('number');
  });

  it('invalid: not an object', () => {
    expect(validateSettings('business_day', 'bad')).not.toBeNull();
    expect(validateSettings('business_day', null)).not.toBeNull();
    expect(validateSettings('business_day', 6)).not.toBeNull();
  });
});

// ─── validateSettings — inventory ────────────────────────────────────────────

describe('validateSettings — inventory', () => {
  it('valid: low_stock_threshold=5', () => {
    expect(validateSettings('inventory', { low_stock_threshold: 5 })).toBeNull();
  });

  it('valid: boundary 0 (no threshold)', () => {
    expect(validateSettings('inventory', { low_stock_threshold: 0 })).toBeNull();
  });

  it('invalid: negative threshold', () => {
    const err = validateSettings('inventory', { low_stock_threshold: -1 });
    expect(err).not.toBeNull();
    expect(err).toContain('non-negative');
  });

  it('invalid: float threshold', () => {
    expect(validateSettings('inventory', { low_stock_threshold: 2.5 })).not.toBeNull();
  });

  it('invalid: string threshold', () => {
    expect(validateSettings('inventory', { low_stock_threshold: '5' })).not.toBeNull();
  });

  it('invalid: not an object', () => {
    expect(validateSettings('inventory', null)).not.toBeNull();
    expect(validateSettings('inventory', [])).not.toBeNull();
  });
});

// ─── validateSettings — peak_windows ─────────────────────────────────────────

describe('validateSettings — peak_windows', () => {
  it('valid: single window', () => {
    expect(
      validateSettings('peak_windows', { windows: [{ start: '18:00', end: '02:00' }] })
    ).toBeNull();
  });

  it('valid: multiple windows', () => {
    expect(
      validateSettings('peak_windows', {
        windows: [
          { start: '08:00', end: '12:00' },
          { start: '18:00', end: '23:59' },
        ],
      })
    ).toBeNull();
  });

  it('valid: empty windows array', () => {
    expect(validateSettings('peak_windows', { windows: [] })).toBeNull();
  });

  it('valid: boundary times 00:00 and 23:59', () => {
    expect(
      validateSettings('peak_windows', { windows: [{ start: '00:00', end: '23:59' }] })
    ).toBeNull();
  });

  it('invalid: start time 24:00 (out of range)', () => {
    const err = validateSettings('peak_windows', {
      windows: [{ start: '24:00', end: '02:00' }],
    });
    expect(err).not.toBeNull();
    expect(err).toContain('start');
    expect(err).toContain('HH:mm');
  });

  it('invalid: end time bad format', () => {
    const err = validateSettings('peak_windows', {
      windows: [{ start: '18:00', end: '2:00' }],
    });
    expect(err).not.toBeNull();
    expect(err).toContain('end');
  });

  it('invalid: window missing end', () => {
    const err = validateSettings('peak_windows', {
      windows: [{ start: '18:00' }],
    });
    expect(err).not.toBeNull();
  });

  it('invalid: windows is not an array', () => {
    const err = validateSettings('peak_windows', { windows: 'all day' });
    expect(err).not.toBeNull();
    expect(err).toContain('array');
  });

  it('invalid: not an object', () => {
    expect(validateSettings('peak_windows', null)).not.toBeNull();
  });
});

// ─── validateSettings — display ───────────────────────────────────────────────

describe('validateSettings — display', () => {
  it('valid: empty object', () => {
    expect(validateSettings('display', {})).toBeNull();
  });

  it('valid: cafe_name present as string', () => {
    expect(validateSettings('display', { cafe_name: 'Alpha Café' })).toBeNull();
  });

  it('valid: extra unknown keys allowed (extensible)', () => {
    expect(validateSettings('display', { cafe_name: 'X', theme: 'dark' })).toBeNull();
  });

  it('invalid: cafe_name is a number', () => {
    const err = validateSettings('display', { cafe_name: 42 });
    expect(err).not.toBeNull();
    expect(err).toContain('cafe_name');
    expect(err).toContain('string');
  });

  it('invalid: cafe_name is null', () => {
    // null is not a string
    const err = validateSettings('display', { cafe_name: null });
    expect(err).not.toBeNull();
  });

  it('invalid: not an object', () => {
    expect(validateSettings('display', 'Alpha')).not.toBeNull();
    expect(validateSettings('display', null)).not.toBeNull();
  });
});

// ─── Typed getters ────────────────────────────────────────────────────────────

describe('getBusinessDaySetting', () => {
  it('valid value is returned as-is', () => {
    expect(getBusinessDaySetting({ cutover_hour: 8 })).toEqual({ cutover_hour: 8 });
  });

  it('invalid value falls back to default', () => {
    expect(getBusinessDaySetting({ cutover_hour: 99 })).toEqual(SETTINGS_DEFAULTS.business_day);
  });

  it('null falls back to default', () => {
    expect(getBusinessDaySetting(null)).toEqual(SETTINGS_DEFAULTS.business_day);
  });

  it('undefined falls back to default', () => {
    expect(getBusinessDaySetting(undefined)).toEqual(SETTINGS_DEFAULTS.business_day);
  });

  it('string falls back to default', () => {
    expect(getBusinessDaySetting('6')).toEqual(SETTINGS_DEFAULTS.business_day);
  });
});

describe('getInventorySetting', () => {
  it('valid value returned', () => {
    expect(getInventorySetting({ low_stock_threshold: 10 })).toEqual({ low_stock_threshold: 10 });
  });

  it('invalid falls back to default', () => {
    expect(getInventorySetting({ low_stock_threshold: -1 })).toEqual(SETTINGS_DEFAULTS.inventory);
  });

  it('null falls back to default', () => {
    expect(getInventorySetting(null)).toEqual(SETTINGS_DEFAULTS.inventory);
  });
});

describe('getPeakWindowsSetting', () => {
  const valid = { windows: [{ start: '20:00', end: '04:00' }] };

  it('valid value returned', () => {
    expect(getPeakWindowsSetting(valid)).toEqual(valid);
  });

  it('invalid falls back to default', () => {
    expect(getPeakWindowsSetting({ windows: 'all day' })).toEqual(SETTINGS_DEFAULTS.peak_windows);
  });

  it('null falls back to default', () => {
    expect(getPeakWindowsSetting(null)).toEqual(SETTINGS_DEFAULTS.peak_windows);
  });
});

describe('getDisplaySetting', () => {
  it('valid value returned', () => {
    const v = { cafe_name: 'Beta Lounge' };
    expect(getDisplaySetting(v)).toEqual(v);
  });

  it('invalid falls back to default', () => {
    expect(getDisplaySetting({ cafe_name: 123 })).toEqual(SETTINGS_DEFAULTS.display);
  });

  it('null falls back to default', () => {
    expect(getDisplaySetting(null)).toEqual(SETTINGS_DEFAULTS.display);
  });
});
