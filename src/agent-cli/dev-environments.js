// dev-environments.bash's reading of a project's dev-environments (ASS-431),
// in node to share control's devEnvironments rather than restate it in jq:
//
//   node dev-environments.js <projects folder> <project>
//
// prints { mode, workstations } as one JSON line (src/control/
// dev-environments.js projectDevEnvironments: the defaults filled in, each
// gcloud-config's ~ expanded); exits 1, the reason on stderr, without the
// project or when its dev-environments is wrong (each bad field named).
import { projectDevEnvironments } from '../control/dev-environments.js';

try {
  process.stdout.write(`${JSON.stringify(projectDevEnvironments(process.argv[2], process.argv[3]))}\n`);
} catch (e) {
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
}
