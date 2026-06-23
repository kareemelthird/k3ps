'use client';

/**
 * LiveCost — live running cost for an active open-meter session.
 *
 * HARD RULES (CLAUDE.md §2.1, §2.2):
 *   - Cost is computed via @ps/core `openMeterCostPiastres` (integer piastres).
 *   - We never re-derive money inline (no float math, no `minutes/60 * rate`).
 *   - The tick only forces a re-render; the actual cost is always recomputed
 *     fresh from `startedAt` and the current wall-clock instant. A backgrounded
 *     tab or dropped network CANNOT corrupt the displayed cost.
 *   - Money is not directional — the `<span>` carries `dir="ltr"` so Arabic
 *     numerals still render left-to-right inside the RTL layout (design-system §6).
 */
import { useEffect, useState } from 'react';
import { openMeterCostPiastres, formatEgp, nowIso } from '@ps/core';
import type { OpenMeterOptions } from '@ps/core';

interface LiveCostProps {
  /** UTC ISO start of the active session segment. */
  startedAt: string;
  /** Rate in integer piastres per hour (price_per_hour_snapshot). */
  ratePerHourPiastres: number;
  /** Re-render interval in ms. Match LiveTimer — default 15 000. */
  tickMs?: number;
  /** Optional rounding/min-charge — defaults to "no rounding" (raw minutes). */
  opts?: OpenMeterOptions;
  className?: string;
}

export function LiveCost({
  startedAt,
  ratePerHourPiastres,
  tickMs = 15000,
  opts,
  className = '',
}: LiveCostProps) {
  // `now` stays null on the server AND the first client render, so the SSR HTML
  // and the initial hydration match exactly (no hydration mismatch). The current
  // instant is only read AFTER mount, in the effect — never during render.
  const [now, setNow] = useState<string | null>(null);

  useEffect(() => {
    setNow(nowIso()); // first live value, post-mount
    const interval = setInterval(() => setNow(nowIso()), tickMs);
    return () => clearInterval(interval);
  }, [tickMs]);

  // Cost is always re-derived from startedAt + an explicit instant (pure/testable).
  // Before mount we render a stable placeholder identical on server and client.
  const display =
    now === null
      ? '—'
      : formatEgp(openMeterCostPiastres(startedAt, now, ratePerHourPiastres, opts));

  return (
    <span
      className={`tabular-nums text-primary font-medium ${className}`.trim()}
      // Money is not directional: Arabic-Indic numerals render LTR within RTL layout.
      dir="ltr"
      aria-live="polite"
      aria-atomic="true"
    >
      {display}
    </span>
  );
}
