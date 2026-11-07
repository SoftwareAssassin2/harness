// ticket:set-merge-request-plan and ticket:merge-request-plan (ASS-80) —
// Write Execution Plan's planned merge requests, recorded on the variation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const APP = 'https://gitlab.com/g/app', LIB = 'https://gitlab.com/g/lib';

// A projects/ folder whose project p has repositories app and lib and sprint 10 active, ABC-5 with variations A and B.
function projects() {
  const dir = mkdtempSync(join(tmpdir(), 'mrp-'));
  mkdirSync(join(dir, 'p', 'sprints', 'sprint-10'), { recursive: true });
  writeFileSync(join(dir, 'p', 'project.json'), JSON.stringify({ repositories: [{ url: APP }, { url: LIB }] }));
  writeFileSync(join(dir, 'p', 'sprints.json'), JSON.stringify({ list: [{ number: 10, 'is-active': true }] }));
  writeFileSync(join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify({
    number: 10, bugs: [], spikes: [],
    features: [{ key: 'ABC-5', variations: [{ name: 'A', 'merge-request': [] }, { name: 'B' }] }],
  }, null, 4));
  return dir;
}
const sprintFile = dir => join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json');
const variation = (dir, name) => JSON.parse(readFileSync(sprintFile(dir), 'utf8')).features[0].variations.find(v => v.name === name);
const env = dir => ({ env: { ...process.env, PROJECTS_DIR: dir } });
const plan = (dir, name, entries, key = 'abc-5') => {
  const file = join(dir, `plan-${Math.random()}.json`);
  writeFileSync(file, typeof entries === 'string' ? entries : JSON.stringify(entries));
  return run(AGENT, ['ticket:set-merge-request-plan', 'p', key, name, file], env(dir));
};

test('ticket:set-merge-request-plan records each planned MR Not Created, its branch named by the harness', async () => {
  const dir = projects();
  const { stdout } = await plan(dir, 'A', [
    { id: 1, repository: LIB, contents: 'the parser', 'depends-on': [] },
    { id: 2, repository: APP, contents: 'the screen', 'depends-on': [1] },
  ]);
  const expected = [
    { id: 1, repository: LIB, branch: 'change/ABC-5-1', contents: 'the parser', 'depends-on': [], status: 'Not Created', key: null, url: null, 'build-status': null },
    { id: 2, repository: APP, branch: 'change/ABC-5-2', contents: 'the screen', 'depends-on': [1], status: 'Not Created', key: null, url: null, 'build-status': null },
  ];
  assert.deepEqual(variation(dir, 'A')['merge-request'], expected);
  assert.deepEqual(JSON.parse(stdout), expected);
  // Any variation but A carries its name in the branch; depends-on defaults to none.
  await plan(dir, 'B', [{ id: 1, repository: APP, contents: 'all of it' }]);
  assert.equal(variation(dir, 'B')['merge-request'][0].branch, 'change/ABC-5.B-1');
  assert.deepEqual(variation(dir, 'B')['merge-request'][0]['depends-on'], []);
});

test('ticket:set-merge-request-plan replans by id: a created MR keeps its key, url, build status and status; a dropped one stays', async () => {
  const dir = projects();
  await plan(dir, 'A', [{ id: 1, repository: LIB, contents: 'parser' }, { id: 2, repository: APP, contents: 'screen' }]);
  // Generate Solution (ASS-81) opens MR 1 and MR 2 merges.
  const file = sprintFile(dir), sprint = JSON.parse(readFileSync(file, 'utf8'));
  const [one, two] = sprint.features[0].variations[0]['merge-request'];
  Object.assign(one, { status: 'Open', key: '!7', url: 'https://gitlab.com/g/lib/-/merge_requests/7', 'build-status': 'Passed' });
  Object.assign(two, { status: 'Merged', key: '!8', url: 'u8', 'build-status': 'Merged' });
  writeFileSync(file, JSON.stringify(sprint));
  await plan(dir, 'A', [{ id: 1, repository: APP, contents: 'parser, moved', 'depends-on': [3] }, { id: 3, repository: LIB, contents: 'new' }]);
  assert.deepEqual(variation(dir, 'A')['merge-request'], [
    { id: 1, repository: APP, branch: 'change/ABC-5-1', contents: 'parser, moved', 'depends-on': [3], status: 'Open', key: '!7', url: 'https://gitlab.com/g/lib/-/merge_requests/7', 'build-status': 'Passed' },
    { ...two },
    { id: 3, repository: LIB, branch: 'change/ABC-5-3', contents: 'new', 'depends-on': [], status: 'Not Created', key: null, url: null, 'build-status': null },
  ]);
});

test('ticket:merge-request-plan prints the variation\'s merge requests, for Write Execution Plan to read before it replans', async () => {
  const dir = projects();
  assert.deepEqual(JSON.parse((await run(AGENT, ['ticket:merge-request-plan', 'p', 'ABC-5', 'B'], env(dir))).stdout), []);
  await plan(dir, 'B', [{ id: 1, repository: APP, contents: 'x' }]);
  const { stdout } = await run(AGENT, ['ticket:merge-request-plan', 'p', 'abc-5', 'B'], env(dir));
  assert.deepEqual(JSON.parse(stdout), variation(dir, 'B')['merge-request']);
  await assert.rejects(run(AGENT, ['ticket:merge-request-plan', 'p', 'ABC-5', 'Z'], env(dir)), /no ABC-5 variation Z/);
});

test('ticket:set-merge-request-plan fails, writing nothing, on a repository not the project\'s or a malformed plan', async () => {
  const dir = projects();
  const before = readFileSync(sprintFile(dir), 'utf8');
  await assert.rejects(plan(dir, 'A', [{ id: 1, repository: 'https://gitlab.com/g/other', contents: 'x' }]), /not one of p's repositories: https:\/\/gitlab.com\/g\/app, https:\/\/gitlab.com\/g\/lib/);
  for (const bad of [
    '{}', 'not json', '[]',
    [{ id: 0, repository: APP, contents: 'x' }],
    [{ id: 1.5, repository: APP, contents: 'x' }],
    [{ id: 1, repository: APP }],
    [{ id: 1, repository: APP, contents: 'x', 'depends-on': ['1'] }],
    [{ id: 1, repository: APP, contents: 'x' }, { id: 1, repository: LIB, contents: 'y' }],
  ]) await assert.rejects(plan(dir, 'A', bad), /must hold a non-empty array of \{ id, repository, contents, depends-on \}/);
  await assert.rejects(plan(dir, 'A', [{ id: 1, repository: APP, contents: 'x', 'depends-on': [2] }]), /depends on 2, which is not planned/);
  await assert.rejects(plan(dir, 'Z', [{ id: 1, repository: APP, contents: 'x' }]), /no ABC-5 variation Z/);
  await assert.rejects(run(AGENT, ['ticket:set-merge-request-plan', 'p', 'ABC-5', 'A'], env(dir)), /usage/);
  assert.equal(readFileSync(sprintFile(dir), 'utf8'), before);
});

test('ASS-151 AC2: a fast-tracked ticket (fast-track: true) may plan no merge request — [] is recorded as none, the step goes on — any other still may not', async () => {
  const dir = projects();
  await assert.rejects(plan(dir, 'A', '[]'), /must hold a non-empty array/);
  const sprint = JSON.parse(readFileSync(sprintFile(dir), 'utf8'));
  sprint.features[0]['fast-track'] = true;
  writeFileSync(sprintFile(dir), JSON.stringify(sprint, null, 4));
  const { stdout } = await plan(dir, 'A', '[]');
  assert.deepEqual(JSON.parse(stdout), []);
  assert.deepEqual(variation(dir, 'A')['merge-request'], []);
  await assert.rejects(plan(dir, 'A', '{}'), /must hold a non-empty array/, 'still an array');
});

// ASS-182 AC1: a VM's /mnt/ticket is read-only, so the plan comes on stdin, "-" in place of the file.
test('ASS-182 AC1: ticket:set-merge-request-plan p ABC-5 A - takes the plan on stdin, as from a file; an invalid one is refused, writing nothing', async () => {
  const dir = projects();
  const piped = (input, name = 'A') => new Promise((resolve, reject) => {
    const child = execFile(AGENT, ['ticket:set-merge-request-plan', 'p', 'abc-5', name, '-'], env(dir), (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr })) : resolve(stdout)));
    child.stdin.end(input);
  });
  await piped(JSON.stringify([{ id: 1, repository: APP, contents: 'all of it' }]));
  assert.deepEqual(variation(dir, 'A')['merge-request'].map(m => [m.id, m.branch, m.status]), [[1, 'change/ABC-5-1', 'Not Created']]);
  const before = readFileSync(sprintFile(dir), 'utf8');
  await assert.rejects(piped('nope'), e => /must hold a non-empty array/.test(e.stderr));
  assert.equal(readFileSync(sprintFile(dir), 'utf8'), before);
});
