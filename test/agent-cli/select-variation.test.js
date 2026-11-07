// ticket:select-variation — keeps one version of a ticket built several
// ways: the rest are soft deleted in the active sprint's sprint.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// A harness-status at `state` of the example-development engine.
const hs = state => ({ state, 'state-engine': 'example-development' });

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');

// A projects/ folder whose project p has sprint 10 active, with a spike built three ways.
const arrived = { 'from-state': 'docs', 'to-state': 'pick', timestamp: '2026-10-07T20:00:00Z', 'agent-dispatch-log': [], 'work-is-done': false };
function projects() {
  const dir = mkdtempSync(join(tmpdir(), 'sv-'));
  mkdirSync(join(dir, 'p', 'sprints', 'sprint-10'), { recursive: true });
  writeFileSync(join(dir, 'p', 'sprints.json'), JSON.stringify({ list: [{ number: 10, 'is-active': true }] }));
  writeFileSync(join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify({
    number: 10, features: [], bugs: [],
    spikes: [{ key: 'ABC-5', variations: [
      { name: 'A', 'harness-status': hs('pick') }, { name: 'B', 'harness-status': hs('pick'), 'ai-feedback-short': 'Pick me', 'state-changes': [arrived] }, { name: 'C', 'harness-status': hs('code-review') },
    ] }],
  }, null, 4));
  return dir;
}
const sprintFile = dir => join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json');
const select = (dir, ...args) => run(AGENT, ['ticket:select-variation', ...args], { env: { ...process.env, PROJECTS_DIR: dir } });
const spike = dir => JSON.parse(readFileSync(sprintFile(dir), 'utf8')).spikes[0];

test('ticket:select-variation soft deletes every other variation, records the one selected on the ticket and moves it on', async () => {
  const dir = projects();
  await select(dir, 'p', 'abc-5', 'A', 'pick', 'B', 'risk');
  const { variations: [a, b, c], 'selected-variation': selected } = spike(dir);
  assert.deepEqual({ ...selected, timestamp: 'T' }, { name: 'B', state: 'pick', timestamp: 'T' });
  for (const gone of [a, c]) {
    assert.equal(gone['is-deleted'], true);
    assert.match(gone['deleted-timestamp'], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.notDeepEqual(gone['harness-status'], hs('risk'));
  }
  // The work at pick — the choice — is done, and the one kept moves to <to-state>.
  assert.deepEqual(b['harness-status'], hs('risk'));
  assert.deepEqual(b['state-changes'][0], { ...arrived, 'work-is-done': true });
  const moved = b['state-changes'][1];
  assert.deepEqual({ ...moved, timestamp: 'T' }, { 'state-engine': 'example-development', 'from-state': 'pick', 'to-state': 'risk', timestamp: 'T', 'agent-dispatch-log': [], 'work-is-done': false });
  assert.equal(moved.timestamp, selected.timestamp);
  assert.deepEqual([b['ai-feedback-short'], b['ai-feedback-long']], [null, null]);
});

test('ticket:select-variation leaves a selected variation that is not at the state where it is', async () => {
  const dir = projects();
  await select(dir, 'p', 'ABC-5', 'A', 'pick', 'C', 'risk');
  const [a, b, c] = spike(dir).variations;
  assert.deepEqual([a['is-deleted'], b['is-deleted']], [true, true]);
  assert.deepEqual(c, { name: 'C', 'harness-status': hs('code-review') });
});

test('ticket:select-variation fails, writing nothing, unless the variation asking is at the state and the one selected is live', async () => {
  const dir = projects();
  const before = readFileSync(sprintFile(dir), 'utf8');
  await assert.rejects(select(dir, 'p', 'ABC-5', 'C', 'pick', 'A', 'risk'), /not at pick/);
  await assert.rejects(select(dir, 'p', 'ABC-5', 'A', 'pick', 'Z', 'risk'), /no ABC-5 variation Z to select/);
  await assert.rejects(select(dir, 'p', 'ABC-5', 'A', 'pick', 'B'), /usage/);
  assert.equal(readFileSync(sprintFile(dir), 'utf8'), before);
  await select(dir, 'p', 'ABC-5', 'A', 'pick', 'C', 'risk');
  await assert.rejects(select(dir, 'p', 'ABC-5', 'B', 'pick', 'A', 'risk'), /no ABC-5 variation B/);   // the one asking is deleted now
});

test('ticket:select-variation at a human step inside a sub-engine run (ASS-67): <state> its detailed step, no <to-state> — the choice recorded and the rest deleted, nothing moved (control moves the run)', async () => {
  const dir = projects();
  const file = sprintFile(dir);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  for (const v of data.spikes[0].variations.slice(0, 2)) v['harness-status'] = { ...hs('build'), 'sub-status': { state: 'pick', 'state-engine': 'choose' } };
  writeFileSync(file, JSON.stringify(data, null, 4));
  await assert.rejects(select(dir, 'p', 'ABC-5', 'A', 'build', 'B', ''), /not at build/);
  await select(dir, 'p', 'ABC-5', 'A', 'pick', 'B', '');
  const { variations: [a, b, c], 'selected-variation': selected } = spike(dir);
  assert.deepEqual([selected.name, selected.state], ['B', 'pick']);
  assert.deepEqual([a['is-deleted'], b['is-deleted'], c['is-deleted']], [true, undefined, true]);
  assert.deepEqual(b['harness-status'], data.spikes[0].variations[1]['harness-status']);
  assert.deepEqual(b['state-changes'], [arrived]);
});
