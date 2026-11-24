// dev-environments.bash's reading of a project's dev-environments (ASS-431),
// in node to share control's devEnvironments rather than restate it in jq:
//
//   node dev-environments.js <projects folder> <project> [--run-targets]
//
// prints { mode, workstations } as one JSON line (src/control/
// dev-environments.js projectDevEnvironments: the defaults filled in, each
// gcloud-config's ~ expanded); exits 1, the reason on stderr, without the
// project or when its dev-environments is wrong (each bad field named).
// ASS-581: with --run-targets, the project's run targets instead, one per line
// (run-targets.js projectRunTargets: its own list, or as derived from its mode).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectDevEnvironments } from '../control/dev-environments.js';
import { projectRunTargets } from '../control/run-targets.js';

try {
  const settings = projectDevEnvironments(process.argv[2], process.argv[3]);
  if (process.argv[4] === '--run-targets') {
    const json = JSON.parse(readFileSync(join(process.argv[2], process.argv[3], 'project.json'), 'utf8'));
    process.stdout.write(`${projectRunTargets(json).targets.join('\n')}\n`);
  } else process.stdout.write(`${JSON.stringify(settings)}\n`);
} catch (e) {
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
}
