'use client';

/**
 * SettingsView — owner tenant settings editor (Slice 2, ADR-0012 Decision C1).
 *
 * Reads/writes the `public.settings(tenant_id, key, value jsonb)` KV table using
 * the existing owner-write RLS policy (settings_owner_write, migration 0004).
 *
 * Well-known keys (validated by @ps/core/settings before every write):
 *   business_day   — { cutover_hour: int 0–23 }
 *   inventory      — { low_stock_threshold: int >= 0 }
 *   peak_windows   — { windows: [{start:'HH:mm', end:'HH:mm'}] }
 *   display        — { cafe_name?: string }
 *
 * Each section has its own Save button and inline error; validation happens
 * before every upsert so invalid data never reaches the DB.
 *
 * HARD RULES:
 *  - All strings from i18n — no hardcoded user-facing text.
 *  - RTL: logical spacing only.
 *  - Tenant isolation: tenant_id from JWT claim, never client-supplied trust.
 *  - validateSettings() before every upsert — no raw DB constraint dependency.
 *  - Money / numbers displayed via toArabicDigits where user-visible.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  validateSettings,
  getBusinessDaySetting,
  getInventorySetting,
  getPeakWindowsSetting,
  getDisplaySetting,
  SETTINGS_DEFAULTS,
  toArabicDigits,
  type PeakWindow,
} from '@ps/core';
import { Button } from '@/components/ui/Button';
import { ErrorState } from '@/components/ui/ErrorState';
import { getBrowserClient } from '@/lib/supabase/client';
import { useAuth } from '@/lib/auth/AuthContext';

// ─── Types ─────────────────────────────────────────────────────────────────

type SettingsKey = 'business_day' | 'inventory' | 'peak_windows' | 'display';

// ─── Section card shell ────────────────────────────────────────────────────

function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-md bg-surface border border-border p-lg space-y-md">
      <div className="space-y-xs border-b border-border pb-sm">
        <h2 className="text-h3 text-text">{title}</h2>
        {description && <p className="text-caption text-text-muted">{description}</p>}
      </div>
      {children}
    </section>
  );
}

// ─── Main view ─────────────────────────────────────────────────────────────

export function SettingsView() {
  const t = useTranslations();
  const { claim } = useAuth();

  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingSettings, setLoadingSettings] = useState(true);

  // business_day
  const [cutoverHour, setCutoverHour] = useState<string>(
    String(SETTINGS_DEFAULTS.business_day.cutover_hour),
  );
  const [cutoverError, setCutoverError] = useState<string | null>(null);
  const [cutoverSaving, setCutoverSaving] = useState(false);
  const [cutoverSaved, setCutoverSaved] = useState(false);

  // inventory
  const [lowStockThreshold, setLowStockThreshold] = useState<string>(
    String(SETTINGS_DEFAULTS.inventory.low_stock_threshold),
  );
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [inventorySaving, setInventorySaving] = useState(false);
  const [inventorySaved, setInventorySaved] = useState(false);

  // peak_windows
  const [peakWindows, setPeakWindows] = useState<PeakWindow[]>(
    SETTINGS_DEFAULTS.peak_windows.windows.map((w) => ({ ...w })),
  );
  const [peakError, setPeakError] = useState<string | null>(null);
  const [peakSaving, setPeakSaving] = useState(false);
  const [peakSaved, setPeakSaved] = useState(false);

  // display
  const [cafeName, setCafeName] = useState<string>(SETTINGS_DEFAULTS.display.cafe_name ?? '');
  const [displayError, setDisplayError] = useState<string | null>(null);
  const [displaySaving, setDisplaySaving] = useState(false);
  const [displaySaved, setDisplaySaved] = useState(false);

  // ─── Load existing settings ─────────────────────────────────────────────

  const loadSettings = useCallback(async () => {
    if (!claim?.tenant_id) return;
    setLoadingSettings(true);
    setLoadError(null);
    try {
      const supabase = getBrowserClient();
      const { data, error: err } = await supabase
        .from('settings')
        .select('key, value')
        .eq('tenant_id', claim.tenant_id);

      if (err) throw err;

      const rows = (data ?? []) as Array<{ key: string; value: unknown }>;
      const byKey = new Map(rows.map((r) => [r.key, r.value]));

      const bd = getBusinessDaySetting(byKey.get('business_day'));
      setCutoverHour(String(bd.cutover_hour));

      const inv = getInventorySetting(byKey.get('inventory'));
      setLowStockThreshold(String(inv.low_stock_threshold));

      const pw = getPeakWindowsSetting(byKey.get('peak_windows'));
      setPeakWindows(pw.windows.map((w) => ({ ...w })));

      const disp = getDisplaySetting(byKey.get('display'));
      setCafeName(disp.cafe_name ?? '');
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingSettings(false);
    }
  }, [claim?.tenant_id]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  // ─── Generic upsert helper ──────────────────────────────────────────────

  async function upsertSetting(key: SettingsKey, value: unknown): Promise<void> {
    const supabase = getBrowserClient();
    const { error: err } = await supabase.from('settings').upsert(
      {
        tenant_id: claim?.tenant_id,
        key,
        value,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'tenant_id,key' },
    );
    if (err) throw err;
  }

  function flashSaved(
    setSaved: React.Dispatch<React.SetStateAction<boolean>>,
  ) {
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  // ─── Save handlers ──────────────────────────────────────────────────────

  async function saveBusinessDay() {
    setCutoverError(null);
    const raw = parseInt(cutoverHour, 10);
    if (isNaN(raw) || !Number.isInteger(raw)) {
      setCutoverError(t('settings.validation.cutoverHourInteger'));
      return;
    }
    const err = validateSettings('business_day', { cutover_hour: raw });
    if (err) {
      setCutoverError(t('settings.validation.cutoverHourRange'));
      return;
    }
    setCutoverSaving(true);
    try {
      await upsertSetting('business_day', { cutover_hour: raw });
      flashSaved(setCutoverSaved);
    } catch (e) {
      setCutoverError(e instanceof Error ? e.message : String(e));
    } finally {
      setCutoverSaving(false);
    }
  }

  async function saveInventory() {
    setInventoryError(null);
    const raw = parseInt(lowStockThreshold, 10);
    if (isNaN(raw) || !Number.isInteger(raw)) {
      setInventoryError(t('settings.validation.lowStockInteger'));
      return;
    }
    const err = validateSettings('inventory', { low_stock_threshold: raw });
    if (err) {
      setInventoryError(t('settings.validation.lowStockNonNegative'));
      return;
    }
    setInventorySaving(true);
    try {
      await upsertSetting('inventory', { low_stock_threshold: raw });
      flashSaved(setInventorySaved);
    } catch (e) {
      setInventoryError(e instanceof Error ? e.message : String(e));
    } finally {
      setInventorySaving(false);
    }
  }

  async function savePeakWindows() {
    setPeakError(null);
    const err = validateSettings('peak_windows', { windows: peakWindows });
    if (err) {
      setPeakError(t('settings.validation.peakTimeFormat'));
      return;
    }
    setPeakSaving(true);
    try {
      await upsertSetting('peak_windows', { windows: peakWindows });
      flashSaved(setPeakSaved);
    } catch (e) {
      setPeakError(e instanceof Error ? e.message : String(e));
    } finally {
      setPeakSaving(false);
    }
  }

  async function saveDisplay() {
    setDisplayError(null);
    const value: Record<string, string> = {};
    if (cafeName.trim()) value['cafe_name'] = cafeName.trim();
    const err = validateSettings('display', value);
    if (err) {
      setDisplayError(err);
      return;
    }
    setDisplaySaving(true);
    try {
      await upsertSetting('display', value);
      flashSaved(setDisplaySaved);
    } catch (e) {
      setDisplayError(e instanceof Error ? e.message : String(e));
    } finally {
      setDisplaySaving(false);
    }
  }

  // ─── Peak window helpers ────────────────────────────────────────────────

  function addPeakWindow() {
    setPeakWindows((prev) => [...prev, { start: '18:00', end: '02:00' }]);
  }

  function removePeakWindow(idx: number) {
    setPeakWindows((prev) => prev.filter((_, i) => i !== idx));
  }

  function updatePeakWindow(idx: number, field: 'start' | 'end', value: string) {
    setPeakWindows((prev) =>
      prev.map((w, i) => (i === idx ? { ...w, [field]: value } : w)),
    );
  }

  // ─── Input class ─────────────────────────────────────────────────────────

  const inputClass =
    'w-full h-[52px] px-sm rounded-sm text-label text-text bg-surface-3 border border-border ' +
    'transition-colors duration-fast focus:outline-none focus:ring-2 focus:ring-primary focus:border-border-strong';

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-2xl">
      {/* Page header */}
      <div>
        <h1 className="text-h1 text-text">{t('settings.title')}</h1>
        <p className="text-label text-text-muted mt-xs">{t('settings.subtitle')}</p>
      </div>

      {/* Load error */}
      {loadError && <ErrorState message={loadError} onRetry={loadSettings} />}

      {/* Loading skeleton */}
      {loadingSettings && !loadError && (
        <div className="space-y-lg" aria-busy="true" aria-label={t('state.loading')}>
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-32 rounded-md bg-surface-2 animate-pulse" />
          ))}
        </div>
      )}

      {/* Sections — shown once loaded */}
      {!loadingSettings && !loadError && (
        <div className="space-y-xl">

          {/* ── business_day ── */}
          <SectionCard
            title={t('settings.section.businessDay')}
            description={t('settings.section.businessDayDesc')}
          >
            <div className="space-y-xs">
              <label htmlFor="cutover-hour" className="text-label text-text">
                {t('settings.field.cutoverHour')}
              </label>
              <input
                id="cutover-hour"
                type="number"
                min={0}
                max={23}
                step={1}
                value={cutoverHour}
                onChange={(e) => setCutoverHour(e.target.value)}
                className={inputClass}
                dir="ltr"
              />
              <p className="text-caption text-text-faint">{t('settings.field.cutoverHourHelper')}</p>
              {cutoverError && (
                <p role="alert" className="text-caption text-danger">{cutoverError}</p>
              )}
            </div>
            <div className="flex items-center gap-sm">
              <Button
                variant="primary"
                onClick={() => void saveBusinessDay()}
                loading={cutoverSaving}
                className="h-9 px-md"
              >
                {cutoverSaving ? t('settings.action.saving') : t('settings.action.save')}
              </Button>
              {cutoverSaved && (
                <span className="text-label text-success" role="status">
                  {toArabicDigits(t('settings.action.saved'))}
                </span>
              )}
            </div>
          </SectionCard>

          {/* ── inventory ── */}
          <SectionCard
            title={t('settings.section.inventory')}
            description={t('settings.section.inventoryDesc')}
          >
            <div className="space-y-xs">
              <label htmlFor="low-stock" className="text-label text-text">
                {t('settings.field.lowStockThreshold')}
              </label>
              <input
                id="low-stock"
                type="number"
                min={0}
                step={1}
                value={lowStockThreshold}
                onChange={(e) => setLowStockThreshold(e.target.value)}
                className={inputClass}
                dir="ltr"
              />
              <p className="text-caption text-text-faint">
                {t('settings.field.lowStockThresholdHelper')}
              </p>
              {inventoryError && (
                <p role="alert" className="text-caption text-danger">{inventoryError}</p>
              )}
            </div>
            <div className="flex items-center gap-sm">
              <Button
                variant="primary"
                onClick={() => void saveInventory()}
                loading={inventorySaving}
                className="h-9 px-md"
              >
                {inventorySaving ? t('settings.action.saving') : t('settings.action.save')}
              </Button>
              {inventorySaved && (
                <span className="text-label text-success" role="status">
                  {t('settings.action.saved')}
                </span>
              )}
            </div>
          </SectionCard>

          {/* ── peak_windows ── */}
          <SectionCard
            title={t('settings.section.peakWindows')}
            description={t('settings.section.peakWindowsDesc')}
          >
            <div className="space-y-sm">
              {peakWindows.map((w, idx) => (
                <div key={idx} className="flex flex-wrap items-end gap-sm">
                  {/* Start */}
                  <div className="flex-1 min-w-[120px] space-y-xs">
                    <label htmlFor={`peak-start-${idx}`} className="text-caption text-text-muted">
                      {t('settings.field.peakStart')}
                    </label>
                    <input
                      id={`peak-start-${idx}`}
                      type="time"
                      value={w.start}
                      onChange={(e) => updatePeakWindow(idx, 'start', e.target.value)}
                      className={inputClass}
                      dir="ltr"
                    />
                  </div>
                  {/* End */}
                  <div className="flex-1 min-w-[120px] space-y-xs">
                    <label htmlFor={`peak-end-${idx}`} className="text-caption text-text-muted">
                      {t('settings.field.peakEnd')}
                    </label>
                    <input
                      id={`peak-end-${idx}`}
                      type="time"
                      value={w.end}
                      onChange={(e) => updatePeakWindow(idx, 'end', e.target.value)}
                      className={inputClass}
                      dir="ltr"
                    />
                  </div>
                  {/* Remove */}
                  <Button
                    type="button"
                    variant="danger"
                    onClick={() => removePeakWindow(idx)}
                    aria-label={`${t('settings.action.removePeakWindow')} ${toArabicDigits(String(idx + 1))}`}
                    className="h-9 px-sm flex-shrink-0"
                  >
                    {t('settings.action.removePeakWindow')}
                  </Button>
                </div>
              ))}

              <Button
                type="button"
                variant="secondary"
                onClick={addPeakWindow}
                className="h-9 px-md"
              >
                <svg
                  aria-hidden="true"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                {t('settings.action.addPeakWindow')}
              </Button>
            </div>

            {peakError && (
              <p role="alert" className="text-caption text-danger">{peakError}</p>
            )}
            <div className="flex items-center gap-sm">
              <Button
                variant="primary"
                onClick={() => void savePeakWindows()}
                loading={peakSaving}
                className="h-9 px-md"
              >
                {peakSaving ? t('settings.action.saving') : t('settings.action.save')}
              </Button>
              {peakSaved && (
                <span className="text-label text-success" role="status">
                  {t('settings.action.saved')}
                </span>
              )}
            </div>
          </SectionCard>

          {/* ── display ── */}
          <SectionCard
            title={t('settings.section.display')}
          >
            <div className="space-y-xs">
              <label htmlFor="cafe-name" className="text-label text-text">
                {t('settings.field.cafeName')}
              </label>
              <input
                id="cafe-name"
                type="text"
                value={cafeName}
                onChange={(e) => setCafeName(e.target.value)}
                className={inputClass}
              />
              <p className="text-caption text-text-faint">{t('settings.field.cafeNameHelper')}</p>
              {displayError && (
                <p role="alert" className="text-caption text-danger">{displayError}</p>
              )}
            </div>
            <div className="flex items-center gap-sm">
              <Button
                variant="primary"
                onClick={() => void saveDisplay()}
                loading={displaySaving}
                className="h-9 px-md"
              >
                {displaySaving ? t('settings.action.saving') : t('settings.action.save')}
              </Button>
              {displaySaved && (
                <span className="text-label text-success" role="status">
                  {t('settings.action.saved')}
                </span>
              )}
            </div>
          </SectionCard>

        </div>
      )}
    </div>
  );
}
