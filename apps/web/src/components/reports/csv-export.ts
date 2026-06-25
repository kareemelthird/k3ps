/**
 * CSV export utility for Phase 6 owner reports (ADR-0007 Decision 6).
 *
 * Contract (locked by ADR-0007 Q6):
 *   - UTF-8 with BOM (so Excel renders Arabic correctly)
 *   - RFC-4180 escaping (fields with , " or \n quoted; embedded quotes doubled)
 *   - Arabic text preserved
 *   - Money as decimal EGP via formatEgpPlain (Western digits, no thousands sep)
 *     — the ONLY place Arabic-Indic digits are intentionally NOT used (AC 21 exemption)
 *   - No audit row is written on export (ADR-0007 Decision 8 — default OFF)
 *
 * Pure client-side: runs from the already-fetched RPC rows (RLS-scoped on arrival).
 */
import { formatEgpPlain } from '@ps/core';

export { formatEgpPlain };

/** UTF-8 BOM for Excel Arabic compatibility */
const BOM = '﻿';

/**
 * Escape a single CSV cell value per RFC-4180.
 * Fields containing , " or newline are wrapped in double-quotes.
 * Embedded double-quotes are doubled ("").
 */
function csvCell(val: string): string {
  if (val.includes('"') || val.includes(',') || val.includes('\n') || val.includes('\r')) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

/**
 * Build a CSV string from headers + data rows.
 * Returns the BOM-prefixed UTF-8 CSV content ready for download.
 */
export function buildCsv(headers: string[], rows: string[][]): string {
  const lines: string[] = [
    headers.map(csvCell).join(','),
    ...rows.map((row) => row.map(csvCell).join(',')),
  ];
  return BOM + lines.join('\r\n');
}

/**
 * Trigger a browser file download.
 * `content` should be the BOM-prefixed CSV string from `buildCsv`.
 */
export function downloadCsv(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Format an integer piastre count as a plain decimal EGP string for CSV. */
export function moneyCell(piastres: number): string {
  return formatEgpPlain(piastres);
}

/** Format a plain number (count, percentage) as a Western-digit string for CSV. */
export function numCell(n: number): string {
  return String(n);
}
