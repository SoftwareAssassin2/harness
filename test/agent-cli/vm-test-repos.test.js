// vm:test-repos (ASS-105): every repository's automated tests, as the
// project's golden-image/tests.json lists them, run in a throwaway clone of
// its golden image, and a report per repository. limactl is
// test/support/fake-limactl.js; the VM's root a folder (HARNESS_VM_ROOT)
// holding real git checkouts; gh, glab and sandbox-exec are fakes on the
// Mac's PATH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, run, AGENT } from './harness-fixture.js';
import { fakeVm } from '../support/fake-vm.js';

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };

const TESTS = {
  repositories: {
    harness: { tests: [{ name: 'unit', command: 'echo "ran in $PWD"; echo "# pass 3"; echo "# fail 0"', summary: '^# (pass|fail)' }] },
    'example-ci': { 'no-tests': 'its CI runs only lint' },
    'example-corpus': { tests: [
      { name: 'go', command: 'echo "FAIL x"; exit 1' },
      { name: 'db', command: 'exit 2', 'pre-existing': 'fails on master too: https://gitlab.com/g/example-corpus/-/jobs/1' }] },
  },
};

// Project p: three repositories, each cloned in the VM's root at /repos/<basename> before master moved on; golden-p built; zot on 5101.
function lima({ runner = true } = {}) {
  const f = fixture(), v = fakeVm(f.env);
  const at = (...rest) => join(f.dir, ...rest);
  const origins = {};
  for (const name of ['harness', 'example-ci', 'example-corpus']) {
    const work = mkdtempSync(join(tmpdir(), 'origin-'));
    execFileSync('git', ['init', '-q', '--initial-branch=master', work]);
    git(work, 'config', 'user.email', 't@example.com'); git(work, 'config', 'user.name', 'T');
    writeFileSync(join(work, 'README.md'), 'one\n'); git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'one');
    mkdirSync(join(v.root, 'repos'), { recursive: true });
    execFileSync('git', ['clone', '-q', work, join(v.root, 'repos', name)]);
    git(work, 'commit', '-q', '--allow-empty', '-m', 'two');
    origins[name] = work;
  }
  edit(at('projects', 'p', 'project.json'), p => {
    p.repositories = [{ url: 'https://github.com/o/harness' }, { url: 'https://gitlab.com/g/example-ci' }, { url: 'https://gitlab.com/g/example-corpus.git' }];
    p.registry = { 'storage-path': 'projects/p/registry', 'max-size-gb': 1, port: 5101 };
    p['golden-image'] = { folder: 'projects/p/golden-image' };
  });
  mkdirSync(at('projects', 'p', 'golden-image'), { recursive: true });
  writeFileSync(at('projects', 'p', 'golden-image', 'tests.json'), JSON.stringify(TESTS));
  if (runner) writeFileSync(at('projects', 'p', 'golden-image', 'run-test.sh'), 'IFS= read -r gh; IFS= read -r gl; echo "$gh $gl $PWD" >> "$HARNESS_VM_ROOT/runner-saw"; exec bash -c "$1"\n');
  v.instance('golden-p');
  v.script('gh', 'case "$*" in "auth status") ;; "auth token") echo gho_GH ;; esac');
  v.script('glab', `echo "$*" >> "${v.dir}/glab.log"; [[ "$*" != "config get token --host gitlab.com" ]] || echo glpat-GL`);
  v.script('sandbox-exec', `[[ "$1" == -p ]] || exit 2; printf '%s\\n' "$2" > "${v.dir}/sandbox-profile"; shift 2; exec "$@"`);
  const cli = (...args) => run(AGENT, ['vm:test-repos', 'p', ...args], { env: v.env });
  return { f, v, at, cli, origins, vmFile: (...p) => join(v.root, ...p) };
}

test('vm:test-repos p clones golden-p into a throwaway VM, starts it sandboxed, checks out master, runs each listed test through run-test.sh, reports per repository, deletes the VM, and fails on a failure that is not pre-existing', async () => {
  const l = lima();
  const err = await l.cli().then(() => assert.fail('a failing test fails the run'), e => e);
  assert.equal(err.code, 1);
  const report = err.stdout;
  const calls = l.v.calls();
  const clone = calls.find(c => c.argv?.[0] === 'clone');
  const vm = clone.argv[3];
  assert.match(vm, /^test-p-\d+$/);
  assert.deepEqual(clone.argv.slice(0, 3), ['clone', '--tty=false', 'golden-p']);
  const set = clone.argv[clone.argv.indexOf('--set') + 1];
  assert.match(set, /\.mounts = \[\]/, 'nothing of the Mac mounted');
  const ssh = /\.ssh\.localPort = (\d+)/.exec(set)[1];
  // Its host agent may reach the Mac only at zot and its own ssh port.
  const profile = readFileSync(join(l.v.dir, 'sandbox-profile'), 'utf8');
  assert.deepEqual([...profile.matchAll(/remote ip "localhost:(\d+)"/g)].map(m => m[1]).sort(), ['5101', ssh].sort());
  // Master, as origin has it now, in each repository, before any test.
  for (const [name, work] of Object.entries(l.origins)) assert.equal(git(l.vmFile('repos', name), 'rev-parse', 'HEAD'), git(work, 'rev-parse', 'HEAD'), name);
  // Each test through run-test.sh, in its repository, the forge tokens on its stdin, never on a command line.
  assert.deepEqual(readFileSync(l.vmFile('runner-saw'), 'utf8').trim().split('\n'),
    ['harness', 'example-corpus', 'example-corpus'].map(n => `gho_GH glpat-GL ${realpathSync(l.vmFile('repos', n))}`));
  assert.ok(!JSON.stringify(calls).includes('gho_GH') && !JSON.stringify(calls).includes('glpat-GL'));
  // Read again, and so refreshed, for each test: glab's token expires within hours.
  assert.equal(readFileSync(join(l.v.dir, 'glab.log'), 'utf8').split('\n').filter(c => c.startsWith('auth status')).length, 1 + 3);
  // The report: a row per test, then a row per repository.
  assert.match(report, /^\| harness \| unit \| `echo "ran in \$PWD"; echo "# pass 3"; echo "# fail 0"` \| \d+s \| passed \| # pass 3; # fail 0 \|$/m);
  assert.match(report, /^\| example-ci \| — \| — \| — \| no automated tests: its CI runs only lint \| \|$/m);
  assert.match(report, /^\| example-corpus \| go \| `echo "FAIL x"; exit 1` \| \d+s \| FAILED \(exit 1\) \| \|$/m);
  assert.match(report, /^\| example-corpus \| db \| `exit 2` \| \d+s \| pre-existing failure \(exit 2\): fails on master too: https:\/\/gitlab\.com\/g\/example-corpus\/-\/jobs\/1 \| \|$/m);
  assert.match(report, /^\| harness \| \d+s \| 1 \| 0 \| 0 \|$/m);
  assert.match(report, /^\| example-ci \| — \| 0 \| 0 \| 0 \|$/m);
  assert.match(report, /^\| example-corpus \| \d+s \| 0 \| 1 \| 1 \|$/m);
  // Every test's output in the log.
  const log = readFileSync(l.at('projects', 'p', 'golden-image-tests.log'), 'utf8');
  assert.match(log, /== harness unit[\s\S]*ran in .*\/repos\/harness[\s\S]*== example-corpus go[\s\S]*FAIL x/);
  // After each test, its exit code and duration, so the log can be audited alone.
  assert.match(log, /== harness unit: [^\n]*\n(?:(?!== )[^\n]*\n)*== exit 0 \d+s: harness unit\n== example-corpus go: [^\n]*\n(?:(?!== )[^\n]*\n)*== exit 1 \d+s: example-corpus go\n== example-corpus db: exit 2\n== exit 2 \d+s: example-corpus db\n$/);
  // The VM is gone.
  assert.ok(calls.some(c => c.argv?.join(' ') === `delete -f ${vm}`));
  assert.ok(!existsSync(join(l.v.instances, vm)));
});

test('vm:test-repos p <repository> runs only that one; without run-test.sh each command runs with bash; all passing exits 0', async () => {
  const l = lima({ runner: false });
  const { stdout } = await l.cli('harness');
  assert.match(stdout, /^\| harness \| unit \| .* \| passed \| # pass 3; # fail 0 \|$/m);
  assert.doesNotMatch(stdout, /example/);
  assert.ok(!existsSync(l.vmFile('runner-saw')));
  await assert.rejects(l.cli('nope'), /p has no repository nope/);
});

test('vm:test-repos fails before cloning when tests.json leaves a repository out or there is no golden image, and deletes the VM when a later step fails', async () => {
  const l = lima();
  const file = l.at('projects', 'p', 'golden-image', 'tests.json');
  writeFileSync(file, JSON.stringify({ repositories: { harness: TESTS.repositories.harness } }));
  await assert.rejects(l.cli(), /tests\.json lists no tests for example-ci, example-corpus: give each its "tests", or "no-tests" and why/);
  writeFileSync(file, JSON.stringify(TESTS));
  rmSync(join(l.v.instances, 'golden-p'), { recursive: true });
  await assert.rejects(l.cli(), /no golden image golden-p: build it with vm:build-golden p/);
  assert.ok(!l.v.calls().some(c => c.argv?.[0] === 'clone'));
  l.v.instance('golden-p');
  rmSync(l.vmFile('repos', 'example-ci'), { recursive: true });
  await assert.rejects(l.cli(), /\/repos\/example-ci is missing in test-p-\d+/);
  const vm = l.v.calls().find(c => c.argv?.[0] === 'clone').argv[3];
  assert.ok(!existsSync(join(l.v.instances, vm)));
});

