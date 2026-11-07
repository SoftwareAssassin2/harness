// ticket:set-manual — marks a sprint or backlog ticket as worked by hand
// (ASS-166): worked-manually { by, since, note } on the ticket, or cleared.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withExampleEngines } from '../support/engine-walk.js';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const hs = state => ({ state, 'state-engine': 'example-development' });

// A projects/ folder whose project p has sprint 10 active, a feature in two
// variations (one paused) there, and B-1 in its backlog.
function projects() {
  const dir = mkdtempSync(join(tmpdir(), 'sm-'));
  mkdirSync(join(dir, 'p', 'sprints', 'sprint-10'), { recursive: true });
  writeFileSync(join(dir, 'p', 'sprints.json'), JSON.stringify({ list: [{ number: 10, 'is-active': true }] }));
  writeFileSync(join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify({ number: 10, bugs: [], spikes: [],
    features: [{ key: 'ABC-3', variations: [{ name: 'A', 'harness-status': hs('build'), 'is-paused': true }, { name: 'B', 'harness-status': hs('plan') }] }] }));
  writeFileSync(join(dir, 'p', 'backlog.json'), JSON.stringify({ tickets: [{ key: 'B-1', variations: [{ name: 'A', 'harness-status': hs('refine') }] }] }));
  withExampleEngines(join(dir, 'p'));   // p's own example-development (ASS-276)
  return dir;
}
const sprintFile = dir => join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json');
const set = (dir, ...args) => run(AGENT, ['ticket:set-manual', ...args], { env: { ...process.env, PROJECTS_DIR: dir, USER: 'ada' } });
const sprintTicket = dir => JSON.parse(readFileSync(sprintFile(dir), 'utf8')).features[0];
const backlogTicket = dir => JSON.parse(readFileSync(join(dir, 'p', 'backlog.json'), 'utf8')).tickets[0];

test('ASS-166 AC1: ticket:set-manual on marks a sprint ticket worked by hand — by $USER, since now, the note — and off clears it; its pauses stay as they were (AC5)', async () => {
  const dir = projects();
  const before = Date.now();
  await set(dir, 'p', 'abc-3', 'on', 'building it in the coordinator');
  const { by, since, note } = sprintTicket(dir)['worked-manually'];
  assert.deepEqual([by, note], ['ada', 'building it in the coordinator']);
  assert.ok(Date.parse(since) >= before - 1000 && Date.parse(since) <= Date.now(), since);
  assert.deepEqual(sprintTicket(dir).variations.map(v => v['is-paused']), [true, undefined]);
  await set(dir, 'p', 'ABC-3', 'off');
  assert.equal(sprintTicket(dir)['worked-manually'], undefined);
  assert.deepEqual(sprintTicket(dir).variations.map(v => v['is-paused']), [true, undefined]);
});

test('ASS-166 AC1: ticket:set-manual marks a backlog ticket too, a note left out null', async () => {
  const dir = projects();
  await set(dir, 'p', 'B-1', 'on');
  assert.equal(backlogTicket(dir)['worked-manually'].by, 'ada');
  assert.equal(backlogTicket(dir)['worked-manually'].note, null);
  await set(dir, 'p', 'B-1', 'off');
  assert.equal(backlogTicket(dir)['worked-manually'], undefined);
});

test('ASS-166 AC1: ticket:set-manual fails, writing nothing, on anything but on or off, a note with off, or an unknown ticket', async () => {
  const dir = projects();
  const before = readFileSync(sprintFile(dir), 'utf8');
  await assert.rejects(set(dir, 'p', 'ABC-3', 'yes'), /usage/);
  await assert.rejects(set(dir, 'p', 'ABC-3'), /usage/);
  await assert.rejects(set(dir, 'p', 'ABC-3', 'off', 'why'), /usage/);
  await assert.rejects(set(dir, 'p', 'ABC-9', 'on'), /no ABC-9/);
  assert.equal(readFileSync(sprintFile(dir), 'utf8'), before);
});

const agent = (dir, ...args) => run(AGENT, args, { env: { ...process.env, PROJECTS_DIR: dir, ACLI_DISABLED: '1' } });

test('ASS-166 AC4: a move of any variation into a done step clears the mark — ticket:change-state, as the coordinator\'s mark-done takes it; a move elsewhere, or a pause, leaves it (AC5)', async () => {
  const dir = projects();
  await set(dir, 'p', 'ABC-3', 'on');
  await agent(dir, 'ticket:change-state', 'p', 'ABC-3', 'A', 'build', 'code-review');
  await agent(dir, 'ticket:set-paused', 'p', 'ABC-3', 'A', 'false');
  await agent(dir, 'ticket:set-paused', 'p', 'ABC-3', 'B', 'true');
  assert.equal(sprintTicket(dir)['worked-manually'].by, 'ada');
  await agent(dir, 'ticket:change-state', 'p', 'ABC-3', 'B', 'plan', 'done');
  assert.equal(sprintTicket(dir)['worked-manually'], undefined);
});

test('ASS-166 AC4: ticket:human-review moving a variation into done clears the mark too', async () => {
  const dir = projects();
  await set(dir, 'p', 'ABC-3', 'on');
  await agent(dir, 'ticket:human-review', 'p', 'ABC-3', 'A', 'build', 'Approve', 'done');
  assert.equal(sprintTicket(dir)['worked-manually'], undefined);
});
