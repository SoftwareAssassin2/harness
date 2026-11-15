// A project on GCP workstations for the tests (ASS-435): wsFixture({ mode,
// ids, f }) — the agent-cli fixture `f` (harness-fixture.js; a control
// fixture's will do) with project p in dev-environments `mode` on the running
// fake workstations `ids` (test/support/fake-workstation.js), two
// repositories (local git origins, harness on main and example-corpus on
// master), its forwarder on 7787 (forwarder: another port), a claude
// credential and a git identity declared (the keychain a fake `security`),
// and ABC-3's ticket folder holding plan.md. Returns { f, w, env, cli, result,
// entry(id), variation(name), folder(name, id), ids, at, tokens() };
// closeAll() closes every connection the tests opened.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, AGENT } from './harness-fixture.js';
import { fakeWorkstation } from '../support/fake-workstation.js';

const run = promisify(execFile);
export const ID = 'ada-dev';
const opened = [];
export async function closeAll() { for (const s of opened.splice(0)) for (const id of s.ids) await s.cli('workstation:disconnect', 'p', id).catch(() => {}); }

export const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };

export function wsFixture({ mode = 'workstation', ids = [ID], f = fixture(), forwarder = 7787 } = {}) {
  const w = fakeWorkstation(f.env);
  const at = (...rest) => join(f.dir, ...rest);
  const origins = {};
  for (const [name, branch] of [['harness', 'main'], ['example-corpus', 'master']]) {
    const work = join(mkdtempSync(join(tmpdir(), 'origin-')), name);
    execFileSync('git', ['init', '-q', `--initial-branch=${branch}`, work]);
    git(work, 'config', 'user.email', 't@example.com'); git(work, 'config', 'user.name', 'T');
    writeFileSync(join(work, 'README.md'), 'one\n'); git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'one');
    origins[name] = work;
  }
  edit(at('projects', 'p', 'project.json'), p => {
    p.repositories = [{ url: origins.harness, description: 'h' }, { url: origins["example-corpus"], description: "c" }];
    p['dev-environments'] = { mode, workstations: ids.map(id => ({ id, 'gcp-project': 'example-gcp-project', region: 'us-central1', cluster: 'example-workstations', config: 'example-config' })) };
  });
  edit(at('harness.json'), h => { h['forwarder-port'] = forwarder; });
  for (const id of ids) w.workstation(id, 'STATE_RUNNING');
  const home = mkdtempSync(join(tmpdir(), 'mac-home-'));
  mkdirSync(join(home, '.harness'), { recursive: true });
  writeFileSync(join(home, '.harness', 'vm-credentials.json'), JSON.stringify({ p: { claude: { 'keychain-service': 'Claude Token (Test)' }, git: { 'user-name': 'Ada', 'user-email': 'ada@example.com' } } }));
  writeFileSync(join(w.bin, 'security'), '#!/bin/bash\necho sk-ant-oat01-TEST\n', { mode: 0o755 });
  const env = { ...w.env, HOME: home };
  const cli = (...args) => run(AGENT, args, { env });
  const result = (...args) => cli(...args).then(r => ({ code: 0, out: r.stdout, err: r.stderr }), e => ({ code: e.code, out: e.stdout, err: e.stderr }));
  mkdirSync(at('projects', 'p', 'work', 'ABC-3'), { recursive: true });
  writeFileSync(at('projects', 'p', 'work', 'ABC-3', 'plan.md'), 'the plan\n');
  const entry = id => JSON.parse(readFileSync(at('projects', 'p', 'workstations.json'), 'utf8'))[id ?? ID];
  const variation = name => f.sprint().features[0].variations.find(v => v.name === name);
  const folder = (name, id = ID) => join(w.home(id), 'harness', `ABC-3-${name}`);
  const s = { f, w, env, cli, result, entry, variation, folder, ids, at, tokens: () => JSON.parse(readFileSync(join(w.harnessHome, 'vm-tokens.json'), 'utf8')) };
  opened.push(s);
  return s;
}

