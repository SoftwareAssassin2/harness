// ticket:set-demo-plan (ASS-180 AC1): the agent writes a ticket variation's
// demo plan through one locked CLI command, the JSON on stdin —
// demo-plan-<V>.json. Validated with the same jq that ticket:demo-plan uses,
// but the input is stored byte-equal to stdin (not demo-plan.sh's reformatted
// output). Invalid input writes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const runP = promisify(execFile);

function projects() {
  const dir = mkdtempSync(join(tmpdir(), 'set-demo-plan-'));
  mkdirSync(join(dir, 'p', 'work', 'ABC-5'), { recursive: true });
  writeFileSync(join(dir, 'p', 'project.json'), '{}');
  return { dir, folder: join(dir, 'p', 'work', 'ABC-5') };
}
function cli(dir, input, ...args) {
  return new Promise(resolve => {
    const child = execFile(AGENT, args, { env: { ...process.env, PROJECTS_DIR: dir } }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
    child.stdin.end(input);
  });
}

const BROWSER = {
  demo: true,
  setup: ['pnpm install', 'pnpm nx serve web &'],
  'ready-check': 'curl -fs http://localhost:4200',
  view: { with: 'browser', address: 'http://localhost:4200/search' },
  'look-at': ['Search "tort"', 'The citation shows the reporter'],
};
const TERMINAL = { ...BROWSER, view: { with: 'terminal', commands: ['ingest --dry-run'] } };
const OTHER = { ...BROWSER, view: { with: 'other', how: 'Open the PDF in the file manager' } };
const NONE = { demo: false, why: 'A refactor: nothing the operator can see changes' };
const demoPlan = (dir, ...args) => runP(AGENT, ['ticket:demo-plan', ...args], { env: { ...process.env, PROJECTS_DIR: dir } });
const file = (folder, v) => join(folder, `demo-plan-${v}.json`);

test('ticket:set-demo-plan stores a browser demo plan byte-equal to stdin; ticket:demo-plan prints it', async () => {
  const { dir, folder } = projects();
  const body = JSON.stringify(BROWSER);
  const r = await cli(dir, body, 'ticket:set-demo-plan', 'p', 'abc-5', 'A');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(file(folder, 'A'), 'utf8'), body, 'byte-equal to stdin, not reformatted');
  const read = await demoPlan(dir, 'p', 'ABC-5', 'A');
  assert.deepEqual(JSON.parse(read.stdout), BROWSER);
});

test('ticket:set-demo-plan stores terminal, other and demo:false plans verbatim', async () => {
  const { dir, folder } = projects();
  for (const [v, plan] of [['A', TERMINAL], ['B', OTHER], ['C', NONE]]) {
    const body = JSON.stringify(plan, null, 2);
    assert.equal((await cli(dir, body, 'ticket:set-demo-plan', 'p', 'ABC-5', v)).code, 0);
    assert.equal(readFileSync(file(folder, v), 'utf8'), body, `${v}: verbatim`);
    const read = await demoPlan(dir, 'p', 'ABC-5', v);
    assert.deepEqual(JSON.parse(read.stdout).view ?? JSON.parse(read.stdout), plan.view ?? plan);
  }
});

test('ticket:set-demo-plan refuses bad shapes, exit 1, nothing written, naming ticket:set-demo-plan and left-as-it-was', async () => {
  const { dir, folder } = projects();
  await cli(dir, JSON.stringify(BROWSER), 'ticket:set-demo-plan', 'p', 'ABC-5', 'A');
  const before = readFileSync(file(folder, 'A'), 'utf8');
  const malformed = [
    ['not JSON', 'not json'],
    ['two values', '[] []'],
    ['missing setup', JSON.stringify({ ...BROWSER, setup: undefined })],
    ['missing ready-check', JSON.stringify((({ 'ready-check': _, ...rest }) => rest)(BROWSER))],
    ['missing view', JSON.stringify((({ view: _, ...rest }) => rest)(BROWSER))],
    ['missing look-at', JSON.stringify((({ 'look-at': _, ...rest }) => rest)(BROWSER))],
    ['bad view.with', JSON.stringify({ ...BROWSER, view: { with: 'vnc', address: 'x' } })],
    ['view.with:terminal empty commands', JSON.stringify({ ...BROWSER, view: { with: 'terminal', commands: [] } })],
    ['demo:false without why', '{"demo":false}'],
    ['setup non-string item', JSON.stringify({ ...BROWSER, setup: [1] })],
    ['empty stdin', ''],
  ];
  for (const [name, body] of malformed) {
    const r = await cli(dir, body, 'ticket:set-demo-plan', 'p', 'ABC-5', 'A');
    assert.equal(r.code, 1, `${name}: expected exit 1 — got ${JSON.stringify(r)}`);
    assert.match(r.stderr, /ticket:set-demo-plan:/, name);
    assert.match(r.stderr, /left as it was/, name);
  }
  assert.equal(readFileSync(file(folder, 'A'), 'utf8'), before, 'the stored plan is untouched');
});

test('ticket:set-demo-plan refuses bad project / ticket / variation and missing work folder', async () => {
  const { dir, folder } = projects();
  for (const [args, pat] of [
    [['../p', 'ABC-5', 'A'], /invalid project/],
    [['p', '../ABC-5', 'A'], /invalid ticket/],
    [['p', 'ABC-5', 'A/..'], /invalid variation/],
    [['p', 'ABC-9', 'A'], /no work folder|has no work/],
  ]) {
    const r = await cli(dir, JSON.stringify(BROWSER), 'ticket:set-demo-plan', ...args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.stderr, pat, args.join(' '));
  }
  const outside = join(dir, 'outside.json');
  writeFileSync(outside, JSON.stringify(BROWSER));
  symlinkSync(outside, join(folder, 'demo-plan-A.json'));
  const r = await cli(dir, JSON.stringify(TERMINAL), 'ticket:set-demo-plan', 'p', 'ABC-5', 'A');
  assert.equal(r.code, 1, 'a symlink out of the folder is refused');
  assert.equal(readFileSync(outside, 'utf8'), JSON.stringify(BROWSER));
});

test('ticket:set-demo-plan: a .lock file beside demo-plan-<V>.json', async () => {
  const { dir, folder } = projects();
  await cli(dir, JSON.stringify(BROWSER), 'ticket:set-demo-plan', 'p', 'ABC-5', 'A');
  assert.ok(readdirSync(folder).some(f => f === 'demo-plan-A.json.lock'), 'the lock sits beside the file');
});
