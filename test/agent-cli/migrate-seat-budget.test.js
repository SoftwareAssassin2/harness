// ASS-528 AC1: harness:migrate-seat-budget — the one-off migration to the seat budget. It removes
// max-tickets-in-progress and max-tickets-in-planning from harness.json and every project.json, adds the default
// budget (max-memory-percent 90, max-cpu-percent 90) to harness.json, logs each change, and changes nothing the
// second time. Run on fixture copies (HARNESS_FILE, PROJECTS_DIR), never the live data folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const json = file => JSON.parse(readFileSync(file, 'utf8'));

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'seat-budget-'));
  const harness = join(dir, 'harness.json'), projects = join(dir, 'projects');
  writeFileSync(harness, JSON.stringify({ 'max-agents': 8, 'max-tickets-in-progress': 4, 'max-tickets-in-planning': 3, 'max-tickets-ready-for-build': 2, 'max-cpu-percent': 70 }));
  for (const [id, body] of [['alpha', { name: 'Alpha', 'max-tickets-in-progress': 2, 'max-tickets-in-planning': 1, 'max-agents': 3 }], ['beta', { name: 'Beta', share: 40 }]]) {
    mkdirSync(join(projects, id), { recursive: true });
    writeFileSync(join(projects, id, 'project.json'), JSON.stringify(body));
  }
  const migrate = (...args) => run(AGENT, ['harness:migrate-seat-budget', ...args], { env: { ...process.env, HARNESS_FILE: harness, PROJECTS_DIR: projects } });
  return { harness, projects, migrate, project: id => json(join(projects, id, 'project.json')) };
}

test('ASS-528 AC1: harness:migrate-seat-budget removes the seat counts everywhere, adds the default budget where harness.json has none, and logs each change', async () => {
  const f = fixture();
  const { stdout } = await f.migrate();
  assert.deepEqual(stdout.trim().split('\n'), [
    'harness.json: removed max-tickets-in-progress (4), removed max-tickets-in-planning (3), added max-memory-percent 90',
    'projects/alpha/project.json: removed max-tickets-in-progress (2), removed max-tickets-in-planning (1)',
    'projects/beta/project.json: nothing to change',
  ]);
  // everything else kept, max-tickets-ready-for-build and a budget value already set included.
  assert.deepEqual(json(f.harness), { 'max-agents': 8, 'max-tickets-ready-for-build': 2, 'max-cpu-percent': 70, 'max-memory-percent': 90 });
  assert.deepEqual(f.project('alpha'), { name: 'Alpha', 'max-agents': 3 });
  assert.deepEqual(f.project('beta'), { name: 'Beta', share: 40 });
});

test('ASS-528 AC1: run again it changes nothing — no file rewritten; --dry-run says what it would change and writes nothing', async () => {
  const f = fixture();
  const dry = await f.migrate('--dry-run');
  assert.match(dry.stdout, /^harness\.json: removed max-tickets-in-progress \(4\), removed max-tickets-in-planning \(3\), added max-memory-percent 90 \(dry run: not written\)$/m);
  assert.equal(json(f.harness)['max-tickets-in-progress'], 4);
  await f.migrate();
  const before = statSync(f.harness).mtimeMs;
  const again = await f.migrate();
  assert.deepEqual(again.stdout.trim().split('\n'), ['harness.json: nothing to change', 'projects/alpha/project.json: nothing to change', 'projects/beta/project.json: nothing to change']);
  assert.equal(statSync(f.harness).mtimeMs, before);
});

test('ASS-528 AC1: a harness.json with no budget at all gets both defaults; a bad argument or a file that is no JSON fails, writing nothing to it', async () => {
  const f = fixture();
  writeFileSync(f.harness, JSON.stringify({ 'max-tickets-in-progress': 1 }));
  await f.migrate();
  assert.deepEqual(json(f.harness), { 'max-memory-percent': 90, 'max-cpu-percent': 90 });
  await assert.rejects(f.migrate('--now'), /usage: harness:migrate-seat-budget \[--dry-run\]/);
  writeFileSync(join(f.projects, 'beta', 'project.json'), '{ not json');
  await assert.rejects(f.migrate(), /beta\/project\.json is not valid JSON/);
  assert.equal(readFileSync(join(f.projects, 'beta', 'project.json'), 'utf8'), '{ not json');
});
