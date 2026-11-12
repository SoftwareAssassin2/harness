// The commit a control runs (ASS-393): control loads the harness's code once,
// when it starts, so a harness fix that lands later is not in it until a
// restart. On start, control records `git rev-parse HEAD` of the checkout it
// runs from in the data folder — data/control-commit-<project> for a
// project's control, data/control-commit for one without --project (beside
// the projects folder, so PROJECTS_DIR moves it too) — and ticket:fix-landed
// reads it: a harness fix is landed only once its commits are ancestors of
// it. A checkout git cannot read records nothing, any earlier record removed,
// so no stale commit is ever read as the running one.
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// controlCommitFile(paths, project) — where the control of `project` (null: one for every project) records it.
export const controlCommitFile = (paths, project) => join(dirname(paths.projects), project ? `control-commit-${project}` : 'control-commit');

// recordControlCommit(root, paths, project) — records the commit of the checkout at `root`; its hash, or null when it cannot be read.
export function recordControlCommit(root, paths, project) {
  const file = controlCommitFile(paths, project);
  const out = spawnSync('git', ['-C', root, 'rev-parse', '--verify', 'HEAD^{commit}'], { encoding: 'utf8' });
  const commit = out.status === 0 ? out.stdout.trim() : '';
  try {
    if (/^[0-9a-f]{40,64}$/.test(commit)) { writeFileSync(file, `${commit}\n`); return commit; }
    rmSync(file, { force: true });
  } catch { /* no data folder: nothing recorded */ }
  return null;
}
