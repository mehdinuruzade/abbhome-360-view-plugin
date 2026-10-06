// Fails if the classic-script bundle grows past its budget (run after `npm run build`).
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const BUDGET_KB = 200;
const files = ['dist/lib/abb-building-360.iife.js', 'dist/lib/abb-building-360.js'];

let failed = false;
for (const file of files) {
  const raw = readFileSync(file);
  const gz = gzipSync(raw, { level: 9 }).length / 1024;
  const budgeted = file.endsWith('.iife.js');
  const over = budgeted && gz > BUDGET_KB;
  failed ||= over;
  console.log(
    `${over ? '✗' : '✓'} ${file}: ${(raw.length / 1024).toFixed(1)} kB, ${gz.toFixed(1)} kB gzipped` +
      (budgeted ? ` (budget ${BUDGET_KB} kB)` : ' (unminified ES build for bundlers; not budgeted)'),
  );
}
process.exit(failed ? 1 : 0);
