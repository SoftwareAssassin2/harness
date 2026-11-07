// ticket:set-paused — pauses or unpauses a ticket variation in the active
// sprint's sprint.json.
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

// A projects/ folder whose project p has sprint 10 active, with a feature in two variations.
function projects() {
  const dir = mkdtempSync(join(tmpdir(), 'sp-'));
  mkdirSync(join(dir, 'p', 'sprints', 'sprint-10'), { recursive: true });
  writeFileSync(join(dir, 'p', 'sprints.json'), JSON.stringify({ list: [{ number: 10, 'is-active': true }] }));
  writeFileSync(join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify({
    number: 10,
    features: [{ key: 'ABC-3', variations: [{ name: 'A', 'harness-status': hs('a') }, { name: 'B', 'harness-status': hs('b') }] }],
  }, null, 4));
  return dir;
}
const sprintFile = dir => join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json');
const set = (dir, ...args) => run(AGENT, ['ticket:set-paused', ...args], { env: { ...process.env, PROJECTS_DIR: dir } });
const paused = dir => JSON.parse(readFileSync(sprintFile(dir), 'utf8')).features[0].variations.map(v => v['is-paused']);

test('ticket:set-paused sets the variation\'s is-paused, whatever state it is in', async () => {
  const dir = projects();
  await set(dir, 'p', 'abc-3', 'B', 'true');
  assert.deepEqual(paused(dir), [undefined, true]);
  await set(dir, 'p', 'ABC-3', 'B', 'false');
  assert.deepEqual(paused(dir), [undefined, false]);
});

test('ticket:set-paused fails, writing nothing, on anything but true or false, or an unknown ticket or variation', async () => {
  const dir = projects();
  const before = readFileSync(sprintFile(dir), 'utf8');
  await assert.rejects(set(dir, 'p', 'ABC-3', 'A', 'yes'), /usage/);
  await assert.rejects(set(dir, 'p', 'ABC-9', 'A', 'true'), /no ABC-9/);
  await assert.rejects(set(dir, 'p', 'ABC-3', 'Z', 'true'), /no ABC-3 variation Z/);
  await assert.rejects(set(dir, 'p', 'ABC-3', 'A'), /usage/);
  await assert.rejects(set(dir, '../p', 'ABC-3', 'A', 'true'), /invalid project/);
  assert.equal(readFileSync(sprintFile(dir), 'utf8'), before);
});

// ASS-83: control's pre-emption pause, told apart from anyone else's.
const preempt = (dir, ...args) => run(AGENT, ['ticket:set-preempted', ...args], { env: { ...process.env, PROJECTS_DIR: dir } });
const marks = dir => JSON.parse(readFileSync(sprintFile(dir), 'utf8')).features[0].variations.map(v => [v['is-paused'] ?? null, v['paused-for-fast-track'] ?? null]);

test('ASS-83 AC3: ticket:set-preempted pauses a variation for a fast-tracked ticket, naming it; - resumes only a variation it paused, never one paused otherwise', async () => {
  const dir = projects();
  await preempt(dir, 'p', 'abc-3', 'A', 'hd-160');
  assert.deepEqual(marks(dir), [[true, 'HD-160'], [null, null]]);
  await preempt(dir, 'p', 'ABC-3', 'A', '-');
  assert.deepEqual(marks(dir), [[false, null], [null, null]]);
  await set(dir, 'p', 'ABC-3', 'B', 'true');                     // the operator's pause
  await preempt(dir, 'p', 'ABC-3', 'B', '-');
  assert.deepEqual(marks(dir), [[false, null], [true, null]]);
  const before = readFileSync(sprintFile(dir), 'utf8');
  await assert.rejects(preempt(dir, 'p', 'ABC-3', 'Z', 'HD-1'), /no ABC-3 variation Z/);
  await assert.rejects(preempt(dir, 'p', 'ABC-3', 'A'), /usage/);
  await assert.rejects(preempt(dir, 'p', 'ABC-3', 'A', 'HD-1', 'seats'), /usage/);
  await assert.rejects(preempt(dir, 'p', 'ABC-3', 'A', '-', 'agents'), /usage/);
  assert.equal(readFileSync(sprintFile(dir), 'utf8'), before);
});

test('ASS-83 AC3: ticket:set-paused takes a pre-empted variation over — the operator\'s pause or unpause, control\'s mark gone', async () => {
  const dir = projects();
  await preempt(dir, 'p', 'ABC-3', 'A', 'HD-1');
  await set(dir, 'p', 'ABC-3', 'A', 'true');
  assert.deepEqual(marks(dir)[0], [true, null]);
  await preempt(dir, 'p', 'ABC-3', 'A', '-');                    // so control leaves it paused
  assert.deepEqual(marks(dir)[0], [true, null]);
});

test('ASS-83 AC3: ticket:set-preempted records the pool the seat was freed in — planning, progress or agents; resuming, or the operator taking the pause over, clears it', async () => {
  const dir = projects();
  const seat = () => JSON.parse(readFileSync(sprintFile(dir), 'utf8')).features[0].variations[0]['preempted-seat'] ?? null;
  await preempt(dir, 'p', 'ABC-3', 'A', 'HD-1', 'agents');
  assert.equal(seat(), 'agents');
  await preempt(dir, 'p', 'ABC-3', 'A', '-');
  assert.equal(seat(), null);
  await preempt(dir, 'p', 'ABC-3', 'A', 'HD-1', 'planning');
  await set(dir, 'p', 'ABC-3', 'A', 'true');
  assert.equal(seat(), null);
});
