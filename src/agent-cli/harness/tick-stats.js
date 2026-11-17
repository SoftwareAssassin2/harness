// ASS-490: harness:tick-stats's printing (see tick-stats.sh) — node tick-stats.js <projects> <home> [<project>].
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatTickStats } from '../../control/tick-stats.js';

const [projects, home, named] = process.argv.slice(2);
const read = file => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return null;
    console.error(`harness:tick-stats: ${file}: ${error.message}`);
    process.exitCode = 1;
    return undefined;
  }
};
const ids = named ? [named] : (existsSync(projects) ? readdirSync(projects).toSorted().filter(id => existsSync(join(projects, id, 'project.json'))) : []);
const out = [];
for (const id of ids) {
  const stats = read(join(projects, id, 'tick-stats.json'));
  if (stats !== undefined) out.push(formatTickStats(id, stats));
}
if (!named) {
  const stats = read(join(home, 'tick-stats.json'));
  if (stats) out.push(formatTickStats('all projects (a control with no --project)', stats));
}
process.stdout.write(out.length ? out.join('\n') : 'No project, and no control has recorded any tick times yet.\n');
