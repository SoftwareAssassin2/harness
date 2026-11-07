// tui (ASS-290) — ./harness.sh tui runs /install first when no project is
// installed (no <PROJECTS_DIR>/*/project.json) and the terminal is
// interactive. Tests force "interactive" with HARNESS_FORCE_INTERACTIVE=1 and
// feed the "Start the dashboard anyway?" answer through stdin. CLAUDE_BIN is a
// stub that logs its args, working folder and HARNESS_INSTALL_FROM_TUI and,
// when INSTALLS is set, writes a project.json; HARNESS_TUI_MAIN is a stub
// dashboard that logs each start and exits with the next code in its list
// (75 is a restart).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const HARNESS = join(ROOT, 'harness.sh');

function setup({ installed = false, codes = [0] } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tui-')));
  const at = (...p) => join(dir, ...p);
  mkdirSync(at('projects'));
  if (installed) { mkdirSync(at('projects', 'p')); writeFileSync(at('projects', 'p', 'project.json'), '{}'); }
  writeFileSync(at('claude'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${at('claude.log')}"
pwd -P >> "${at('claude.log')}"
echo "from-tui=\${HARNESS_INSTALL_FROM_TUI:-}" >> "${at('claude.log')}"
if [[ -n "\${INSTALLS:-}" ]]; then mkdir -p "$PROJECTS_DIR/p"; echo '{}' > "$PROJECTS_DIR/p/project.json"; fi
`);
  writeFileSync(at('codes'), codes.join('\n') + '\n');
  writeFileSync(at('dashboard'), `#!/usr/bin/env bash
echo "start\${*:+ $*}" >> "${at('dashboard.log')}"
code=$(head -n 1 "${at('codes')}"); tail -n +2 "${at('codes')}" > "${at('codes')}.next"; mv "${at('codes')}.next" "${at('codes')}"
exit "\${code:-0}"
`);
  chmodSync(at('claude'), 0o755);
  chmodSync(at('dashboard'), 0o755);
  const env = { ...process.env, PROJECTS_DIR: at('projects'), CLAUDE_BIN: at('claude'), HARNESS_TUI_MAIN: at('dashboard'), HARNESS_FORCE_INTERACTIVE: '1' };
  delete env.HARNESS_SKIP_INSTALL;
  delete env.INSTALLS;
  const tui = ({ input = '', extra = {}, args = [] } = {}) => spawnSync(HARNESS, ['tui', ...args], { env: { ...env, ...extra }, input, encoding: 'utf8' });
  const log = name => existsSync(at(name)) ? readFileSync(at(name), 'utf8').trim().split('\n') : [];
  return { at, tui, log };
}

test('AC1: nothing installed, interactive: it says /install runs first, runs claude "/install" in the repo root, then starts the dashboard once a project is installed', () => {
  const s = setup();
  const r = s.tui({ extra: { INSTALLS: '1' }, args: ['--some-arg'] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout + r.stderr, /No project is installed.*\/install/);
  assert.deepEqual(s.log('claude.log'), ['/install', realpathSync(ROOT), 'from-tui=1']);
  assert.deepEqual(s.log('dashboard.log'), ['start --some-arg']);
  assert.doesNotMatch(r.stdout, /Start the dashboard anyway/);
});

test('AC1: still nothing installed after /install: it asks, and y starts the dashboard', () => {
  const s = setup();
  const r = s.tui({ input: 'y\n' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Start the dashboard anyway\? \[y\/N\]/);
  assert.equal(s.log('claude.log').length, 3);
  assert.deepEqual(s.log('dashboard.log'), ['start']);
});

test('AC1: still nothing installed after /install: n, an empty answer or no answer exits 1 with how to rerun, without the dashboard', () => {
  for (const input of ['n\n', '\n', '']) {
    const s = setup();
    const r = s.tui({ input });
    assert.equal(r.status, 1, `answer ${JSON.stringify(input)}`);
    assert.match(r.stdout + r.stderr, /\.\/harness\.sh tui/);
    assert.deepEqual(s.log('dashboard.log'), []);
  }
});

test('AC2: a project installed: the dashboard starts directly, claude is never run', () => {
  const s = setup({ installed: true });
  const r = s.tui();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(s.log('claude.log'), []);
  assert.deepEqual(s.log('dashboard.log'), ['start']);
});

test('AC2: HARNESS_SKIP_INSTALL=1 skips the check: the dashboard starts directly', () => {
  const s = setup();
  const r = s.tui({ extra: { HARNESS_SKIP_INSTALL: '1' } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(s.log('claude.log'), []);
  assert.deepEqual(s.log('dashboard.log'), ['start']);
});

test('AC2: a non-interactive terminal skips the check: the dashboard starts directly', () => {
  const s = setup();
  const r = s.tui({ extra: { HARNESS_FORCE_INTERACTIVE: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(s.log('claude.log'), []);
  assert.deepEqual(s.log('dashboard.log'), ['start']);
});

test('AC2: a restart (exit 75) starts the dashboard again without rerunning the check; another exit code ends it with that code', () => {
  const s = setup({ codes: [75, 75, 3] });
  // Nothing gets installed, so a check rerun on restart would run claude and ask again.
  const r = s.tui({ input: 'y\n' });
  assert.equal(r.status, 3, r.stderr);
  assert.equal(s.log('claude.log').length, 3, 'claude ran once');
  assert.equal(r.stdout.match(/Start the dashboard anyway/g).length, 1);
  assert.deepEqual(s.log('dashboard.log'), ['start', 'start', 'start']);
});

test('AC3: the claude binary missing: it says how to install Claude Code and run /install, and exits 1 without the dashboard', () => {
  const s = setup();
  const r = s.tui({ extra: { CLAUDE_BIN: s.at('no-such-claude') } });
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /claude\.com\/claude-code/);
  assert.match(r.stdout + r.stderr, /\/install/);
  assert.deepEqual(s.log('dashboard.log'), []);
});
