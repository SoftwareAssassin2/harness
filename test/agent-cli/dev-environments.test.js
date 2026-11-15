// ASS-431 AC3: dev-environments.bash reads a project's dev-environments for
// the bash commands, as src/control/dev-environments.js does for control (it
// runs that): the mode (vm when unset), the workstations one JSON line each,
// one by id with its gcloud-config's ~ expanded; each refusing, naming the
// command, the project and the field, a wrong one or an unknown project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const HELPER = join(import.meta.dirname, '..', '..', 'src', 'agent-cli', 'dev-environments.bash');
const mine = { id: 'ada-dev', 'gcp-project': 'example-gcp-project', region: 'us-central1', cluster: 'example-workstations', config: 'example-config' };

// projects({ <project>: <dev-environments, or undefined for none> }) — a PROJECTS_DIR with each project.json.
function projects(each) {
  const dir = mkdtempSync(join(tmpdir(), 'dev-environments-'));
  for (const [id, d] of Object.entries(each)) {
    mkdirSync(join(dir, id));
    writeFileSync(join(dir, id, 'project.json'), JSON.stringify({ name: id, ...(d === undefined ? {} : { 'dev-environments': d }) }));
  }
  return dir;
}
const ask = (dir, script) => run('bash', ['-c', `set -euo pipefail; source "${HELPER}" && ${script}`], { env: { ...process.env, PROJECTS_DIR: dir, HOME: '/home/me' } });
const refusal = (dir, script) => ask(dir, script).then(() => assert.fail('not refused'), e => e.stderr);

test('ASS-431 AC3: a project without dev-environments is vm, with no workstations', async () => {
  const dir = projects({ p: undefined });
  assert.equal((await ask(dir, 'dev_environments_mode cmd p')).stdout, 'vm\n');
  assert.equal((await ask(dir, 'dev_environments_workstations cmd p')).stdout, '');
  assert.equal((await ask(dir, 'dev_environments cmd p')).stdout, '{"mode":"vm","workstations":[]}\n');
});

test('ASS-431 AC3: the mode, each workstation as one JSON line, and one by id with gcloud-config expanded', async () => {
  const other = { ...mine, id: 'ws-2', region: 'europe-west1' };
  const dir = projects({ p: { mode: 'vm+workstation', workstations: [{ ...mine, 'gcloud-config': '~/.config/example/gcloud' }, other] } });
  const expanded = { ...mine, 'gcloud-config': '/home/me/.config/example/gcloud' };
  assert.equal((await ask(dir, 'dev_environments_mode cmd p')).stdout, 'vm+workstation\n');
  assert.deepEqual((await ask(dir, 'dev_environments_workstations cmd p')).stdout.trim().split('\n').map(l => JSON.parse(l)), [expanded, other]);
  assert.deepEqual(JSON.parse((await ask(dir, 'dev_environments_workstation cmd p ada-dev')).stdout), expanded);
  assert.equal(await refusal(dir, 'dev_environments_workstation cmd p nope'), "cmd: project p has no workstation 'nope' in its dev-environments\n");
});

test('ASS-431 AC2, AC3: a wrong dev-environments, or an unknown project, is refused naming the command, the project and the field', async () => {
  const dir = projects({ p: { mode: 'workstation', workstations: [] }, q: { mode: 'cloud' }, r: { mode: 'workstation', workstations: [mine, mine] } });
  assert.equal(await refusal(dir, 'dev_environments_mode cmd p'), 'cmd: project p: project.json: dev-environments.workstations is empty: mode workstation needs at least one workstation\n');
  assert.equal(await refusal(dir, 'dev_environments_mode cmd q'), 'cmd: project q: project.json: dev-environments.mode "cloud" is not one of vm, vm+workstation, workstation\n');
  assert.equal(await refusal(dir, 'dev_environments_workstations cmd r'), 'cmd: project r: project.json: dev-environments.workstations[1].id "ada-dev" is used by an earlier workstation too\n');
  assert.equal(await refusal(dir, 'dev_environments_mode cmd nope'), 'cmd: project nope: no project nope\n');
});
