// ASS-471: the commands a project's CI checks need on the machine they run on — each check's command's first
// words and its declared "needs" — which workstation:setup checks by name (src/agent-cli/ci-check-commands.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandsOf, neededCommands } from '../../src/agent-cli/ci-check-commands.js';

const run = promisify(execFile);
const SCRIPT = join(import.meta.dirname, '..', '..', 'src', 'agent-cli', 'ci-check-commands.js');

test('ASS-471 AC1: the first word of each simple command, past assignments, keywords and redirections; not builtins, paths or words known only when it runs', () => {
  for (const [line, commands] of [
    ['CI_MERGE_REQUEST_DIFF_BASE_SHA="$CI_CHECK_BASE" sh scripts/ci/secret-scan.sh', ['sh']],
    ['example-static-policy-gate', ['example-static-policy-gate']],
    ['export EXAMPLE_PLATFORM_DIR=/repos/x; bash a.sh && bash b.sh && bash c.sh', ['bash']],
    ['if foo 2>&1 >/dev/null; then exec bar | baz; else ! qux; fi', ['foo', 'bar', 'baz', 'qux']],
    ['X=$(git rev-parse HEAD) make lint $(date) arg', ['git', 'make', 'date']],
    ['$CMD x; "$X" y; ./s.sh; scripts/x; /usr/bin/env z', []],
    ['A="b c" D=\'e f\' node x.js # a comment: notacommand\n(cd x && npm test) || kubectl get', ['node', 'npm', 'kubectl']],
    ['echo > out.txt; 2>err cat x; < in tr a b', ['cat', 'tr']],
    ['for f in *.sh; do shellcheck "$f"; done', ['shellcheck']],
    ['"quoted-cmd" arg; \'single\' x', ['quoted-cmd', 'single']],
  ]) assert.deepEqual(commandsOf(line), commands, line);
});

test('ASS-471 AC1: each command with the checks that need it, by name and repositories; declared needs too; malformed entries passed over', () => {
  const repos = n => Array.from({ length: n }, (_, i) => `r${i}`);
  const declared = { repositories: Object.fromEntries([
    ...repos(5).map(r => [r, [{ name: 'gate', command: 'gate' }]]),
    ['one', [{ name: 'lint', command: 'bash x.sh', needs: ['sqlfluff', 'bad name', 3] }, { name: 'x' }, null, { name: 'gate', command: 'gate' }]],
    ['two', 'not a list'],
  ]) };
  assert.deepEqual(neededCommands(declared), [
    ['bash', 'lint (one)'],
    ['gate', 'gate (r0, r1 and 4 more)'],
    ['sqlfluff', 'lint (one)'],
  ]);
  assert.deepEqual(neededCommands({ repositories: { a: [{ name: 'n', command: 'c' }, { name: 'm', command: 'c' }], b: [{ name: 'n', command: 'c' }] } }),
    [['c', 'n (a and b), m (a)']]);
  assert.deepEqual(neededCommands({}), []);
});

test('ASS-471 AC1: run as a script it prints <command>\\t<checks> lines; a file that is not JSON fails, naming it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cicmd-'));
  writeFileSync(join(dir, 'ok.json'), JSON.stringify({ repositories: { a: [{ name: 'n', command: 'b && a' }] } }));
  assert.equal((await run('node', [SCRIPT, join(dir, 'ok.json')])).stdout, 'a\tn (a)\nb\tn (a)\n');
  writeFileSync(join(dir, 'bad.json'), '{');
  const e = await run('node', [SCRIPT, join(dir, 'bad.json')]).then(() => null, x => x);
  assert.equal(e?.code, 1);
  assert.match(e.stderr, /bad\.json: not valid JSON/);
});
