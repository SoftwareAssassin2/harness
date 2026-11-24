// ASS-551 AC1, AC2: on a substrate run target the Setup group's commands and Add the Missing Repository work on the
// variation's own Substrate sandbox, with the fake Substrate client (sandbox-fixture.js): vm:create makes it
// (substrate:sandbox-up) and clones in what its image lacks through the Mac; vm:mark-setup-complete writes the marker in
// it; vm:setup-complete reads it back — no VM anywhere; project:add-repository's repository appears in its /repos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { edit, git } from './workstation-fixture.js';
import { sandboxed } from './sandbox-fixture.js';
import { fakeForge } from '../support/fake-forge.js';

// onSubstrate() — sandboxed()'s project p on local-substrate alone (as the live Mac projects are, ASS-543), a claude on
// the PATH the sandbox's commands see, and every call made as control makes a substrate step's (HARNESS_RUN_TARGET).
async function onSubstrate({ lacking = [] } = {}) {
  const t = await sandboxed();
  edit(t.s.at('projects', 'p', 'project.json'), p => {
    delete p['dev-environments'].mode;
    p['dev-environments']['run-targets'] = ['local-substrate'];
  });
  for (const name of lacking) rmSync(join(t.image, 'repos', name), { recursive: true, force: true });   // an image older than the repository
  const bin = mkdtempSync(join(tmpdir(), 'claude-bin-'));
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho claude\n'); chmodSync(join(bin, 'claude'), 0o755);
  Object.assign(t.s.env, { PATH: `${bin}:${t.s.env.PATH}`, HARNESS_RUN_TARGET: 'local-substrate', LIMACTL_LOG: join(bin, 'limactl.log') });
  return t;
}

test('ASS-551 AC1: a new ticket on substrate targets alone gets through Setup — Check Setup Complete says no, Create VM makes its sandbox, Mark Setup Complete writes the marker there, and Check Setup Complete then says yes; no VM is made', async () => {
  const t = await onSubstrate();
  assert.equal((await t.call('vm:setup-complete', 'p', 'ABC-3', 'A')).code, 1, 'a new ticket: not set up');
  const made = await t.call('vm:create', 'p', 'ABC-3', 'A');
  assert.equal(made.code, 0, made.err);
  assert.deepEqual(made.json, { name: 'substrate:p:mac:abc-3-a', machine: 'substrate:p:mac:abc-3-a', ip: null, created: true, sandbox: true });
  assert.equal(t.state('abc-3-a'), 'ACTOR_STATE_RUNNING');
  const v = t.s.variation('A');
  assert.deepEqual([v.sandbox.name, v.sandbox.machine, v.sandbox.state], ['abc-3-a', 'mac', 'running']);
  assert.equal(v.vm?.name ?? null, null, 'no VM recorded');
  // Its repositories' hooks refuse a commit on the default branch, as a VM's.
  assert.ok(existsSync(join(t.root('abc-3-a'), 'repos', 'harness', '.git', 'harness-hooks', 'pre-commit')));
  assert.match(git(join(t.root('abc-3-a'), 'repos', 'harness'), 'config', 'core.hooksPath'), /harness-hooks$/);
  const marked = await t.call('vm:mark-setup-complete', 'p', 'ABC-3', 'A');
  assert.equal(marked.code, 0, marked.err);
  assert.ok(existsSync(join(t.root('abc-3-a'), 'repos', '.setup-complete')), 'the marker is in the sandbox');
  assert.equal((await t.call('vm:setup-complete', 'p', 'ABC-3', 'A')).code, 0, 'set up');
  // Again (Setup entered once more): idempotent, the same sandbox resumed or kept.
  const again = await t.call('vm:create', 'p', 'ABC-3', 'A');
  assert.equal(again.code, 0, again.err);
  assert.equal(again.json.created, false);
  assert.ok(!existsSync(t.s.env.LIMACTL_LOG) || !/clone/.test(execFileSync('cat', [t.s.env.LIMACTL_LOG], { encoding: 'utf8' })), 'no VM cloned');
});

test('ASS-551 AC1: Mark Setup Complete in a sandbox proves it can run an agent — claude, and its forwarder\'s URL and token — and writes no marker without them', async () => {
  const t = await onSubstrate();
  assert.equal((await t.call('vm:create', 'p', 'ABC-3', 'A')).code, 0);
  rmSync(join(t.root('abc-3-a'), 'run', 'harness', 'agent-token'));
  const r = await t.call('vm:mark-setup-complete', 'p', 'ABC-3', 'A');
  assert.equal(r.code, 1);
  assert.match(r.err, /cannot run an agent: missing \/run\/harness\/agent-token/);
  assert.ok(!existsSync(join(t.root('abc-3-a'), 'repos', '.setup-complete')));
});

test('ASS-551 AC1, AC2: a repository the sandbox image predates is cloned into its /repos through the Mac by Create VM — on its default branch, origin the real url', async () => {
  const t = await onSubstrate({ lacking: ['example-corpus'] });
  const made = await t.call('vm:create', 'p', 'ABC-3', 'A');
  assert.equal(made.code, 0, made.err);
  assert.match(made.err, /example-corpus cloned into substrate:p:mac:abc-3-a's \/repos through the Mac/);
  const repo = join(t.root('abc-3-a'), 'repos', 'example-corpus');
  assert.equal(git(repo, 'remote', 'get-url', 'origin'), t.s.origins['example-corpus']);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), execFileSync('git', ['--git-dir', t.s.origins['example-corpus'], 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  assert.equal(git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD'), `refs/remotes/origin/${git(repo, 'symbolic-ref', '--short', 'HEAD')}`);
  assert.ok(!existsSync(join(t.root('abc-3-a'), 'repos', '.example-corpus.cloning')));
});

test('ASS-551 AC2: Add the Missing Repository on a sandbox — the repository is added to project.json and appears in the sandbox\'s /repos, cloned through the Mac', async () => {
  const t = await onSubstrate();
  assert.equal((await t.call('vm:create', 'p', 'ABC-3', 'A')).code, 0);
  assert.equal((await t.call('vm:mark-setup-complete', 'p', 'ABC-3', 'A')).code, 0);
  // The missing repository: on "GitLab" (the forge fake answers for it), its https url served by a local bare repository.
  const bare = join(mkdtempSync(join(tmpdir(), 'forge-')), 'legal-search.git');
  const work = mkdtempSync(join(tmpdir(), 'legal-'));
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  git(work, 'config', 'user.email', 't@example.com'); git(work, 'config', 'user.name', 'T');
  writeFileSync(join(work, 'README.md'), 'legal search\n'); git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'first');
  execFileSync('git', ['clone', '-q', '--bare', work, bare]);
  const gitconfig = join(mkdtempSync(join(tmpdir(), 'gitconfig-')), 'config');
  writeFileSync(gitconfig, `[url "${bare}"]\n\tinsteadOf = https://gitlab.com/g/legal-search\n`);
  const forge = fakeForge();
  forge.route('glab', /^repo view https:\/\/gitlab\.com\/g\/legal-search --output json$/, { out: { description: 'Legal search.', default_branch: 'main' } });
  Object.assign(t.s.env, { PATH: `${forge.path.split(':')[0]}:${t.s.env.PATH}`, GIT_CONFIG_GLOBAL: gitconfig });
  const r = await t.call('project:add-repository', 'p', 'ABC-3', 'A', 'https://gitlab.com/g/legal-search');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json, { repository: 'https://gitlab.com/g/legal-search', added: true, downloaded: true });
  const repo = join(t.root('abc-3-a'), 'repos', 'legal-search');
  assert.equal(execFileSync('cat', [join(repo, 'README.md')], { encoding: 'utf8' }), 'legal search\n');
  assert.equal(git(repo, 'remote', 'get-url', 'origin'), 'https://gitlab.com/g/legal-search');
  assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD'), 'main');
  mkdirSync(join(t.root('abc-3-a'), 'tmp'), { recursive: true });
});
