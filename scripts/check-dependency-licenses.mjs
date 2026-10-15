// Gate declared production licenses; this is an inventory check, not a legal opinion.
import { execFileSync } from 'node:child_process';

const allowed = new Set([
  'MIT', 'MIT-0', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD',
  '(Apache-2.0 AND BSD-3-Clause)', 'CC-BY-4.0', 'MPL-2.0',
]);
const inventory = JSON.parse(execFileSync('pnpm', ['--dir', 'apps/web', 'licenses', 'list', '--prod', '--json'], {
  encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
}));
if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory)) throw new Error('Invalid license inventory');
let count = 0;
const unreviewed = [];
for (const [license, packages] of Object.entries(inventory)) {
  if (!Array.isArray(packages) || packages.length === 0) throw new Error('Invalid package group');
  for (const entry of packages) {
    if (!entry || typeof entry.name !== 'string' || !Array.isArray(entry.versions) || entry.versions.some((v) => typeof v !== 'string')) {
      throw new Error('Incomplete package license metadata');
    }
    count++;
    if (!allowed.has(license)) unreviewed.push(`${entry.name}: ${license}`);
  }
}
// Running at the workspace root can return {}, silently skipping every app dependency.
if (count === 0) throw new Error('Production license inventory is empty');
if (unreviewed.length) {
  console.error('New or missing licenses require review:\n' + unreviewed.sort().join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Declared production licenses checked: ${count} package entries across ${Object.keys(inventory).length} license groups.`);
}
