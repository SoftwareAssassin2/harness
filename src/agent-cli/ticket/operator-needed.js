// ASS-506: ticket:operator-needed's work (see operator-needed.sh) —
// node operator-needed.js <projects> <assignments> <engines> [<project>].
import { existsSync } from 'node:fs';
import { operatorNeededReport } from '../../notify/operator-needed.js';

const [projects, assignments, engines, named] = process.argv.slice(2);
try {
  const report = operatorNeededReport({ projectsDir: projects, assignmentsFile: existsSync(assignments) ? assignments : null, enginesDir: engines, project: named });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  console.error(`ticket:operator-needed: ${error.message}`);
  process.exitCode = 1;
}
