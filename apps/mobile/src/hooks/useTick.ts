/**
 * useTick — forces a re-render on the given interval.
 *
 * IMPORTANT: this hook is ONLY for triggering re-renders.
 * It is NEVER the source of elapsed time or billing values.
 * All elapsed values must be computed from stored `started_at` via
 * @ps/core `elapsedSeconds` / `formatClock`. (CLAUDE.md §2.2)
 *
 * Pass `null` to disable ticking (for off-screen/closed sessions).
 */
import { useEffect, useState } from 'react';

export function useTick(intervalMs: number | null): void {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (intervalMs === null) return;
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}
