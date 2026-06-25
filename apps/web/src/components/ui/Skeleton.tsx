'use client';

/**
 * Skeleton — design-system §9.9
 * Shimmer placeholder that reserves layout space (CLS < 0.1).
 * Shimmer disables under prefers-reduced-motion.
 */

interface SkeletonProps {
  className?: string;
  'aria-label'?: string;
  style?: React.CSSProperties;
}

export function Skeleton({ className = '', 'aria-label': ariaLabel, style }: SkeletonProps) {
  return (
    <div
      role="status"
      aria-label={ariaLabel ?? 'جارٍ التحميل'}
      aria-busy="true"
      style={style}
      className={`bg-surface-3 rounded-md animate-pulse motion-reduce:animate-none ${className}`}
    />
  );
}

export function DeviceCardSkeleton() {
  return (
    <div className="rounded-md bg-surface border border-border p-4 flex flex-col gap-3 min-h-[120px]">
      <Skeleton className="h-5 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-8 w-1/3 mt-auto" />
    </div>
  );
}

export function TableRowSkeleton({ cols = 5 }: { cols?: number }) {
  return (
    <tr aria-hidden="true">
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i} className="px-4 py-3">
          <Skeleton className="h-4 w-full" />
        </td>
      ))}
    </tr>
  );
}
