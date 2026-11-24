// ASS-558: agent.sh ticket:refresh-commits — a ticket variation's commits gathered from a fake forge (glab on PATH)
// and a real git clone on "the Mac" (the project's local-pc folder), written whole to work/<KEY>/commits-<var>.json;
// limactl, ssh, gcloud and kubectl are fakes that record any call, and none is made (AC3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeForge } from '../support/fake-forge.js';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const APP = 'https://gitlab.example.com/g/app';
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.com', GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.com' } }).trim();
const commit = (dir, subject, date) => {
  writeFileSync(join(dir, `${subject.replace(/\W+/g, '-')}.txt`), subject);
  git(dir, 'add', '.');
  execFileSync('git', ['-C', dir, 'commit', '--quiet', '-m', subject], { env: { ...process.env, GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.com', GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.com', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  return git(dir, 'rev-parse', 'HEAD');
};

// Project p (repository app) with ABC-7 variation A in the active sprint, its merge request !5 open; the workspace a
// clone of a bare origin: main with a merged ABC-7 commit, change/ABC-7-1 pushed with one commit and one more only local.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'commits-'));
  const origin = join(dir, 'origin.git'), ws = join(dir, 'ws');
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', origin]);
  execFileSync('git', ['clone', '--quiet', origin, ws]);
  git(ws, 'checkout', '--quiet', '-b', 'main');
  commit(ws, 'Initial', '2026-11-01T09:00:00Z');
  const merged = commit(ws, 'ABC-7: merged straight to main', '2026-11-03T09:00:00Z');
  commit(ws, 'ABC-8: another ticket', '2026-11-03T10:00:00Z');
  git(ws, 'push', '--quiet', 'origin', 'main');
  git(ws, 'remote', 'set-head', 'origin', 'main');
  git(ws, 'checkout', '--quiet', '-b', 'change/ABC-7-1');
  const pushed = commit(ws, 'ABC-7: pushed to its branch', '2026-11-04T09:00:00Z');
  git(ws, 'push', '--quiet', 'origin', 'change/ABC-7-1');
  const local = commit(ws, 'ABC-7: not pushed yet', '2026-11-05T09:00:00Z');
  git(ws, 'checkout', '--quiet', 'main');
  git(ws, 'remote', 'set-url', 'origin', `${APP}.git`);   // as the project names it; its refs stay as last fetched

  const projects = join(dir, 'projects'), p = join(projects, 'p');
  mkdirSync(join(p, 'sprints', 'sprint-3'), { recursive: true });
  writeFileSync(join(p, 'project.json'), JSON.stringify({ name: 'P', repositories: [{ url: APP, status: 'Active' }], 'local-environments': [{ name: 'ws', type: 'local-pc', folder: ws }] }));
  writeFileSync(join(p, 'sprints.json'), JSON.stringify({ list: [{ number: 3, 'is-active': true }] }));
  writeFileSync(join(p, 'sprints', 'sprint-3', 'sprint.json'), JSON.stringify({ number: 3, bugs: [], spikes: [], features: [{ key: 'ABC-7', title: 'T', variations: [{
    name: 'A', build: { branch: 'change/ABC-7-1' }, 'state-changes': [{ 'state-engine': 'e', 'from-state': 'committed', 'to-state': 'plan', timestamp: '2026-11-02T09:00:00Z' }],
    'merge-request': [{ id: 1, key: '!5', url: `${APP}/-/merge_requests/5`, status: 'Open', 'build-status': 'Running', repository: `${APP}.git`, branch: 'change/ABC-7-9' }],
  }] }] }));

  const forge = fakeForge();
  forge.route('glab', /^api projects\/g%2Fapp --hostname gitlab.example.com$/, { out: { default_branch: 'main' } });
  forge.route('glab', /^api projects\/g%2Fapp\/repository\/branches/, { out: [{ name: 'change/ABC-7-1' }, { name: 'change/ABC-7-9' }] });
  forge.route('glab', /^api projects\/g%2Fapp\/repository\/compare\?from=main&to=change%2FABC-7-1/, { out: { commits: [{ id: pushed, title: 'ABC-7: pushed to its branch', author_name: 'Ada', authored_date: '2026-11-04T09:00:00Z' }] } });
  forge.route('glab', /^api projects\/g%2Fapp\/repository\/commits\?since=2026-11-01T09%3A00%3A00Z/, { out: [{ id: merged, title: 'ABC-7: merged straight to main', message: 'ABC-7: merged straight to main', author_name: 'Ada', authored_date: '2026-11-03T09:00:00Z' }] });
  forge.route('glab', /^api projects\/g%2Fapp\/merge_requests\/5\/commits/, { out: [{ id: 'f00dfeed', title: 'ABC-7: in the open MR', author_name: 'Bo', authored_date: '2026-11-06T09:00:00Z' }] });

  // The machine commands, recording any call: none may be made.
  const bin = forge.path.split(':')[0], machineLog = join(dir, 'machine.log');
  for (const tool of ['limactl', 'ssh', 'gcloud', 'kubectl']) {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> "${machineLog}"\nexit 1\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  const env = { ...process.env, PROJECTS_DIR: projects, PATH: forge.path };
  return { dir, p, ws, env, forge, machineLog, shas: { merged, pushed, local } };
}

test('ASS-558 AC1/AC2/AC3: ticket:refresh-commits writes the variation\'s commits — local only, pushed, in an open MR, merged — once each, with when it ran; no machine is reached', async () => {
  const f = fixture();
  const { stdout } = await run(AGENT, ['ticket:refresh-commits', 'p', 'abc-7', 'A'], { env: f.env });
  const file = join(f.p, 'work', 'ABC-7', 'commits-A.json');
  const list = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(JSON.parse(stdout), list);
  assert.equal(list.key, 'ABC-7');
  assert.equal(list.variation, 'A');
  assert.match(list['refreshed-at'], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal(list.since, '2026-11-01T09:00:00Z');   // a day before its first move
  assert.deepEqual(list.commits.map(c => [c.subject, c.state, c.repository, c.branch, c.mr]), [
    ['ABC-7: in the open MR', 'open-mr', 'app', 'change/ABC-7-9', '!5'],
    ['ABC-7: not pushed yet', 'local', 'app', 'change/ABC-7-1', null],
    ['ABC-7: pushed to its branch', 'pushed', 'app', 'change/ABC-7-1', null],
    ['ABC-7: merged straight to main', 'merged', 'app', 'main', null],
  ]);
  assert.equal(list.commits[1].sha, f.shas.local);
  assert.equal(list.commits[2].sha, f.shas.pushed);   // seen by the forge and the clone: once
  assert.equal(list.commits[3].sha, f.shas.merged);   // likewise
  assert.equal(list.commits[1].author, 'Ada');
  assert.deepEqual(list.sources.map(s => [s.source, s.repository, s.ok]), [['forge-mr', 'app', true], ['forge', 'app', true], ['clone', 'app', true]]);
  assert.ok(!existsSync(f.machineLog), existsSync(f.machineLog) ? readFileSync(f.machineLog, 'utf8') : '');
  assert.ok(f.forge.log('glab').every(l => l.startsWith('api ')), 'glab only read through its api');
  assert.deepEqual(readdirSync(join(f.p, 'work', 'ABC-7')), ['commits-A.json']);   // written whole, no temporary file left
  assert.equal(git(f.ws, 'status', '--porcelain'), '');                            // the workspace untouched
  assert.equal(git(f.ws, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
});

test('ASS-558 AC3: a forge that cannot be read is recorded and the clone still read; a bad ticket or variation fails, writing nothing', async () => {
  const f = fixture();
  f.forge.route('glab', /^api projects\/g%2Fapp --hostname/, { out: 'boom', exit: 1 });
  f.forge.route('glab', /^api projects\/g%2Fapp\/merge_requests/, { out: 'boom', exit: 1 });
  await run(AGENT, ['ticket:refresh-commits', 'p', 'ABC-7', 'A'], { env: f.env });
  const list = JSON.parse(readFileSync(join(f.p, 'work', 'ABC-7', 'commits-A.json'), 'utf8'));
  assert.deepEqual(list.sources.map(s => [s.source, s.ok]), [['forge-mr', false], ['forge', false], ['clone', true]]);
  assert.deepEqual(list.commits.map(c => [c.subject, c.state]), [
    ['ABC-7: not pushed yet', 'local'], ['ABC-7: pushed to its branch', 'pushed'], ['ABC-7: merged straight to main', 'merged'],
  ]);
  for (const args of [['p', 'ABC-99', 'A'], ['p', 'ABC-7', 'B'], ['nope', 'ABC-7', 'A'], ['p', 'ABC-7'], ['p', 'not a key', 'A']]) {
    await assert.rejects(run(AGENT, ['ticket:refresh-commits', ...args], { env: f.env }), /ticket:refresh-commits/, args.join(' '));
  }
  assert.ok(!existsSync(join(f.p, 'work', 'ABC-99')));
  assert.ok(!existsSync(join(f.p, 'work', 'ABC-7', 'commits-B.json')));
});
