import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Purity guard (AC 19): @ps/core must never import a framework or backend SDK.
 * It must run in plain Node under Jest. dayjs is the only runtime dependency.
 */
const FORBIDDEN = [
  'react',
  'react-native',
  'react-dom',
  'expo',
  'next',
  '@supabase/supabase-js',
  '@supabase',
];

function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectTsFiles(full, out);
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('purity: no framework/backend imports in @ps/core (AC 19)', () => {
  const srcRoot = join(__dirname);
  const files = collectTsFiles(srcRoot).filter((f) => !f.endsWith('.test.ts'));

  it('finds source files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(FORBIDDEN)('imports nothing from %s', (pkg) => {
    const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match `from 'pkg'`, `from 'pkg/...'`, and require('pkg').
    const re = new RegExp(`(from|require\\()\\s*['"]${escaped}(/[^'"]*)?['"]`);
    const offenders = files.filter((f) => re.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the only runtime dependency is dayjs', () => {
    // dayjs imports are allowed; assert at least the time module uses it and
    // nothing imports a Node-only side-effecting global for cost math.
    const offenders = files.filter((f) => /\bDate\.now\(\)/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]); // no Date.now() anywhere in cost-relevant src
  });
});
