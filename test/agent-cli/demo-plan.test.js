// ticket:demo-plan (ASS-76 AC1) — the demo plan Write Test Plan writes for a
// ticket variation, projects/<project>/work/<KEY>/demo-plan-<variation>.json,
// read back checked: what Review Plan shows, and what the Demo action at human
// review follows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');

// A projects/ folder with project p; ABC-5's folder holds variation <name>'s demo plan when given one.
function projects(plans = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'demo-plan-'));
  mkdirSync(join(dir, 'p', 'work', 'ABC-5'), { recursive: true });
  writeFileSync(join(dir, 'p', 'project.json'), '{}');
  for (const [name, plan] of Object.entries(plans))
    writeFileSync(join(dir, 'p', 'work', 'ABC-5', `demo-plan-${name}.json`), typeof plan === 'string' ? plan : JSON.stringify(plan));
  return dir;
}
const demoPlan = (dir, ...args) => run(AGENT, ['ticket:demo-plan', 'p', ...args], { env: { ...process.env, PROJECTS_DIR: dir } });

const BROWSER = {
  demo: true,
  setup: ['pnpm install', 'pnpm nx serve web &'],
  'ready-check': 'curl -fs http://localhost:4200',
  view: { with: 'browser', address: 'http://localhost:4200/search' },
  'look-at': ['Search "tort"', 'The citation shows the reporter'],
};

test('ticket:demo-plan prints a variation\'s demo plan from the ticket\'s folder', async () => {
  const dir = projects({ A: BROWSER, B: { ...BROWSER, view: { with: 'terminal', commands: ['ingest --dry-run'] } } });
  assert.deepEqual(JSON.parse((await demoPlan(dir, 'abc-5', 'A')).stdout), BROWSER);
  assert.deepEqual(JSON.parse((await demoPlan(dir, 'ABC-5', 'B')).stdout).view, { with: 'terminal', commands: ['ingest --dry-run'] });
});

test('ticket:demo-plan takes a view with some other tool, said in words, and a plan of no demo with why; it prints only the fixed fields', async () => {
  const other = { ...BROWSER, view: { with: 'other', how: 'Open the PDF in the file manager' }, note: 'dropped' };
  const none = { demo: false, why: 'A refactor: nothing the operator can see changes' };
  const dir = projects({ A: other, B: none });
  const { note, ...kept } = other;
  assert.deepEqual(JSON.parse((await demoPlan(dir, 'ABC-5', 'A')).stdout), kept);
  assert.deepEqual(JSON.parse((await demoPlan(dir, 'ABC-5', 'B')).stdout), none);
});

test('ticket:demo-plan fails, naming the file, when the variation has no demo plan', async () => {
  await assert.rejects(demoPlan(projects(), 'ABC-5', 'A'), /ticket:demo-plan: ABC-5 has no demo-plan-A\.json in its folder/);
});

test('ticket:demo-plan fails, saying the shape it wants, on a malformed demo plan', async () => {
  const malformed = [
    'not json',
    { ...BROWSER, setup: 'pnpm install' },
    { ...BROWSER, setup: [1] },
    { ...BROWSER, 'ready-check': '' },
    { ...BROWSER, view: { with: 'browser' } },
    { ...BROWSER, view: { with: 'terminal', commands: [] } },
    { ...BROWSER, view: { with: 'other' } },
    { ...BROWSER, view: { with: 'vnc', address: 'x' } },
    { ...BROWSER, 'look-at': [] },
    { demo: false },
    { demo: 'yes' },
  ];
  for (const plan of malformed)
    await assert.rejects(demoPlan(projects({ A: plan }), 'ABC-5', 'A'), /demo-plan-A\.json must hold/, JSON.stringify(plan));
});

test('ticket:demo-plan refuses a project, ticket or variation that is not a plain name', async () => {
  const dir = projects({ A: BROWSER });
  await assert.rejects(demoPlan(dir, 'ABC-5', '../A'), /invalid variation/);
  await assert.rejects(demoPlan(dir, '../ABC-5', 'A'), /invalid ticket/);
  await assert.rejects(run(AGENT, ['ticket:demo-plan', '../p', 'ABC-5', 'A'], { env: { ...process.env, PROJECTS_DIR: dir } }), /invalid project/);
});
