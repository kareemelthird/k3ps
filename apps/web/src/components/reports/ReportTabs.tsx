'use client';

/**
 * ReportTabs — segmented tab switcher for the four report tables (design §7).
 * Pattern: SegmentedControl (design-system §9.4), role=radiogroup.
 * Tabs: by day / by device / by product / by shift
 * All strings via i18n. RTL layout.
 */

import { useTranslations } from 'next-intl';

export type ReportTab = 'byDay' | 'byDevice' | 'byProduct' | 'byShift';

interface ReportTabsProps {
  active: ReportTab;
  onChange: (tab: ReportTab) => void;
}

const TABS: ReportTab[] = ['byDay', 'byDevice', 'byProduct', 'byShift'];

export function ReportTabs({ active, onChange }: ReportTabsProps) {
  const t = useTranslations();

  return (
    <div
      role="radiogroup"
      aria-label={t('reports.title')}
      className="flex gap-2xs bg-surface-2 rounded-xs p-2xs"
    >
      {TABS.map((tab) => {
        const isActive = tab === active;
        return (
          <button
            key={tab}
            type="button"
            role="radio"
            aria-checked={isActive}
            onClick={() => onChange(tab)}
            className={`flex-1 h-9 px-sm rounded-xs text-label font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary
              ${isActive
                ? 'bg-surface text-primary shadow-e0'
                : 'text-text-muted hover:text-text'}`}
          >
            {t(`reports.tab.${tab}`)}
          </button>
        );
      })}
    </div>
  );
}
