// project:add-repository (ASS-121) — Blocked's repair for a ticket blocked
// because its work needs a repository the project does not list: the harness
// checks, read-only (glab, gh), that it can access it; then it is added to
// project.json in the entry shape the others have, with the forge's one-line
// description, and downloaded into the variation's VM when its Setup is
// complete (vm:create clones what the VM lacks; a VM not set up yet gets it
// when Setup runs again). One it cannot access is not added: exit 3, why as
// ai-feedback for Blocked for Human. None named, or one already listed: exit
// 2, nothing added. Nothing is ever removed. glab and gh are
// test/support/fake-forge.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fixture, run, AGENT } from './harness-fixture.js';
import { fakeForge } from '../support/fake-forge.js';
import { edit, lima, git } from './vm-fixture.js';

const exitOf = promise => promise.then(() => 0, e => e.code);
const LISTED = { url: 'https://gitlab.com/g/example-corpus', description: 'c', status: 'Active', 'work-space': { branch: 'master' }, 'dev-container': {} };

// The fixture's project p listing one repository, glab and gh fakes on PATH.
function blocked() {
  const f = fixture(), forge = fakeForge();
  const file = join(f.dir, 'projects', 'p', 'project.json');
  edit(file, p => { p.repositories = [LISTED]; });
  const env = { ...f.env, PATH: forge.path };
  const add = (...args) => run(AGENT, ['project:add-repository', ...args], { env });
  return { ...f, forge, add, project: () => JSON.parse(readFileSync(file, 'utf8')), raw: () => readFileSync(file, 'utf8') };
}

test('AC2: a GitLab repository the harness can access is added to project.json in the existing entry shape, its description the forge\'s first line, its branch the forge\'s default', async () => {
  const f = blocked();
  f.forge.route('glab', /^repo view https:\/\/gitlab\.com\/g\/legal-search --output json$/, { out: { description: 'Legal search service.\nMore detail here.', default_branch: 'main' } });
  const out = JSON.parse((await f.add('p', 'ABC-3', 'A', 'https://gitlab.com/g/legal-search')).stdout);
  assert.deepEqual(out, { repository: 'https://gitlab.com/g/legal-search', added: true, downloaded: false });
  assert.deepEqual(f.project().repositories, [LISTED, {
    url: 'https://gitlab.com/g/legal-search', description: 'Legal search service.', status: 'Active', 'ai-feedback-short': null, 'ai-feedback-long': null,
    'work-space': { 'server-name': null, branch: 'main', folder: null },
    'dev-container': { status: 'Stable', 'needs-rebuilt': false, 'server-name': null, 'base-image': null },
  }]);
  assert.deepEqual(f.forge.log('gh'), [], 'GitLab is asked with glab');
});

test('AC2: a GitHub repository is asked of gh; a description-less one is described by its name', async () => {
  const f = blocked();
  f.forge.route('gh', /^repo view https:\/\/github\.com\/o\/tools --json description,defaultBranchRef/, { out: { description: '', default_branch: 'master' } });
  await f.add('p', 'ABC-3', 'A', 'https://github.com/o/tools.git/');
  const added = f.project().repositories.at(-1);
  assert.deepEqual([added.url, added.description, added['work-space'].branch], ['https://github.com/o/tools.git', 'tools', 'master']);
  assert.deepEqual(f.forge.log('glab'), []);
});

test('AC3: a repository the harness cannot access is not added — exit 3, the repository and why given as ai-feedback for Blocked for Human', async () => {
  const f = blocked();
  f.forge.route('glab', /^repo view /, { out: 'ERROR: 404 Project Not Found', exit: 1 });
  const before = f.raw();
  const e = await f.add('p', 'ABC-3', 'A', 'https://gitlab.com/secret/vault').then(() => null, e => e);
  assert.equal(e?.code, 3);
  const why = JSON.parse(e.stdout);
  assert.equal(why['ai-feedback-short'], 'Needs https://gitlab.com/secret/vault, which the harness cannot access');
  assert.match(why['ai-feedback-long'], /https:\/\/gitlab\.com\/secret\/vault.*cannot access it: glab repo view said: ERROR: 404 Project Not Found/);
  assert.equal(f.raw(), before, 'project.json untouched');
});

test('AC3: a url on no forge the harness checks is not added either (exit 3)', async () => {
  const f = blocked();
  const before = f.raw();
  assert.equal(await exitOf(f.add('p', 'ABC-3', 'A', 'git@gitlab.com:g/x.git')), 3);
  assert.equal(f.raw(), before);
  assert.deepEqual([f.forge.log('glab').filter(l => l !== 'auth status'), f.forge.log('gh')], [[], []]);
});

test('AC4: none named, or one the project already lists, adds nothing (exit 2) and asks no forge; nothing is removed', async () => {
  const f = blocked();
  const before = f.raw();
  for (const url of ['-', 'https://GitLab.com/g/example-corpus.git']) assert.equal(await exitOf(f.add('p', 'ABC-3', 'A', url)), 2, url);
  assert.equal(f.raw(), before);
  assert.deepEqual([f.forge.log('glab'), f.forge.log('gh')], [[], []]);
});

test('AC2: with the variation\'s Setup complete it is downloaded into its VM at once (vm:create), the others untouched; a failed download leaves it added, exit 1 naming why', async () => {
  const l = lima(), forge = fakeForge();
  l.mount();
  await l.cli('vm:create', 'p', 'ABC-3', 'A');
  await l.cli('vm:mark-setup-complete', 'p', 'ABC-3', 'A');
  forge.route('glab', /^repo view https:\/\/gitlab\.com\/g\/legal-search /, { out: { description: 'Legal search service.', default_branch: 'main' } });
  forge.route('glab', /^repo view https:\/\/gitlab\.com\/g\/gone /, { out: { description: 'Gone.', default_branch: 'main' } });
  const work = mkdtempSync(join(tmpdir(), 'origin-'));
  execFileSync('git', ['init', '-q', '--initial-branch=main', work]);
  git(work, 'config', 'user.email', 't@example.com'); git(work, 'config', 'user.name', 'T'); git(work, 'commit', '-q', '--allow-empty', '-m', 'one');
  // The forge, as the VM's login reaches it, stood in for by the local origin.
  const env = { ...l.env, PATH: `${forge.path.split(':')[0]}:${l.env.PATH}`, GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: `url.${work}.insteadOf`, GIT_CONFIG_VALUE_0: 'https://gitlab.com/g/legal-search',
    GIT_CONFIG_KEY_1: `url.${work}-missing.insteadOf`, GIT_CONFIG_VALUE_1: 'https://gitlab.com/g/gone' };   // never the network
  const add = url => run(AGENT, ['project:add-repository', 'p', 'ABC-3', 'A', url], { env });
  assert.deepEqual(JSON.parse((await add('https://gitlab.com/g/legal-search')).stdout), { repository: 'https://gitlab.com/g/legal-search', added: true, downloaded: true });
  assert.equal(git(l.vmFile('repos', 'legal-search'), 'rev-parse', 'HEAD'), git(work, 'rev-parse', 'HEAD'));
  const e = await add('https://gitlab.com/g/gone').then(() => null, e => e);
  assert.equal(e?.code, 1);
  assert.match(JSON.parse(e.stdout)['ai-feedback-long'], /was added to p's project\.json, but downloading it into ABC-3 A's VM failed: .*could not clone https:\/\/gitlab\.com\/g\/gone/);
  const urls = JSON.parse(readFileSync(join(l.f.dir, 'projects', 'p', 'project.json'), 'utf8')).repositories.map(r => r.url);
  assert.deepEqual(urls, ['https://github.com/o/harness', 'https://gitlab.com/g/example-corpus.git', 'https://gitlab.com/g/legal-search', 'https://gitlab.com/g/gone']);
});

// ASS-160: a repository another project lists is that project's, never copied
// into this one (example work stays in example): refused deterministically,
// before any forge is asked, naming the project.
test('ASS-160 AC1/AC2: a repository another project\'s project.json lists is refused, changing nothing (exit 4) — the feedback names that project\'s access, not a missing repository', async () => {
  const f = blocked();
  edit(join(f.dir, 'projects', 'q', 'project.json'), q => { q.repositories = [{ url: 'https://gitlab.com/example-group/opinions.git' }]; });
  const before = f.raw();
  const e = await f.add('p', 'ABC-3', 'A', 'https://GitLab.com/example-group/opinions/').then(() => null, e => e);
  assert.equal(e?.code, 4);
  const why = JSON.parse(e.stdout);
  assert.equal(why['ai-feedback-short'], 'Needs q\'s access: https://GitLab.com/example-group/opinions is q\'s repository');
  assert.match(why['ai-feedback-long'], /ABC-3 needs https:\/\/GitLab\.com\/example-group\/opinions, a repository of project q, which p must not copy.*belongs in q, or must be done on the Mac/);
  assert.doesNotMatch(why['ai-feedback-long'], /cannot access|missing/);
  assert.equal(f.raw(), before, 'project.json untouched');
  assert.deepEqual([f.forge.log('glab'), f.forge.log('gh')], [[], []], 'no forge asked');
});

test('ASS-160 AC3: a repository no project lists is still added', async () => {
  const f = blocked();
  edit(join(f.dir, 'projects', 'q', 'project.json'), q => { q.repositories = [{ url: 'https://gitlab.com/example-group/opinions.git' }]; });
  f.forge.route('glab', /^repo view https:\/\/gitlab\.com\/g\/legal-search /, { out: { description: 'Legal search.', default_branch: 'main' } });
  assert.equal(JSON.parse((await f.add('p', 'ABC-3', 'A', 'https://gitlab.com/g/legal-search')).stdout).added, true);
  assert.equal(f.project().repositories.at(-1).url, 'https://gitlab.com/g/legal-search');
});
