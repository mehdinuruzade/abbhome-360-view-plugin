import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stringifyCompact } from '../src/core/json';
import { buildDemoConfig } from './demo-config';

const out = fileURLToPath(new URL('../public/demo/building.json', import.meta.url));
const config = buildDemoConfig();
writeFileSync(out, stringifyCompact(config));
console.log(
  `Wrote ${out}: ${config.apartments.length} apartments, ${config.regions.length} regions, ` +
    `${config.dimensions.width} × ${config.dimensions.depth} × ${config.dimensions.height} m`,
);
