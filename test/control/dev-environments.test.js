// ASS-431: project.json's dev-environments — { mode, workstations } — says
// whether a project's tickets run in VMs (vm, the default), on GCP
// workstations (workstation) or both (vm+workstation), and lists its
// workstations. src/control/dev-environments.js reads it for control and the
// dashboard: the defaults, every refusal naming its field, the gcloud-config's
// ~ expanded; loadState and the dashboard's loadProjects carry it, and
// control logs a wrong one once. A project without it is as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { devEnvironments, devEnvironmentsErrors, projectDevEnvironments, usesVms, usesWorkstations, workstationOf, MODES } from '../../src/control/dev-environments.js';
import { paths, loadState } from '../../src/control/state.js';
import { loadProjects } from '../../src/tui/load.js';
import { runSteps } from '../../src/control/steps.js';
import { fixture } from '../agent-cli/harness-fixture.js';
import { controlFixture } from './control-fixture.js';

const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };
const env = { HOME: '/home/me' };
// The operator's workstation, as a workstation guide gives it.
const mine = { id: 'ada-dev', 'gcp-project': 'example-gcp-project', region: 'us-central1', cluster: 'example-workstations', config: 'example-config' };
const project = d => ({ name: 'P', 'execution-state-engine': 'example-development', 'dev-environments': d });

test('ASS-431 AC1: without dev-environments, or without its mode, a project runs in VMs with no workstations', () => {
  assert.deepEqual(devEnvironments({ name: 'P' }, env), { mode: 'vm', workstations: [] });
  assert.deepEqual(devEnvironments(project({}), env), { mode: 'vm', workstations: [] });
  assert.deepEqual(devEnvironments(project({ workstations: [mine] }), env), { mode: 'vm', workstations: [mine] });   // listed, kept for later
  assert.deepEqual(devEnvironmentsErrors({ name: 'P' }), []);
  assert.deepEqual(MODES, ['vm', 'vm+workstation', 'workstation']);
});

test('ASS-431 AC1: each mode is read with its workstations; gcloud-config\'s leading ~ or $HOME is expanded, an absolute one kept', () => {
  for (const mode of ['vm+workstation', 'workstation']) assert.deepEqual(devEnvironments(project({ mode, workstations: [mine] }), env), { mode, workstations: [mine] });
  const read = folder => devEnvironments(project({ mode: 'workstation', workstations: [{ ...mine, 'gcloud-config': folder }] }), env).workstations[0]['gcloud-config'];
  assert.equal(read('~/.config/example/gcloud'), '/home/me/.config/example/gcloud');
  assert.equal(read('$HOME/.config/example/gcloud'), '/home/me/.config/example/gcloud');
  assert.equal(read('${HOME}/.config/example/gcloud'), '/home/me/.config/example/gcloud');
  assert.equal(read('/opt/gcloud'), '/opt/gcloud');
  assert.equal(read('~'), '/home/me');
  const extra = devEnvironments(project({ mode: 'workstation', workstations: [{ ...mine, note: 'x' }] }), env).workstations[0];
  assert.deepEqual(extra, mine);   // only the known fields
});

test('ASS-431 AC2: an unknown mode, or a workstation mode with no workstations, is refused naming the field', () => {
  assert.deepEqual(devEnvironmentsErrors(project({ mode: 'cloud', workstations: [mine] })), ['dev-environments.mode "cloud" is not one of vm, vm+workstation, workstation']);
  assert.deepEqual(devEnvironmentsErrors(project({ mode: 'workstation' })), ['dev-environments.workstations is missing: mode workstation needs at least one workstation']);
  assert.deepEqual(devEnvironmentsErrors(project({ mode: 'vm+workstation', workstations: [] })), ['dev-environments.workstations is empty: mode vm+workstation needs at least one workstation']);
  assert.deepEqual(devEnvironmentsErrors(project({ mode: 'workstation', workstations: mine })), ['dev-environments.workstations is not a list']);
  assert.deepEqual(devEnvironmentsErrors(project('workstation')), ['dev-environments is not an object']);
  assert.deepEqual(devEnvironmentsErrors(project({ mode: 'vm', workstations: [] })), []);   // vm needs none
});

test('ASS-431 AC2: a workstation missing a field, or with a bad one, is refused naming it', () => {
  for (const field of ['id', 'gcp-project', 'region', 'cluster', 'config']) {
    const { [field]: _, ...missing } = { ...mine, id: 'other' };
    assert.deepEqual(devEnvironmentsErrors(project({ mode: 'workstation', workstations: [mine, missing] })), [`dev-environments.workstations[1].${field} is missing`]);
  }
  assert.deepEqual(devEnvironmentsErrors(project({ mode: 'workstation', workstations: [{ ...mine, region: '' }] })), ['dev-environments.workstations[0].region is not a non-empty string']);
  assert.deepEqual(devEnvironmentsErrors(project({ mode: 'workstation', workstations: ['ada-dev'] })), ['dev-environments.workstations[0] is not an object']);
  assert.deepEqual(devEnvironmentsErrors(project({ mode: 'workstation', workstations: [{ ...mine, id: 'a/b' }] })), ['dev-environments.workstations[0].id "a/b" has a character other than A-Z, a-z, 0-9, _ and -']);
  assert.deepEqual(devEnvironmentsErrors(project({ mode: 'workstation', workstations: [{ ...mine, 'gcloud-config': 'gcloud' }] })), ['dev-environments.workstations[0].gcloud-config is not a folder starting with /, ~ or $HOME']);
  assert.deepEqual(devEnvironmentsErrors(project({ mode: 'vm', workstations: [{ id: 'x' }] })).length, 4);   // checked in vm mode too
});

test('ASS-431 AC2: two workstations with the same id are refused naming the second', () => {
  assert.deepEqual(devEnvironmentsErrors(project({ mode: 'workstation', workstations: [mine, { ...mine, region: 'europe-west1' }] })),
    ['dev-environments.workstations[1].id "ada-dev" is used by an earlier workstation too']);
});

test('ASS-431 AC2, AC3: devEnvironments refuses a wrong dev-environments, naming every bad field; projectDevEnvironments reads a project\'s, refusing an unknown project', () => {
  assert.throws(() => devEnvironments(project({ mode: 'cloud', workstations: [{ id: 'x' }] }), env),
    /^Error: project\.json: dev-environments\.mode "cloud" is not one of vm, vm\+workstation, workstation; dev-environments\.workstations\[0\]\.gcp-project is missing; /);
  const dir = mkdtempSync(join(tmpdir(), 'dev-environments-'));
  mkdirSync(join(dir, 'p'));
  writeFileSync(join(dir, 'p', 'project.json'), JSON.stringify(project({ mode: 'workstation', workstations: [{ ...mine, 'gcloud-config': '~/.config/example/gcloud' }] })));
  const settings = projectDevEnvironments(dir, 'p', env);
  assert.deepEqual(settings, { mode: 'workstation', workstations: [{ ...mine, 'gcloud-config': '/home/me/.config/example/gcloud' }] });
  assert.equal(workstationOf(settings, 'ada-dev').region, 'us-central1');
  assert.equal(workstationOf(settings, 'nope'), undefined);
  assert.throws(() => projectDevEnvironments(dir, 'q', env), /no project q/);
  assert.throws(() => projectDevEnvironments(dir, '../p', env), /no project/);
});

test('ASS-431 AC3: usesVms and usesWorkstations say which places a mode runs tickets in', () => {
  assert.deepEqual(MODES.map(m => [usesVms(m), usesWorkstations(m)]), [[true, false], [true, true], [false, true]]);
});

test('ASS-431 AC2, AC3: loadState and the dashboard\'s loadProjects carry each project\'s dev-environments; a wrong one is null, its errors kept; one without is vm', () => {
  const f = fixture();
  edit(join(f.dir, 'projects', 'p', 'project.json'), j => { j['dev-environments'] = { mode: 'vm+workstation', workstations: [mine] }; });
  edit(join(f.dir, 'projects', 'q', 'project.json'), j => { j['dev-environments'] = { mode: 'workstation' }; });
  const [p, q] = loadState(paths('/repo', f.env)).projects;
  assert.deepEqual([p.devEnvironments, p.devEnvironmentsErrors], [{ mode: 'vm+workstation', workstations: [mine] }, []]);
  assert.deepEqual([q.devEnvironments, q.devEnvironmentsErrors], [null, ['dev-environments.workstations is missing: mode workstation needs at least one workstation']]);
  const shown = Object.fromEntries(loadProjects(join(f.dir, 'projects'), join(f.dir, 'lima')).map(x => [x.id, x.devEnvironments]));
  assert.deepEqual(shown, { p: { mode: 'vm+workstation', workstations: [mine] }, q: null });
  edit(join(f.dir, 'projects', 'p', 'project.json'), j => { delete j['dev-environments']; });
  assert.deepEqual(loadState(paths('/repo', f.env)).projects[0].devEnvironments, { mode: 'vm', workstations: [] });
});

test('ASS-431 AC2: control logs a wrong dev-environments once, naming the field', async () => {
  const f = controlFixture();
  edit(join(f.dir, 'projects', 'p', 'project.json'), j => { j['dev-environments'] = { mode: 'gcp', workstations: [mine, mine] }; });
  await runSteps(f.ctx, f.ctx.load());
  await runSteps(f.ctx, f.ctx.load());
  assert.deepEqual(f.lines.filter(l => /dev-environments/.test(l)), [
    'error project p: dev-environments.mode "gcp" is not one of vm, vm+workstation, workstation',
    'error project p: dev-environments.workstations[1].id "ada-dev" is used by an earlier workstation too',
  ]);
});
