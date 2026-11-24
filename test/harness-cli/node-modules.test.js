// ASS-524: the harness's first npm dependency (yaml). A fresh clone has no
// node_modules/: ensure_node_modules (src/harness-cli/node-modules.bash, run by
// the dashboard's tui.sh and install-project) runs `npm ci` only then.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const LIB = join(ROOT, 'src', 'harness-cli', 'node-modules.bash');

// A fresh clone's root (no node_modules, outside any checkout) and a fake npm
// that records its arguments and, for `ci`, installs a yaml package stub.
function clone({ npmFails = false } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'node-modules-')));
  const root = join(dir, 'harness'), bin = join(dir, 'bin');
  mkdirSync(root); mkdirSync(bin);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'harness', type: 'module', dependencies: { yaml: '2.9.1' } }));
  writeFileSync(join(bin, 'npm'), `#!/bin/bash\necho "$PWD $*" >> "${join(dir, 'npm.log')}"\n${npmFails ? 'exit 1' : `mkdir -p node_modules/yaml && echo '{"name":"yaml","type":"module","main":"index.js"}' > node_modules/yaml/package.json && echo 'export const parse = () => 1;' > node_modules/yaml/index.js`}\n`);
  chmodSync(join(bin, 'npm'), 0o755);
  const run = () => spawnSync('bash', ['-c', `source "${LIB}" && ensure_node_modules "$1"`, '-', root], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
  return { root, run, log: () => (existsSync(join(dir, 'npm.log')) ? readFileSync(join(dir, 'npm.log'), 'utf8') : '') };
}

test('ASS-524: a fresh clone without node_modules gets `npm ci` in its root, once', () => {
  const c = clone();
  const first = c.run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stderr, /npm ci/);
  assert.equal(c.log(), `${c.root} ci --no-audit --no-fund\n`);
  assert.equal(c.run().status, 0);
  assert.equal(c.log(), `${c.root} ci --no-audit --no-fund\n`);   // installed: not run again
});

test('ASS-524: npm ci failing fails ensure_node_modules, saying what to do', () => {
  const c = clone({ npmFails: true });
  const r = c.run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /npm ci failed in .*: install Node\.js and npm, then run npm ci there/);
});

test('ASS-524: the checkout itself has the pinned yaml package and its lockfile', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.dependencies.yaml, /^\d+\.\d+\.\d+$/, 'an exact version');
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/yaml'].version, pkg.dependencies.yaml);
});
