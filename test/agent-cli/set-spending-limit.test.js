// ticket:set-spending-limit — a ticket's own spending limit (ASS-191 AC4):
// max-spend-usd on a sprint or backlog ticket, over project.json's and
// harness.json's max-spend-per-ticket-usd; "-" clears it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const hs = state => ({ state, 'state-engine': 'example-development' });

// A projects/ folder whose project p has sprint 10 active with ABC-3 in it, and B-1 in its backlog.
function projects() {
  const dir = mkdtempSync(join(tmpdir(), 'ssl-'));
  mkdirSync(join(dir, 'p', 'sprints', 'sprint-10'), { recursive: true });
  writeFileSync(join(dir, 'p', 'sprints.json'), JSON.stringify({ list: [{ number: 10, 'is-active': true }] }));
  writeFileSync(join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify({ number: 10, bugs: [], spikes: [],
    features: [{ key: 'ABC-3', variations: [{ name: 'A', 'harness-status': hs('build') }] }] }));
  writeFileSync(join(dir, 'p', 'backlog.json'), JSON.stringify({ tickets: [{ key: 'B-1', variations: [{ name: 'A', 'harness-status': hs('refine') }] }] }));
  return dir;
}
const set = (dir, ...args) => run(AGENT, ['ticket:set-spending-limit', ...args], { env: { ...process.env, PROJECTS_DIR: dir } });
const sprintTicket = dir => JSON.parse(readFileSync(join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json'), 'utf8')).features[0];
const backlogTicket = dir => JSON.parse(readFileSync(join(dir, 'p', 'backlog.json'), 'utf8')).tickets[0];

test('ASS-191 AC4: ticket:set-spending-limit sets a sprint ticket\'s max-spend-usd, replaces it, and "-" clears it', async () => {
  const dir = projects();
  await set(dir, 'p', 'abc-3', '12.5');
  assert.equal(sprintTicket(dir)['max-spend-usd'], 12.5);
  await set(dir, 'p', 'ABC-3', '40');
  assert.equal(sprintTicket(dir)['max-spend-usd'], 40);
  await set(dir, 'p', 'ABC-3', '-');
  assert.equal('max-spend-usd' in sprintTicket(dir), false);
});

test('ASS-191 AC4: ticket:set-spending-limit sets a backlog ticket\'s too', async () => {
  const dir = projects();
  await set(dir, 'p', 'B-1', '3');
  assert.equal(backlogTicket(dir)['max-spend-usd'], 3);
});

test('ASS-191 AC4: ticket:set-spending-limit fails, writing nothing, on an amount that is not dollars or an unknown ticket', async () => {
  const dir = projects();
  for (const args of [['p', 'ABC-3', 'ten'], ['p', 'ABC-3', '-1'], ['p', 'ABC-3'], ['p', 'NOPE-1', '5']]) {
    await assert.rejects(set(dir, ...args), args.join(' '));
  }
  assert.equal('max-spend-usd' in sprintTicket(dir), false);
});
