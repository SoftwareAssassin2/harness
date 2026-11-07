// npm-registry-login — gets pnpm a working token for the GitLab npm registries
// a project's workspace .npmrc names. pnpm, curl and open are fakes on PATH:
// curl accepts only the token "good", pnpm logs what it is asked to store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from '../agent-cli/harness-fixture.js';

const HARNESS = join(import.meta.dirname, '..', '..', 'harness.sh');
const REGISTRY = 'https://gitlab.com/api/v4/projects/123/packages/npm/';
const KEY = '//gitlab.com/api/v4/projects/123/packages/npm/:_authToken';

function setup({ stored = 'undefined' } = {}) {
  const f = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'login-'));
  const ws = join(dir, 'workspace'), bin = join(dir, 'bin');
  mkdirSync(ws); mkdirSync(bin);
  execFileSync('git', ['init', '--quiet', ws]);
  writeFileSync(join(ws, '.npmrc'), `# comment\npublic-hoist-pattern[]=*x*\n@acme:registry=${REGISTRY}\n`);
  const file = join(f.dir, 'projects', 'p', 'project.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), 'local-environments': [{ name: 'local-pc', type: 'local-pc', folder: ws }] }));
  const log = join(dir, 'pnpm.log');
  writeFileSync(join(bin, 'pnpm'), `#!/usr/bin/env bash\nif [[ "$1 $2" == "config get" ]]; then echo '${stored}'; else printf '%s\\n' "$*" >> '${log}'; fi\n`);
  // curl reads its header from a -K config on stdin; 200 only for the token "good" against the project's API.
  writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash\ncfg="$(cat)"; url="\${@: -1}"\n[[ "$cfg" == *'PRIVATE-TOKEN: good"'* && "$url" == https://gitlab.com/api/v4/projects/123 ]] && echo 200 || echo 401\n`);
  writeFileSync(join(bin, 'open'), '#!/usr/bin/env bash\n');
  for (const b of ['pnpm', 'curl', 'open']) chmodSync(join(bin, b), 0o755);
  const login = input => spawnSync(HARNESS, ['npm-registry-login', 'p'], { input, encoding: 'utf8', env: { ...f.env, PATH: `${bin}:${process.env.PATH}` } });
  return { login, stored: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []) };
}

test('npm-registry-login stores a token GitLab accepts for each registry the workspace .npmrc names', () => {
  const s = setup();
  const r = s.login('bad\ngood\n');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /rejected/);
  assert.deepEqual(s.stored(), [`config set --location=user ${KEY} good`]);
});

test('npm-registry-login keeps a token pnpm already holds when GitLab still accepts it, asking for nothing', () => {
  const s = setup({ stored: 'good' });
  const r = s.login('');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /still works/);
  assert.deepEqual(s.stored(), []);
});

test('npm-registry-login gives up after three rejected tokens, storing none', () => {
  const s = setup({ stored: 'expired' });
  const r = s.login('a\nb\nc\ngood\n');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /three rejected/);
  assert.deepEqual(s.stored(), []);
});
