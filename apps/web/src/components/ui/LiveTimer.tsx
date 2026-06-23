'use client';

/**
 * LiveTimer — design-system §9.10
 *
 * HARD RULE (CLAUDE.md §2.2): timers derive from `startedAt` (UTC ISO) and
 * recompute from the real clock each render. A tick hook only forces re-render —
 * it is NEVER the source of the elapsed value. Background/foreground/network
 * loss therefore never corrupts a displayed time.
 *
 * When `endedAt` is set the timer is frozen (closed session).
 */
import { useEffect, useState } from 'react';
import { elapsedSeconds, formatClock } from '@ps/core';
import { toArabicDigits } from '@ps/core';

interface LiveTimerProps {
  startedAt: string;
  endedAt?: string | null;
  /** Re-render interval in ms. 1000 for detail view, 15000–30000 for grid. */
  tickMs?: number;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const SIZE_CLASSES: Record<NonNullable<LiveTimerProps['size']>, string> = {
  sm: 'text-label font-mono tabular-nums',
  md: 'text-h3 font-mono tabular-nums',
  lg: 'text-timer font-mono tabular-nums',
};

export function LiveTimer({
  startedAt,
  endedAt,
  tickMs = 15000,
  size = 'md',
  className = '',
}: LiveTimerProps) {
  const [, setTick] = useState(0);

  // Tick causes re-render; value is always recomputed from startedAt/endedAt.
  useEffect(() => {
    if (endedAt) return; // Frozen — no tick needed
    const interval = setInterval(() => setTick((t) => t + 1), tickMs);
    return () => clearInterval(interval);
  }, [endedAt, tickMs]);

  const secs = elapsedSeconds(startedAt, endedAt ?? undefined);
  const clock = formatClock(secs);
  // Display Arabic-Indic digits per design-system §6
  const display = toArabicDigits(clock);

  // Accessibility: read elapsed in numeric form (not raw glyphs)
  const accessibleLabel = `${Math.floor(secs / 3600)}:${String(Math.floor((secs % 3600) / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;

  return (
    <time
      dateTime={`PT${secs}S`}
      aria-label={accessibleLabel}
      // Clock is NOT directional — do not mirror in RTL (design-system §6)
      dir="ltr"
      className={`${SIZE_CLASSES[size]} ${className}`}
    >
      {display}
    </time>
  );
}
